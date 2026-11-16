/**
 * Canary for automatic tool-result clearing.
 *
 * This module is the *selector* only: it decides which tool results a cleanup
 * pass would free, and never changes what the model sees. The DSH host learns
 * about a clear through a message projection, which is deliberately not part of
 * this file; a canary run must stay model-invisible so the numbers can be
 * calibrated before any content is replaced.
 *
 * Two rules nominate a block:
 *
 * - **superseded**: a re-fetchable tool result (`read` / `read_image` / `grep` /
 *   `glob` / `web_fetch`) whose target was fetched again later. Position matters
 *   more than volume — an in-place clear breaks the prefix cache from the
 *   cleared block to the tail — so every candidate carries the number of tool
 *   results that landed between the cleared call and its superseder, and
 *   nothing is cleared on position alone.
 * - **stale**: a block whose result landed at least `staleTurns` turn boundaries
 *   and/or `staleSteps` tool results ago and whose whole body is re-fetchable.
 *   Supersession only ever names output the model just asked for again; the rot
 *   worth clearing is the large result nobody came back to, and no later call
 *   marks that dead. A turn is 11–39 steps wide, so the turn clock alone cannot
 *   age anything inside one long turn; the step clock is the one that can.
 *
 * A clear replaces the *whole* model-visible block, so both rules also require
 * that re-fetchable output is nearly all of it: a PTC program that printed live
 * analysis next to one dead read must not become that read's pointer.
 */

/** Tools whose output the model can re-obtain by calling the tool again. */
export const REFETCH_TOOL_NAMES = ["read", "read_image", "grep", "glob", "web_fetch"] as const;

/** A fetch call whose output the model can re-obtain. */
export interface RefetchCall {
	/** Tool name, one of {@link REFETCH_TOOL_NAMES}. */
	readonly name: string;
	/** Parsed arguments as the provider saw them. */
	readonly args: unknown;
	/**
	 * Call whose `tool/result` text carries this output. Under the PTC executor
	 * one program call produces several sub-calls, so this is the root call that
	 * owns the model-visible block.
	 */
	readonly blockId: string;
	/** Session sequence of the call; used to address its output later. */
	readonly seq: number;
	/** Tool results that had already landed when this call occurred. */
	readonly blockAge: number;
}

interface RefetchRecord {
	readonly call: RefetchCall;
	readonly key: string;
	tokens: number;
	supersededBySeq?: number;
}

interface BlockRecord {
	/** Session seq of the `tool/result` that carries this block. */
	seq?: number;
	/** Turn the block's result landed in; the coarse clock behind the stale rule. */
	turn?: number;
	/** Tool results that had landed when this block's result arrived; the fine clock. */
	landedAt?: number;
	/** Model-visible tokens of the whole block, once its result lands. */
	tokens: number;
	/** Tokens of the re-fetchable calls whose output sits in this block. */
	refetchTokens: number;
	/** Tokens among {@link refetchTokens} that a later call has superseded. */
	supersededTokens: number;
	/** Tool results between the oldest superseded call and its superseder. */
	ageBlocks?: number;
}

/** Why a block is a candidate. */
export type ClearReason = "superseded" | "stale";

/** One block whose re-fetchable output is dead or old enough to clear. */
export interface ClearCandidate {
	readonly blockId: string;
	/** Session seq of the `tool/result` event: the surface node a projection targets. */
	readonly seq: number;
	/** Model-visible tokens the block would free. */
	readonly tokens: number;
	/** Re-fetch calls the pointer has to name: all of them for a stale block. */
	readonly calls: readonly { readonly name: string; readonly seq: number }[];
	/** Target keys of those calls; a later fetch of one is a selector miss. */
	readonly keys: readonly string[];
	/** Pointer text shown to the model instead of the cleared body. */
	readonly label: string;
	/** See {@link BlockRecord.ageBlocks}. */
	readonly ageBlocks: number;
	/** Which rule nominated this block. */
	readonly reason: ClearReason;
	/** Turn boundaries since the block landed, when both turns are known. */
	readonly ageTurns?: number;
	/** Tool results since the block landed; the age a long turn cannot express. */
	readonly ageSteps?: number;
}

