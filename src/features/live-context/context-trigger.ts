import {
	buildBlockDigestUnits,
	estimateMirrorTokens,
	type MirrorRecord,
} from "./context-format.ts";

/**
 * Turn-boundary cleanup trigger (docs/plan.md §5.2).
 *
 * The plugin, not the model, decides *when* to look at the context: a
 * deterministic signal fires once per turn boundary, and the model only
 * confirms a pre-assembled candidate. Every threshold defaults to `0`
 * (disabled), because the numbers are not calibrated on a real
 * DeepSeek-V4.1-Flash session yet; the mechanism must be shippable without
 * pretending an unmeasured default is safe. Calibrate, then set the switch.
 *
 * This module is pure: it takes records plus already-collected numbers, so the
 * Pi and DSH adapters can feed the same planner from their own hosts.
 */
export interface CleanupTriggerOptions extends CleanupCandidateOptions {
	/** Fires when usage reaches this percentage of the window. 0 disables. */
	usagePercent?: number;
	/** Fires when this many turns have completed. 0 disables. */
	completedTurns?: number;
	/** Fires when toolResult blocks hold at least this share (0..1) of editable tokens. 0 disables. */
	toolResultShare?: number;
	/** Fires when this many turns have elapsed since the last applied cleanup. 0 disables. */
	turnsSinceCleanup?: number;
}

export interface CleanupTriggerContext {
	/** Live context tokens: host-exact when available, otherwise an estimate. */
	usageTokens?: number;
	contextWindow?: number;
	/** True when `usageTokens` came from the host rather than the 3.5 chars/token estimate. */
	exactUsage?: boolean;
	/** Turns that already ended; the open turn is not counted. */
	completedTurns: number;
	/** Turn in which the last cleanup or mirror edit was applied, if any. */
	lastCleanupTurn?: number;
	/** Turn that is about to run; defaults to `completedTurns + 1`. */
	currentTurn?: number;
}

export interface CleanupCandidate {
	/** 1-based editable block ID that starts the turn. */
	start: number;
	/** 1-based editable block ID that ends the turn (inclusive). */
	end: number;
	/**
	 * Estimated tokens the range frees once the keep-rule is applied, i.e. the
	 * assistant and toolResult blocks the suggested call actually removes.
	 */
	tokens: number;
	/**
	 * Tokens after the first removed block, which lose their cached prefix and
	 * are re-priced at `1−r` when the range is applied. This is the `B` of the
	 * cost formula, not the deletion size (prefix-breakpoint note, §1).
	 */
	suffixTokens: number;
	/**
	 * `r·tokens − (1−r)·suffixTokens / paybackTurns`: what the range saves per
	 * turn, with the one-time break amortised over the remaining run. Negative
	 * candidates are never suggested.
	 */
	netTokens: number;
	/**
	 * Turns elapsed since this one settled: the newest completed turn is `1`, so
	 * the recency weight never zeroes out a recent turn's savings. Final tie-break.
	 */
	turnsOld: number;
}

export interface CleanupTriggerPlan {
	triggered: boolean;
	/** Human-readable threshold hits, one per fired signal. */
	signals: string[];
	candidates: CleanupCandidate[];
	savingsTokens: number;
}

const DEFAULT_MAX_CANDIDATES = 3;

/**
 * A candidate is a range **plus** a keep-rule. A turn starts at its user block
 * (`buildBlockDigestUnits`), so a bare range would hand the model a call that
 * deletes the human's own request. `skipRoles: ["user"]` makes the suggestion
 * safe to confirm as-is: only the assistant/toolResult noise of a settled turn
 * goes away, and the quoted savings are computed after that rule, not before.
 */
export const CANDIDATE_SKIP_ROLES = ["user"] as const;

/** `0.8` -> `80%`, `9.62` -> `9.6%`; the model sees a compact magnitude. */
export function formatPercent(value: number): string {
	const clamped = Math.max(0, value);
	return `${clamped >= 10 ? Math.round(clamped) : Math.round(clamped * 10) / 10}%`;
}

