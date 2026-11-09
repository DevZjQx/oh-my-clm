import { buildBlockDigestUnits, estimateMirrorTokens, } from "./context-format.js";
const DEFAULT_MAX_CANDIDATES = 3;
/**
 * A candidate is a range **plus** a keep-rule. A turn starts at its user block
 * (`buildBlockDigestUnits`), so a bare range would hand the model a call that
 * deletes the human's own request. `skipRoles: ["user"]` makes the suggestion
 * safe to confirm as-is: only the assistant/toolResult noise of a settled turn
 * goes away, and the quoted savings are computed after that rule, not before.
 */
export const CANDIDATE_SKIP_ROLES = ["user"];
/** `0.8` -> `80%`, `9.62` -> `9.6%`; the model sees a compact magnitude. */
export function formatPercent(value) {
    const clamped = Math.max(0, value);
    return `${clamped >= 10 ? Math.round(clamped) : Math.round(clamped * 10) / 10}%`;
}
/** `6400` -> `6.4k`, `800` -> `800`; the model sees a compact magnitude. */
export function formatTokenCount(value) {
    const rounded = Math.max(0, Math.round(value));
    if (rounded < 1_000)
        return String(rounded);
    const thousands = rounded / 1_000;
    const scaled = thousands >= 10 ? String(Math.round(thousands)) : String(Math.round(thousands * 10) / 10);
    return `${scaled}k`;
}
/**
 * One header line for the dynamic runtime context. The host-exact value is
 * shown bare; the fallback estimate keeps `~` so a missing projection service
 * is visible rather than silently passed off as exact (P1-2).
 */
export function formatUsageLine(input) {
    const tokens = `${input.exact ? "" : "~"}${formatTokenCount(input.tokens)}`;
    const hasWindow = input.contextWindow !== undefined && input.contextWindow > 0;
    const where = hasWindow
        ? `${tokens}/${formatTokenCount(input.contextWindow)} tokens`
        : `${tokens} tokens (window unknown)`;
    const percent = hasWindow ? ` (${formatPercent((input.tokens / input.contextWindow) * 100)})` : "";
    const cleanup = input.lastCleanupTurn === undefined
        ? "no cleanup yet"
        : `last cleanup at ${input.turnWord ?? "turn"} ${input.lastCleanupTurn}`;
    const blocks = `${input.editableBlocks} editable block${input.editableBlocks === 1 ? "" : "s"}`;
    return `Usage: ${where}${percent} · ${blocks} · ${cleanup}`;
}
function enabled(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
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
export function assembleCleanupCandidates(records, options = {}) {
    const maxCandidates = Math.max(1, Math.floor(options.maxCandidates ?? DEFAULT_MAX_CANDIDATES));
    const minSavings = Math.max(0, Math.floor(options.minSavingsTokens ?? 0));
    const units = buildBlockDigestUnits(records);
    const completed = units.filter((unit) => !unit.open);
    const candidates = completed
        .map((unit, index) => ({
        start: unit.start,
        end: unit.end,
        // The keep-rule is part of the suggestion, so the figure the model reads
        // must already exclude what the rule preserves. A turn that is nothing
        // but a user message therefore scores 0 and is dropped below.
        tokens: estimateMirrorTokens(unit.records.filter((record) => record.role !== "user")),
        // Counted from the end of the completed list, so the ranking is the
        // same whether the open turn exists or not.
        turnsOld: completed.length - index,
    }))
        .filter((candidate) => candidate.start > 1)
        .filter((candidate) => candidate.tokens > 0 && candidate.tokens >= minSavings)
        // Savings first, then staleness: a big recent turn can beat a tiny old one,
        // but equal sizes prefer the turn that has been paying rent the longest.
        .sort((a, b) => b.tokens * b.turnsOld - a.tokens * a.turnsOld
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
export function planCleanupTrigger(records, context, options = {}) {
    const signals = [];
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
    if (signals.length === 0)
        return { triggered: false, signals, candidates: [], savingsTokens: 0 };
    return { triggered: true, signals, ...assembleCleanupCandidates(records, options) };
}
/**
 * The model-visible half: a ready-to-confirm `cleanup` call plus the per-range
 * reason. The answer space is a confirmation, not an open "should I clean"
 * question (docs/plan.md §5.0). Empty when nothing is worth suggesting.
 */
/** `{3,5}` -> `3-5`, `{5,5}` -> `5`; one spelling for the call and the detail line. */
function candidateRange(candidate) {
    return candidate.start === candidate.end ? String(candidate.start) : `${candidate.start}-${candidate.end}`;
}
export function renderCleanupCandidates(plan) {
    if (!plan.triggered || plan.candidates.length === 0)
        return "";
    const ranges = plan.candidates.map((candidate) => JSON.stringify(candidateRange(candidate)));
    const skipRoles = JSON.stringify([...CANDIDATE_SKIP_ROLES]);
    const head = `Suggested cleanup (${plan.signals.join("; ")}): cleanup({ ranges: [${ranges.join(", ")}], skipRoles: ${skipRoles} }) frees ~${plan.savingsTokens} tok.`;
    const detail = `Candidates: ${plan.candidates
        .map((candidate) => `${candidateRange(candidate)} (~${candidate.tokens} tok, ${candidate.turnsOld} turn${candidate.turnsOld === 1 ? "" : "s"} old)`)
        .join(", ")}; block 1, user messages, and the current turn stay.`;
    return `${head}\n${detail}`;
}
