/**
 * Canary for automatic tool-result clearing.
 *
 * This module is the *selector* only: it decides which tool results a cleanup
 * pass would free, and never changes what the model sees. The DSH host learns
 * about a clear through a message projection, which is deliberately not part of
 * this file; a canary run must stay model-invisible so the numbers can be
 * calibrated before any content is replaced.
 *
 * The trigger is "superseded": a re-fetchable tool result (`read` / `grep` /
 * `glob`) whose target was fetched again later. Position matters more than
 * volume — an in-place clear breaks the prefix cache from the cleared block to
 * the tail — so every candidate carries the number of tool results that landed
 * between the cleared call and its superseder, and nothing is cleared on
 * position alone.
 */
/** Tools whose output the model can re-obtain by calling the tool again. */
export const REFETCH_TOOL_NAMES = ["read", "grep", "glob"];
export const DEFAULT_DEAD_SHARE = 0.95;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Normalize the arguments the provider sent. DSH stores them as the raw JSON
 * string on `tool/call` and as an object on a PTC sub-call.
 */
export function parseToolArguments(value) {
    if (typeof value !== "string")
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
function stringField(value, ...names) {
    if (!isRecord(value))
        return undefined;
    for (const name of names) {
        const field = value[name];
        if (typeof field === "string" && field.length > 0)
            return field;
    }
    return undefined;
}
function integerField(value, name) {
    if (!isRecord(value))
        return undefined;
    const field = value[name];
    return typeof field === "number" && Number.isFinite(field) ? Math.trunc(field) : undefined;
}
/** The line window a `read` call asked for, or `undefined` when the path is missing. */
export function readWindowOf(args) {
    const path = stringField(args, "file_path", "path");
    if (path === undefined)
        return undefined;
    const offset = integerField(args, "offset");
    const limit = integerField(args, "limit");
    const first = offset !== undefined && offset > 0 ? offset : 1;
    // `limit` is a maximum line count, so a missing limit means "to the end";
    // coverage then only holds when the newer read also reaches past the older
    // window's end, which keeps the check conservative.
    const last = limit !== undefined && limit > 0 ? first + limit - 1 : Number.MAX_SAFE_INTEGER;
    return { path, first, last };
}
function canonicalArguments(args) {
    if (!isRecord(args))
        return JSON.stringify(args ?? null);
    const keys = Object.keys(args).sort();
    return keys.map((key) => `${key}=${JSON.stringify(args[key])}`).join("\u0000");
}
/**
 * Stable identity of a fetch target: two calls with the same key asked for the
 * same thing. `read` is narrowed by line window in {@link supersedes}, because
 * two reads of one file at different offsets do not answer the same question.
 */
export function targetKeyOf(name, args) {
    if (name === "read") {
        const window = readWindowOf(args);
        return window === undefined ? undefined : `read\u0000${window.path}`;
    }
    if (name === "grep" || name === "glob")
        return `${name}\u0000${canonicalArguments(args)}`;
    return undefined;
}
/** Whether `later` answers everything `earlier` answered. */
export function supersedes(later, earlier) {
    if (later.name !== earlier.name)
        return false;
    if (later.name !== "read")
        return true;
    const newer = readWindowOf(later.args);
    const older = readWindowOf(earlier.args);
    if (newer === undefined || older === undefined)
        return false;
    return newer.path === older.path && newer.first <= older.first && newer.last >= older.last;
}
/** Longest argument excerpt kept in a pointer, so a placeholder stays one line. */
export const LABEL_ARGUMENT_CHARS = 60;
function truncate(value, max) {
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
/**
 * One-line description of what a cleared call asked for.
 *
 * It is the model's only way back to the content, so it names the target and,
 * when the call was a `read`, the exact line window that was cleared.
 */
export function describeCall(call) {
    if (call.name === "read") {
        const window = readWindowOf(call.args);
        if (window === undefined)
            return "read";
        const end = window.last !== Number.MAX_SAFE_INTEGER
            ? `:${window.first}-${window.last}`
            : (window.first > 1 ? `:${window.first}-` : "");
        return `read ${truncate(window.path, 80)}${end}`;
    }
    const pattern = stringField(call.args, "pattern");
    return pattern === undefined ? call.name : `${call.name} ${truncate(JSON.stringify(pattern), LABEL_ARGUMENT_CHARS)}`;
}
function describeCalls(calls) {
    const first = calls[0];
    if (first === undefined)
        return "tool output";
    const extra = calls.length - 1;
    return extra > 0 ? `${describeCall(first)} +${extra} more` : describeCall(first);
}
/**
 * Tracks fetch calls and their outputs, and reports the blocks whose
 * re-fetchable output a later call has made dead.
 *
 * One tracker per session. Its state is derived from the session log's own
 * events, so a canary run can be replayed offline from a stored log.
 */
export class SupersessionTracker {
    options;
    records = new Map();
    byTarget = new Map();
    blocks = new Map();
    /**
     * Blocks a committed pass has already cleared, or that an existing decision in
     * a replayed log already cleared. Retiring is the only irreversible step, and
     * only a pass that actually wrote its decision may take it.
     */
    retired = new Set();
    resultsLanded = 0;
    constructor(options = {}) {
        this.options = { deadShare: options.deadShare ?? DEFAULT_DEAD_SHARE };
    }
    /** Register one `tool/result` landing; call ages are counted in results. */
    noteBlockLanding() {
        this.resultsLanded += 1;
    }
    /** Tool results seen so far; the age of a call is measured in these. */
    get resultsSeen() {
        return this.resultsLanded;
    }
    /**
     * Register a fetch call. A call that supersedes earlier ones marks those
     * records dead and re-evaluates the blocks that hold them.
     */
    noteCall(call) {
        const key = targetKeyOf(call.name, call.args);
        if (key === undefined)
            return;
        const record = { call, key, tokens: 0 };
        this.records.set(call.seq, record);
        const sameTarget = this.byTarget.get(key);
        if (sameTarget === undefined) {
            this.byTarget.set(key, [record]);
            return;
        }
        for (const earlier of sameTarget) {
            if (earlier.supersededBySeq !== undefined)
                continue;
            if (!supersedes(call, earlier.call))
                continue;
            earlier.supersededBySeq = call.seq;
            const block = this.blockFor(earlier.call.blockId);
            block.supersededTokens += earlier.tokens;
            const age = call.blockAge - earlier.call.blockAge;
            block.ageBlocks = Math.min(block.ageBlocks ?? Number.MAX_SAFE_INTEGER, Math.max(0, age));
        }
        sameTarget.push(record);
    }
    /** Record the tokens one call's own output occupies, once that output exists. */
    noteOutput(seq, tokens) {
        const record = this.records.get(seq);
        if (record === undefined)
            return;
        const size = Math.max(0, tokens);
        if (size <= record.tokens)
            return;
        const delta = size - record.tokens;
        record.tokens = size;
        const block = this.blockFor(record.call.blockId);
        block.refetchTokens += delta;
        if (record.supersededBySeq !== undefined)
            block.supersededTokens += delta;
    }
    /** Record the model-visible size and surface seq of a block, once its result lands. */
    noteBlockTokens(blockId, tokens, seq) {
        const block = this.blockFor(blockId);
        block.tokens = Math.max(block.tokens, Math.max(0, tokens));
        if (seq !== undefined)
            block.seq = seq;
    }
    /** Whether one block currently has no live re-fetchable output. */
    isDead(blockId) {
        const block = this.blocks.get(blockId);
        if (block === undefined || block.refetchTokens === 0)
            return false;
        // A block may hold a large, never-superseded output next to a small dead
        // one; clearing it would delete live content, so require near-total death.
        return block.supersededTokens >= block.refetchTokens * this.options.deadShare;
    }
    /**
     * Candidates a clearing pass would free right now, and their total.
     *
     * Read-only on purpose: a pass that the gate, the occupancy floor, or a
     * missing projection skips must leave its candidates for the next boundary
     * instead of consuming them. Only {@link retire} removes a block.
     */
    peekBatch() {
        const candidates = [];
        for (const [blockId, block] of this.blocks) {
            if (this.retired.has(blockId) || !this.isDead(blockId))
                continue;
            const dead = [...this.records.values()]
                .filter((record) => record.call.blockId === blockId && record.supersededBySeq !== undefined);
            const calls = dead.map((record) => ({ name: record.call.name, seq: record.call.seq }));
            candidates.push({
                blockId,
                seq: block.seq ?? -1,
                tokens: block.tokens,
                calls,
                keys: dead.map((record) => record.key),
                label: describeCalls(dead.map((record) => record.call)),
                ageBlocks: block.ageBlocks ?? 0,
            });
        }
        return { candidates, tokens: candidates.reduce((total, candidate) => total + candidate.tokens, 0) };
    }
    /** Retire the blocks one committed pass cleared, so no later pass repeats them. */
    retire(blockIds) {
        for (const blockId of blockIds)
            this.retired.add(blockId);
    }
    /**
     * Retire a block by the seq of its `tool/result`, for a decision already in a
     * replayed log. Returns whether a live block carried that seq.
     */
    retireBySeq(seq) {
        for (const [blockId, block] of this.blocks) {
            if (block.seq !== seq)
                continue;
            this.retired.add(blockId);
            return true;
        }
        return false;
    }
    blockFor(blockId) {
        let block = this.blocks.get(blockId);
        if (block === undefined) {
            block = { tokens: 0, refetchTokens: 0, supersededTokens: 0 };
            this.blocks.set(blockId, block);
        }
        return block;
    }
}
/**
 * Calibrated defaults for the clearing gate. The plugin's live path reads
 * `autoClear.minTokens` / `autoClear.minBlocks` / `autoClear.minSharePercent`
 * from the config file; keep those defaults in sync with this constant.
 */
export const DEFAULT_BATCH_GATE = { minTokens: 1_200, minBlocks: 2, minShare: 0.05 };
export function batchPassesGate(batch, gate = DEFAULT_BATCH_GATE, contextTokens = 0) {
    if (batch.candidates.length === 0)
        return false;
    if (batch.tokens >= gate.minTokens || batch.candidates.length >= gate.minBlocks)
        return true;
    if (!(gate.minShare > 0) || !(contextTokens > 0))
        return false;
    return batch.tokens / contextTokens >= gate.minShare;
}
/**
 * Trim a batch to what the session budget can still pay for.
 *
 * The budget is cumulative, but a real batch can exceed it on its own: the
 * largest replayed session produced a 73,646-token batch against the 40,000
 * default, and a whole-batch veto latched `stopped (budget)` before clearing
 * anything. Slice oldest-first instead, and let the first pass overshoot by
 * one candidate when the only dead block is larger than the cap — otherwise a
 * single oversized block could never be cleared and only host compaction
 * would touch it.
 */
export function fitBatch(batch, maxTokens, allowOversizeSingle = false) {
    const candidates = [...batch.candidates].sort((left, right) => left.seq - right.seq);
    if (candidates.length === 0)
        return undefined;
    const cap = Math.max(0, maxTokens);
    const selected = [];
    let total = 0;
    for (const candidate of candidates) {
        const size = Math.max(0, candidate.tokens);
        if (total + size > cap)
            continue;
        selected.push(candidate);
        total += size;
    }
    if (selected.length > 0)
        return { candidates: selected, tokens: total };
    const first = candidates[0];
    if (first === undefined || !allowOversizeSingle)
        return undefined;
    return { candidates: [first], tokens: Math.max(0, first.tokens) };
}