/** `6400` -> `6.4k`, `800` -> `800`; the model sees a compact magnitude. */
export function formatTokenCount(value: number): string {
	const rounded = Math.max(0, Math.round(value));
	if (rounded < 1_000) return String(rounded);
	const thousands = rounded / 1_000;
	const scaled = thousands >= 10 ? String(Math.round(thousands)) : String(Math.round(thousands * 10) / 10);
	return `${scaled}k`;
}

export interface UsageLineInput {
	tokens: number;
	contextWindow?: number;
	/** False marks the number with `~`; the estimate is not a provider tokenizer. */
	exact: boolean;
	editableBlocks: number;
	lastCleanupTurn?: number;
	/** Pi counts steps, DSH counts turns; the wording must not lie. Defaults to `turn`. */
	turnWord?: "turn" | "step";
}

/**
 * One header line for the dynamic runtime context. The host-exact value is
 * shown bare; the fallback estimate keeps `~` so a missing projection service
 * is visible rather than silently passed off as exact (P1-2).
 */
export function formatUsageLine(input: UsageLineInput): string {
	const tokens = `${input.exact ? "" : "~"}${formatTokenCount(input.tokens)}`;
	const hasWindow = input.contextWindow !== undefined && input.contextWindow > 0;
	const where = hasWindow
		? `${tokens}/${formatTokenCount(input.contextWindow as number)} tokens`
		: `${tokens} tokens (window unknown)`;
	const percent = hasWindow ? ` (${formatPercent((input.tokens / (input.contextWindow as number)) * 100)})` : "";
	const cleanup = input.lastCleanupTurn === undefined
		? "no cleanup yet"
		: `last cleanup at ${input.turnWord ?? "turn"} ${input.lastCleanupTurn}`;
	const blocks = `${input.editableBlocks} editable block${input.editableBlocks === 1 ? "" : "s"}`;
	return `Usage: ${where}${percent} · ${blocks} · ${cleanup}`;
}