/** What one selector pass found. Written to the canary log, never to context. */
export interface CanaryBatch {
	readonly candidates: readonly ClearCandidate[];
	/** Sum of {@link ClearCandidate.tokens}. */
	readonly tokens: number;
}

export interface SelectorOptions {
	/**
	 * A block counts as dead when this share of its re-fetchable output is
	 * superseded. The same share also decides whether the block is re-fetchable
	 * enough to replace: clearing rewrites the whole visible body, so a block
	 * that is mostly live output is never a candidate.
	 */
	readonly deadShare?: number;
	/**
	 * Turn boundaries after which an all-re-fetchable block is rot. `0` disables
	 * the turn clock, leaving supersession and the step clock as the triggers.
	 */
	readonly staleTurns?: number;
	/**
	 * Tool results after which an all-re-fetchable block is rot. `0` disables the
	 * step clock. Off by default: it is a second trigger, not a replacement, so
	 * an uncalibrated value must not change what an existing config clears.
	 */
	readonly staleSteps?: number;
}

export const DEFAULT_DEAD_SHARE = 0.95;
/** Calibrated with the gate: a read from three turns ago is not the hot set. */
export const DEFAULT_STALE_TURNS = 3;
/** The step clock ships off: a turn count is the only calibrated age bound. */
export const DEFAULT_STALE_STEPS = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize the arguments the provider sent. DSH stores them as the raw JSON
 * string on `tool/call` and as an object on a PTC sub-call.
 */
export function parseToolArguments(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function stringField(value: unknown, ...names: readonly string[]): string | undefined {
	if (!isRecord(value)) return undefined;
	for (const name of names) {
		const field = value[name];
		if (typeof field === "string" && field.length > 0) return field;
	}
	return undefined;
}

function integerField(value: unknown, name: string): number | undefined {
	if (!isRecord(value)) return undefined;
	const field = value[name];
	return typeof field === "number" && Number.isFinite(field) ? Math.trunc(field) : undefined;
}

/** Inclusive line window of one `read` call; open-ended when `limit` is absent. */
export interface ReadWindow {
	readonly path: string;
	readonly first: number;
	readonly last: number;
}

/** The line window a `read` call asked for, or `undefined` when the path is missing. */
export function readWindowOf(args: unknown): ReadWindow | undefined {
	const path = stringField(args, "file_path", "path");
	if (path === undefined) return undefined;
	const offset = integerField(args, "offset");
	const limit = integerField(args, "limit");
	const first = offset !== undefined && offset > 0 ? offset : 1;
	// `limit` is a maximum line count, so a missing limit means "to the end";
	// coverage then only holds when the newer read also reaches past the older
	// window's end, which keeps the check conservative.
	const last = limit !== undefined && limit > 0 ? first + limit - 1 : Number.MAX_SAFE_INTEGER;
	return { path, first, last };
}

function canonicalArguments(args: unknown): string {
	if (!isRecord(args)) return JSON.stringify(args ?? null);
	const keys = Object.keys(args).sort();
	return keys.map((key) => `${key}=${JSON.stringify(args[key])}`).join("\u0000");
}

/**
 * Stable identity of a fetch target: two calls with the same key asked for the
 * same thing. `read` is narrowed by line window in {@link supersedes}, because
 * two reads of one file at different offsets do not answer the same question.
 */
export function targetKeyOf(name: string, args: unknown): string | undefined {
	if (name === "read") {
		const window = readWindowOf(args);
		return window === undefined ? undefined : `read\u0000${window.path}`;
	}
	if (name === "read_image") {
		const path = stringField(args, "file_path", "path");
		return path === undefined ? undefined : `read_image\u0000${path}`;
	}
	if (name === "web_fetch") {
		const url = stringField(args, "url");
		return url === undefined ? undefined : `web_fetch\u0000${url}`;
	}
	if (name === "grep" || name === "glob") return `${name}\u0000${canonicalArguments(args)}`;
	return undefined;
}

/** Whether `later` answers everything `earlier` answered. */
export function supersedes(
	later: { readonly name: string; readonly args: unknown },
	earlier: { readonly name: string; readonly args: unknown },
): boolean {
	if (later.name !== earlier.name) return false;
	if (later.name !== "read") return true;
	const newer = readWindowOf(later.args);
	const older = readWindowOf(earlier.args);
	if (newer === undefined || older === undefined) return false;
	return newer.path === older.path && newer.first <= older.first && newer.last >= older.last;
}

/** Longest argument excerpt kept in a pointer, so a placeholder stays one line. */
export const LABEL_ARGUMENT_CHARS = 60;

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * One-line description of what a cleared call asked for.
 *
 * It is the model's only way back to the content, so it names the target and,
 * when the call was a `read`, the exact line window that was cleared.
 */
export function describeCall(call: { readonly name: string; readonly args: unknown }): string {
	if (call.name === "web_fetch") {
		const url = stringField(call.args, "url");
		return url === undefined ? call.name : `web_fetch ${truncate(url, 80)}`;
	}
	if (call.name === "read_image") {
		const path = stringField(call.args, "file_path", "path");
		return path === undefined ? call.name : `read image ${truncate(path, 80)}`;
	}
	if (call.name === "read") {
		const window = readWindowOf(call.args);
		if (window === undefined) return "read";
		const end = window.last !== Number.MAX_SAFE_INTEGER
			? `:${window.first}-${window.last}`
			: (window.first > 1 ? `:${window.first}-` : "");
		return `read ${truncate(window.path, 80)}${end}`;
	}
	const pattern = stringField(call.args, "pattern");
	return pattern === undefined ? call.name : `${call.name} ${truncate(JSON.stringify(pattern), LABEL_ARGUMENT_CHARS)}`;
}

function describeCalls(calls: readonly { readonly name: string; readonly args: unknown }[]): string {
	const first = calls[0];
	if (first === undefined) return "tool output";
	const extra = calls.length - 1;
	return extra > 0 ? `${describeCall(first)} +${extra} more` : describeCall(first);
}

/**
 * Tracks fetch calls and their outputs, and reports the blocks a pass may clear:
 * those whose re-fetchable output a later call has made dead, and those whose
 * whole body is re-fetchable but has aged past the turn budget.
 *
 * One tracker per session. Its state is derived from the session log's own
 * events, so a canary run can be replayed offline from a stored log.
 */
export class SupersessionTracker {
	private readonly options: Required<SelectorOptions>;
	private readonly records = new Map<number, RefetchRecord>();
	private readonly byTarget = new Map<string, RefetchRecord[]>();
	private readonly blocks = new Map<string, BlockRecord>();
	/**
	 * Blocks a committed pass has already cleared, or that an existing decision in
	 * a replayed log already cleared. Retiring is the only irreversible step, and
	 * only a pass that actually wrote its decision may take it.
	 */
	private readonly retired = new Set<string>();
	private resultsLanded = 0;

	constructor(options: SelectorOptions = {}) {
		this.options = {
			deadShare: options.deadShare ?? DEFAULT_DEAD_SHARE,
			staleTurns: options.staleTurns ?? DEFAULT_STALE_TURNS,
			staleSteps: options.staleSteps ?? DEFAULT_STALE_STEPS,
		};
	}

	/** Register one `tool/result` landing; call ages are counted in results. */
	noteBlockLanding(): void {
		this.resultsLanded += 1;
	}

	/** Tool results seen so far; the age of a call is measured in these. */
	get resultsSeen(): number {
		return this.resultsLanded;
	}

	/**
	 * Register a fetch call. A call that supersedes earlier ones marks those
	 * records dead and re-evaluates the blocks that hold them.
	 */
	noteCall(call: RefetchCall): void {
		const key = targetKeyOf(call.name, call.args);
		if (key === undefined) return;
		const record: RefetchRecord = { call, key, tokens: 0 };
		this.records.set(call.seq, record);
		const sameTarget = this.byTarget.get(key);
		if (sameTarget === undefined) {
			this.byTarget.set(key, [record]);
			return;
		}
		for (const earlier of sameTarget) {
			if (earlier.supersededBySeq !== undefined) continue;
			if (!supersedes(call, earlier.call)) continue;
			earlier.supersededBySeq = call.seq;
			const block = this.blockFor(earlier.call.blockId);
			block.supersededTokens += earlier.tokens;
			const age = call.blockAge - earlier.call.blockAge;
			block.ageBlocks = Math.min(block.ageBlocks ?? Number.MAX_SAFE_INTEGER, Math.max(0, age));
		}
		sameTarget.push(record);
	}

	/** Record the tokens one call's own output occupies, once that output exists. */
	noteOutput(seq: number, tokens: number): void {
		const record = this.records.get(seq);
		if (record === undefined) return;
		const size = Math.max(0, tokens);
		if (size <= record.tokens) return;
		const delta = size - record.tokens;
		record.tokens = size;
		const block = this.blockFor(record.call.blockId);
		block.refetchTokens += delta;
		if (record.supersededBySeq !== undefined) block.supersededTokens += delta;
	}

	/** Record the model-visible size, surface seq and turn of a block. */
	noteBlockTokens(blockId: string, tokens: number, seq?: number, turn?: number): void {
		const block = this.blockFor(blockId);
		block.tokens = Math.max(block.tokens, Math.max(0, tokens));
		if (seq !== undefined) block.seq = seq;
		if (turn !== undefined && Number.isSafeInteger(turn)) block.turn = turn;
		// The step clock reads the landing index, which is stable once the block
		// arrives: a later pass over the same block must not reset its age.
		block.landedAt ??= this.resultsLanded;
	}

	/** Whether one block's visible body is almost entirely re-fetchable output. */
	isRefetchOnly(blockId: string): boolean {
		const block = this.blocks.get(blockId);
		if (block === undefined || block.refetchTokens === 0 || block.tokens === 0) return false;
		// Clearing rewrites the whole block, so the pointer may only replace a body
		// that the model can re-obtain in full. A PTC program that printed live
		// analysis next to one read would otherwise lose the analysis.
		return block.refetchTokens >= block.tokens * this.options.deadShare;
	}

	/** Whether one block currently has no live re-fetchable output. */
	isDead(blockId: string): boolean {
		const block = this.blocks.get(blockId);
		if (block === undefined || block.refetchTokens === 0) return false;
		// A block may hold a large, never-superseded output next to a small dead
		// one; clearing it would delete live content, so require near-total death.
		return block.supersededTokens >= block.refetchTokens * this.options.deadShare;
	}

	/** Whether a re-fetchable block has outlived its turn or step budget. */
	isStale(blockId: string, turn: number | undefined): boolean {
		const block = this.blocks.get(blockId);
		if (block === undefined) return false;
		const ageTurns = turn !== undefined && block.turn !== undefined ? turn - block.turn : undefined;
		if (this.options.staleTurns > 0 && ageTurns !== undefined && ageTurns >= this.options.staleTurns) return true;
		if (!(this.options.staleSteps > 0) || block.landedAt === undefined) return false;
		return this.resultsLanded - block.landedAt >= this.options.staleSteps;
	}

	/** Tool results since one block landed, when it has landed at all. */
	ageStepsOf(blockId: string): number | undefined {
		const block = this.blocks.get(blockId);
		if (block === undefined || block.landedAt === undefined) return undefined;
		return Math.max(0, this.resultsLanded - block.landedAt);
	}

	/**
	 * Candidates a clearing pass would free right now, and their total.
	 *
	 * `turn` is the boundary the pass is settling at: it ages the stale rule.
	 * Without it only superseded blocks are candidates, which is what a replay
	 * that has no boundary to place the decision at must use.
	 *
	 * Read-only on purpose: a pass that the gate, the occupancy floor, or a
	 * missing projection skips must leave its candidates for the next boundary
	 * instead of consuming them. Only {@link retire} removes a block.
	 */
	peekBatch(turn?: number): CanaryBatch {
		const candidates: ClearCandidate[] = [];
		for (const [blockId, block] of this.blocks) {
			if (this.retired.has(blockId) || !this.isRefetchOnly(blockId)) continue;
			const superseded = this.isDead(blockId);
			const stale = !superseded && this.isStale(blockId, turn);
			if (!superseded && !stale) continue;
			// A superseded block names the dead calls, so the breaker can tell which
			// targets the pointer sent the model back to. A stale block names every
			// re-fetchable call it replaces, because the pointer has to describe them.
			const named = [...this.records.values()].filter((record) =>
				record.call.blockId === blockId && (!superseded || record.supersededBySeq !== undefined),
			);
			const ageTurns = turn !== undefined && block.turn !== undefined ? Math.max(0, turn - block.turn) : undefined;
			const ageSteps = this.ageStepsOf(blockId);
			candidates.push({
				blockId,
				seq: block.seq ?? -1,
				tokens: block.tokens,
				calls: named.map((record) => ({ name: record.call.name, seq: record.call.seq })),
				keys: named.map((record) => record.key),
				label: describeCalls(named.map((record) => record.call)),
				ageBlocks: block.ageBlocks ?? 0,
				reason: superseded ? "superseded" : "stale",
				...(ageTurns !== undefined ? { ageTurns } : {}),
				...(ageSteps !== undefined ? { ageSteps } : {}),
			});
		}
		return { candidates, tokens: candidates.reduce((total, candidate) => total + candidate.tokens, 0) };
	}

	/** Whether a committed pass has already cleared this block. */
	isRetired(blockId: string): boolean {
		return this.retired.has(blockId);
	}

	/** Retire the blocks one committed pass cleared, so no later pass repeats them. */
	retire(blockIds: Iterable<string>): void {
		for (const blockId of blockIds) this.retired.add(blockId);
	}

	/**
	 * Retire a block by the seq of its `tool/result`, for a decision already in a
	 * replayed log. Returns whether a live block carried that seq.
	 */
	retireBySeq(seq: number): boolean {
		for (const [blockId, block] of this.blocks) {
			if (block.seq !== seq) continue;
			this.retired.add(blockId);
			return true;
		}
		return false;
	}

	private blockFor(blockId: string): BlockRecord {
		let block = this.blocks.get(blockId);
		if (block === undefined) {
			block = { tokens: 0, refetchTokens: 0, supersededTokens: 0 };
			this.blocks.set(blockId, block);
		}
		return block;
	}
}

/**
 * Re-read accounting for cleared targets.
 *
 * A re-read is not by itself a mistake: the placeholder invites one, and a file
 * that changed after the clear legitimately needs it again. What must not
 * continue is a *key* that keeps coming back — that target was live, not dead,
 * and clearing it again manufactures tool calls. Refusing one key is surgical;
 * the session-wide breaker stays for a rate spread across several keys.
 */
export interface RereadPolicy {
	/** Re-reads seen per target key. */
	readonly rereads: Map<string, number>;
	/** Keys this session must never clear again. */
	readonly refused: Set<string>;
}

/**
 * Re-reads after which one key is refused. Lower than the session-wide
 * `BREAKER_MIN_REREADS` on purpose: the per-key answer is cheaper and should win
 * before the global latch is a decision.
 */
export const BREAKER_KEY_REREADS = 2;

export function createRereadPolicy(): RereadPolicy {
	return { rereads: new Map(), refused: new Set() };
}

/**
 * Record one re-read of a cleared target. Returns true when this re-read refused
 * the key, so the caller can drop its evidence and keep the channel open.
 */
export function noteKeyReread(policy: RereadPolicy, key: string): boolean {
	if (policy.refused.has(key)) return true;
	const count = (policy.rereads.get(key) ?? 0) + 1;
	policy.rereads.set(key, count);
	if (count < BREAKER_KEY_REREADS) return false;
	policy.refused.add(key);
	return true;
}

/**
 * Whether a candidate touches a refused key.
 *
 * A clear rewrites the whole block, so *any* refused key in it is enough to skip
 * it: the placeholder would send the model back to a target it already proved is
 * still live.
 */
export function candidateRefused(
	policy: RereadPolicy,
	candidate: { readonly keys: readonly string[] },
): boolean {
	return candidate.keys.some((key) => policy.refused.has(key));
}

/**
 * Whether one pass is worth running.
 *
 * The clearing channel buys context quality, not tokens. Two different signals
 * can open the gate:
 *
 * - **volume** (`minTokens` / `minBlocks`): a pass that frees a few hundred
 *   tokens is not worth a prefix break on its own. This is the floor, not the
 *   objective;
 * - **rot share** (`minShare` of the live prompt): when dead output is a
 *   meaningful fraction of what the model reads, leaving it buried is the
 *   larger harm even when the absolute size is small. This is the
 *   anti-context-rot signal, and it is why the gate is not priced in money.
 *
 * `contextTokens` is the prompt the host is about to send (provider-reported
 * when available). `0` disables the share path.
 */
export interface BatchGate {
	readonly minTokens: number;
	readonly minBlocks: number;
	/** Dead share of the live prompt that opens the gate on its own; `0` disables. */
	readonly minShare: number;
}

/**
 * Calibrated defaults for the clearing gate. The plugin's live path reads
 * `autoClear.minTokens` / `autoClear.minBlocks` / `autoClear.minSharePercent`
 * from the config file; keep those defaults in sync with this constant.
 */
export const DEFAULT_BATCH_GATE: BatchGate = { minTokens: 1_200, minBlocks: 2, minShare: 0.05 };

export function batchPassesGate(
	batch: CanaryBatch,
	gate: BatchGate = DEFAULT_BATCH_GATE,
	contextTokens = 0,
): boolean {
	if (batch.candidates.length === 0) return false;
	if (batch.tokens >= gate.minTokens || batch.candidates.length >= gate.minBlocks) return true;
	if (!(gate.minShare > 0) || !(contextTokens > 0)) return false;
	return batch.tokens / contextTokens >= gate.minShare;
}

/** One canary log line: the selector's decision, with the facts needed to judge it. */
export interface CanaryRecord {
	readonly at: number;
	readonly turn: unknown;
	/**
	 * Step the decision was made in. Present only for a mid-turn pass: that is the
	 * one settlement point a turn number cannot locate.
	 */
	readonly step?: unknown;
	readonly tokens: number;
	/**
	 * One-time re-prefill cost of the batch: model-visible tokens behind its
	 * earliest cleared block, minus the bodies the same batch also removes (see
	 * `batchSuffixTokens`). Absent when the host could not price the surface.
	 *
	 * Recorded, never used: the anti-rot gate is not priced in tokens, so this
	 * exists so a replay can compare what a pass freed against what it cost.
	 */
	readonly suffixTokens?: number;
	readonly candidates: readonly ClearCandidate[];
	/** True when the batch would have been executed. */
	readonly gate: boolean;
	/**
	 * What the settlement did: `cleared`, `canary`, `gate`, `occupancy`,
	 * `unavailable`, `unrecordable`, `breaker`, `rejected`, or `no-candidate`.
	 * Without it a skipped pass cannot be told from a gate that never opened.
	 */
	readonly outcome?: string;
	/** What clearing did to the session, not what it might save. */
	readonly quality?: CanaryQuality;
}

/**
 * The outcome half of the canary ledger.
 *
 * Proposals alone cannot answer whether clearing helps: a clear that the model
 * immediately undoes costs tool calls and attention. These counters are the
 * mechanical trace of that:
 *
 * - `rereads` — a cleared target was fetched again (a pointer invite, or a miss);
 * - `errors` — tool results that reported `isError`;
 * - `errorRereads` — an error on a target this session cleared (a pointer that
 *   sent the model back to something that no longer works);
 * - `contextTokens` — the prompt size the host reported, so the dead share can
 *   be read off the same line.
 *
 * `turn` is the slice since the previous boundary; `session` is cumulative.
 */
export interface CanaryQuality {
	readonly contextTokens: number;
	readonly turn: {
		readonly rereads: number;
		readonly errors: number;
		readonly errorRereads: number;
	};
	readonly session: {
		readonly results: number;
		readonly clearedBlocks: number;
		readonly clearedTokens: number;
		readonly passes: number;
		readonly rereads: number;
		readonly errors: number;
		readonly errorRereads: number;
	};
}