function enabled(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export interface CleanupCandidateOptions {
	/** Maximum candidate ranges named at once. Defaults to 3. */
	maxCandidates?: number;
	/** Completed turns smaller than this are never suggested. Defaults to 0. */
	minSavingsTokens?: number;
	/**
	 * `r` in `cost ≈ r·L + (1−r)·B`: the cache-read price as a fraction of the
	 * full input price. Defaults to 0.02 (deepseek-flash through Pi's price
	 * table); it is a per-endpoint constant, not a universal one, so it stays
	 * configurable.
	 */
	cacheDiscount?: number;
	/**
	 * Turns the one-time break cost is amortised over: `N` in
	 * `N ≈ (1−r)·S / (r·ΔL)`. A break is only worth it if the run outlives its
	 * payback, so a shorter horizon demands a cheaper break. Defaults to 10.
	 */
	paybackTurns?: number;
}

/**
 * `r` for deepseek-flash through Pi's own cost table (2026-11-09): input
 * $0.30/M vs cacheRead $0.006/M. Endpoints differ (1/10 ~ 1/50), so it stays
 * configurable; choosing too low only makes the plugin quieter, which is the
 * safe direction.
 */
export const DEFAULT_CACHE_DISCOUNT = 0.02;

/**
 * Uncalibrated long-run assumption, in the same spirit as the trigger
 * thresholds: set `1` to price only the turn in front of you, raise it when the
 * measured run length is longer. It is a placeholder, not a measurement.
 */
export const DEFAULT_PAYBACK_TURNS = 10;

/**
 * The candidate half of a trigger, without the threshold decision. The Pi
 * adapter already knows it is under pressure (its budget nudge), so it reuses
 * the same ranking and rendering as the DSH turn-boundary trigger instead of
 * inventing a second candidate format (docs/plan.md §5.3).
 *
 * `tokens` is always what the rendered `skipRoles` call frees, never the whole
 * turn: a suggestion that quietly deletes the human's request would be safe to
 * quote and unsafe to confirm.
 */
export function assembleCleanupCandidates(
	records: readonly MirrorRecord[],
	options: CleanupCandidateOptions = {},
): { candidates: CleanupCandidate[]; savingsTokens: number } {
	const maxCandidates = Math.max(1, Math.floor(options.maxCandidates ?? DEFAULT_MAX_CANDIDATES));
	const minSavings = Math.max(0, Math.floor(options.minSavingsTokens ?? 0));
	const rawDiscount = options.cacheDiscount ?? DEFAULT_CACHE_DISCOUNT;
	// `r` is a price ratio: outside [0, 1] it is not a discount, it is a typo.
	const discount = Number.isFinite(rawDiscount) ? Math.min(1, Math.max(0, rawDiscount)) : DEFAULT_CACHE_DISCOUNT;
	const rawPayback = options.paybackTurns ?? DEFAULT_PAYBACK_TURNS;
	const paybackTurns = Number.isFinite(rawPayback) ? Math.max(1, Math.floor(rawPayback)) : DEFAULT_PAYBACK_TURNS;
	const units = buildBlockDigestUnits(records);
	const unitTokens = units.map((unit) => estimateMirrorTokens(unit.records));

	// Tokens behind the last block each range would remove: `B` in
	// `r·L + (1−r)·B`. The keep-rule leaves user blocks in place, so the break is
	// measured after the last block the call actually rewrites or drops — blocks
	// removed together with it are gone, not re-prefilled, and counting them as
	// suffix overstated the cost of every tool-heavy turn.
	const suffixWithinUnit = units.map((unit) => {
		const lastRemoved = unit.records.reduce((last, record, index) => (record.role === "user" ? last : index), -1);
		const afterBreak = lastRemoved < 0 ? unit.records.length : lastRemoved + 1;
		return estimateMirrorTokens(unit.records.slice(afterBreak));
	});
	// Running total from the end: one pass, so the ranking stays linear in turns.
	const suffixTokensAt: number[] = [];
	let laterTokens = 0;
	for (let index = units.length - 1; index >= 0; index -= 1) {
		suffixTokensAt[index] = laterTokens + (suffixWithinUnit[index] ?? 0);
		laterTokens += unitTokens[index] ?? 0;
	}

	const completed = units
		.map((unit, index) => ({ unit, index }))
		.filter(({ unit }) => !unit.open);
	const candidates = completed
		.map(({ unit, index }, position) => ({
			start: unit.start,
			end: unit.end,
			// The keep-rule is part of the suggestion, so the figure the model reads
			// must already exclude what the rule preserves. A turn that is nothing
			// but a user message therefore scores 0 and is dropped below.
			tokens: estimateMirrorTokens(unit.records.filter((record) => record.role !== "user")),
			suffixTokens: suffixTokensAt[index] ?? 0,
			// Counted from the end of the completed list, so the ranking is the
			// same whether the open turn exists or not.
			turnsOld: completed.length - position,
		}))
		.map((candidate) => ({
			...candidate,
			netTokens: Math.round(discount * candidate.tokens - ((1 - discount) * candidate.suffixTokens) / paybackTurns),
		}))
		.filter((candidate) => candidate.start > 1)
		.filter((candidate) => candidate.tokens > 0 && candidate.tokens >= minSavings)
		// A range that costs more to break than it frees is not a candidate for a
		// cheaper context; suggesting it would make the model do the wrong thing
		// confidently (prefix-breakpoint note, §7).
		.filter((candidate) => candidate.netTokens > 0)
		// Rent is paid at the discounted price, so net savings lead the ranking. A
		// big old turn only wins when its break is genuinely cheap (or `r ≈ 1`).
		.sort((a, b) => b.netTokens - a.netTokens
			|| b.tokens - a.tokens
			|| b.turnsOld - a.turnsOld)
		.slice(0, maxCandidates);
	const savingsTokens = candidates.reduce((total, candidate) => total + candidate.tokens, 0);
	return { candidates, savingsTokens };
}

/**
 * Decide whether this turn boundary fires, and if so assemble the candidates.
 * Candidates are completed turns only: the open turn may still settle tool
 * pairs, and block 1 is load-bearing on both edit paths (P1-4), so the first
 * unit is never suggested.
 */
export function planCleanupTrigger(
	records: readonly MirrorRecord[],
	context: CleanupTriggerContext,
	options: CleanupTriggerOptions = {},
): CleanupTriggerPlan {
	const signals: string[] = [];
	const usageThreshold = enabled(options.usagePercent);
	if (usageThreshold > 0
		&& context.usageTokens !== undefined
		&& context.contextWindow !== undefined
		&& context.contextWindow > 0) {
		const usagePercent = (context.usageTokens / context.contextWindow) * 100;
		if (usagePercent >= usageThreshold) {
			signals.push(`${context.exactUsage ? "" : "~"}usage ${formatPercent(usagePercent)} ≥ ${formatPercent(usageThreshold)}`);
		}
	}

	const turnThreshold = enabled(options.completedTurns);
	if (turnThreshold > 0 && context.completedTurns >= turnThreshold) {
		signals.push(`${context.completedTurns} completed turns ≥ ${turnThreshold}`);
	}

	const shareThreshold = enabled(options.toolResultShare);
	if (shareThreshold > 0) {
		const editable = records.filter((record) => !record.protected);
		const totalTokens = estimateMirrorTokens(editable);
		const toolTokens = estimateMirrorTokens(editable.filter((record) => record.role === "toolResult"));
		const share = totalTokens > 0 ? toolTokens / totalTokens : 0;
		if (totalTokens > 0 && share >= shareThreshold) {
			signals.push(`toolResult ${formatPercent(share * 100)} ≥ ${formatPercent(shareThreshold * 100)}`);
		}
	}

	const sinceThreshold = enabled(options.turnsSinceCleanup);
	if (sinceThreshold > 0) {
		const currentTurn = context.currentTurn ?? context.completedTurns + 1;
		const lastCleanupTurn = context.lastCleanupTurn ?? 0;
		const elapsed = Math.max(0, currentTurn - lastCleanupTurn);
		if (elapsed >= sinceThreshold) {
			signals.push(`${elapsed} turns since cleanup ≥ ${sinceThreshold}`);
		}
	}

	if (signals.length === 0) return { triggered: false, signals, candidates: [], savingsTokens: 0 };
	return { triggered: true, signals, ...assembleCleanupCandidates(records, options) };
}

/**
 * The model-visible half: a ready-to-confirm `cleanup` call plus the per-range
 * reason. The answer space is a confirmation, not an open "should I clean"
 * question (docs/plan.md §5.0). Empty when nothing is worth suggesting.
 */
/** `{3,5}` -> `3-5`, `{5,5}` -> `5`; one spelling for the call and the detail line. */
function candidateRange(candidate: CleanupCandidate): string {
	return candidate.start === candidate.end ? String(candidate.start) : `${candidate.start}-${candidate.end}`;
}

export function renderCleanupCandidates(plan: CleanupTriggerPlan): string {
	if (!plan.triggered || plan.candidates.length === 0) return "";
	const ranges = plan.candidates.map((candidate) => JSON.stringify(candidateRange(candidate)));
	const skipRoles = JSON.stringify([...CANDIDATE_SKIP_ROLES]);
	const head = `Suggested cleanup (${plan.signals.join("; ")}): cleanup({ ranges: [${ranges.join(", ")}], skipRoles: ${skipRoles} }) frees ~${plan.savingsTokens} tok.`;
	const detail = `Candidates: ${plan.candidates
		.map((candidate) => `${candidateRange(candidate)} (~${candidate.tokens} tok freed, ${candidate.turnsOld} turn${candidate.turnsOld === 1 ? "" : "s"} old, ${candidate.suffixTokens} tok after the break, net ~${candidate.netTokens})`)
		.join(", ")}; block 1, user messages, and the current turn stay.`;
	return `${head}\n${detail}`;
}
