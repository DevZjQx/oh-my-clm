import * as fs from "node:fs";
import { CLM_MIRROR_FILENAME, CLM_TEMP_ROOT, sessionCanaryPath, sessionMirrorPath, } from "../src/lib/clm-paths.js";
import { loadClmConfig } from "../src/lib/clm-config.js";
import { appendPrivateLine, writePrivateText } from "../src/lib/clm-files.js";
import { BREAKER_KEY_REREADS, REFETCH_TOOL_NAMES, SupersessionTracker, batchPassesGate, batchNetTokens, candidateRefused, createRereadPolicy, noteKeyReread, parseToolArguments, targetKeyOf, } from "../src/features/live-context/auto-clear.js";
import { CLEAR_EVENT_TYPE, CLEAR_VERSION, CLEAR_LABEL_MAX_CHARS, CLEAR_PLACEHOLDER_MAX_CHARS, clearPlaceholder, clearProjection, } from "../src/features/live-context/clear-projection.js";
import { dshPromptText } from "../src/features/live-context/context-prompt.js";
import { resolvePluginRecordWriter, } from "../src/features/live-context/plugin-record.js";
import { batchSuffixTokens, buildDshMirrorRecords, dshBatchSuffixTokens, dshBlockIndexText, dshOpenTurnStep, dshSurfaceTokensAfterEach, dshTriggerView, executeDshCleanup, reconcileDshMirror, } from "../src/features/live-context/dsh-bridge.js";
import { estimateMirrorTokens, estimateTokens, hostUsageOf, renderMirror, } from "../src/features/live-context/context-format.js";
import { formatCleanupToolResult, parseCleanupArgs, parseCleanupResultCopy, } from "../src/features/live-context/context-cleanup.js";
export const name = "oh-my-clm";
const PROMPT_SECTION = "oh-my-clm:live-context";
const BLOCK_INDEX_CONTEXT = "oh-my-clm:block-index";
const DEFAULT_ORDER = 3240;
/** Runtime context sorts after the host's sandbox/approval facts. */
const BLOCK_INDEX_ORDER = 200;
function sessionConfig(session) {
    const cwd = typeof session.header?.cwd === "string" ? session.header.cwd : process.cwd();
    return loadClmConfig(cwd).config;
}
/**
 * Cleanup trigger switches. Every threshold defaults to 0
 * because none of them is calibrated on a real DeepSeek-V4.1-Flash session yet;
 * the mechanism ships disabled, and enabling it is a deliberate, documented act.
 */
function triggerOptions(config) {
    const trigger = config.cleanup.trigger;
    return {
        usagePercent: trigger.usagePercent,
        completedTurns: trigger.completedTurns,
        completedSteps: trigger.completedSteps,
        toolResultShare: trigger.toolResultSharePercent / 100,
        turnsSinceCleanup: trigger.turnsSinceCleanup,
        stepsSinceCleanup: trigger.stepsSinceCleanup,
        maxCandidates: trigger.maxCandidates,
        minSavingsTokens: trigger.minSavingsTokens,
        // `r` in `r·L + (1−r)·B` as a fraction. Per-endpoint, so it is a config
        // value rather than a hardcoded constant.
        cacheDiscount: config.cleanup.cacheDiscountPercent / 100,
        paybackTurns: config.cleanup.paybackTurns,
        paybackSteps: config.cleanup.paybackSteps,
    };
}
/** Tool results a cleared target may come back within and still count as a miss. */
const BREAKER_WINDOW_RESULTS = 3;
/**
 * Distinct targets a session must have had to refuse before the channel stops.
 *
 * A key is refused only after the model came back to it twice, and the first
 * re-read is the one the placeholder ordered before an edit. So this counts
 * targets the clear genuinely mis-priced, not clears the model followed the
 * pointer on — the rate this divides is the one the instruction cannot inflate.
 */
const BREAKER_MIN_REFUSED = 3;
/** `autoClear.canary` arms the clearing canary. Off by default. */
function canaryEnabled(config) {
    return config.autoClear.canary;
}
/** Both floors are calibrated against real sessions; the config file owns them. */
function canaryGate(config) {
    return {
        minTokens: config.autoClear.minTokens,
        minBlocks: config.autoClear.minBlocks,
        minShare: config.autoClear.minSharePercent / 100,
        maxSuffixTokens: config.autoClear.maxSuffixTokens,
        minNetTokens: config.autoClear.minNetTokens,
        windowShare: config.autoClear.minTokensWindowPercent / 100,
    };
}
/**
 * The money channel's verdict on one priced batch.
 * The suffix cap is the shape test: a batch whose one-time re-prefill is
 * thousands of tokens cannot amortize over any plausible horizon. The net
 * test is the same arithmetic `context-trigger.ts` prices a candidate range
 * with, lifted to the batch: the freed tokens stop renting at the cached rate,
 * the break is paid once at the full rate. Either failing rejects the batch
 * for the money channel; `rot` ignores both.
 */
function moneyVerdict(config, batch, suffixTokens) {
    if (config.autoClear.channel === "rot")
        return true;
    if (suffixTokens === undefined)
        return true;
    const gate = canaryGate(config);
    if (gate.maxSuffixTokens > 0 && suffixTokens > gate.maxSuffixTokens)
        return false;
    if (gate.minNetTokens < 0)
        return true;
    const payback = config.cleanup.paybackSteps > 0
        ? config.cleanup.paybackSteps
        : config.cleanup.paybackTurns;
    const net = batchNetTokens(batch.tokens, suffixTokens, config.cleanup.cacheDiscountPercent / 100, payback);
    return net >= gate.minNetTokens;
}
/**
 * `autoClear.enabled` arms clearing itself. Off by default: the selector is
 * calibrated, but the breaker thresholds are not, and a clear is the first thing
 * this plugin does that changes what the model reads.
 */
function autoClearEnabled(config) {
    return config.autoClear.enabled;
}
/** Occupancy at which clearing hands the session back to host compaction. */
function autoClearStopPercent(config) {
    return config.autoClear.stopPercent;
}
function canaryValue(value, name) {
    if (typeof value !== "object" || value === null)
        return undefined;
    return value[name];
}
function canaryString(value, name) {
    const field = canaryValue(value, name);
    return typeof field === "string" && field.length > 0 ? field : undefined;
}
function canaryText(value) {
    if (Array.isArray(value))
        return value.map(canaryText).join("");
    if (typeof value !== "object" || value === null)
        return "";
    const text = value.text;
    return typeof text === "string" ? text : "";
}
function isRefetchTool(name) {
    return REFETCH_TOOL_NAMES.includes(name);
}
/**
 * Follow one session's tool traffic for the clearing canary.
 *
 * This writes no session event and changes nothing the model sees: at each turn
 * boundary it appends the blocks a clearing pass *would* have freed, with the
 * facts needed to judge the decision (size, call age, gate outcome). The log
 * lives beside the mirror in the session's private temporary directory.
 */
function feedCanary(ctx, session, event, state, allowPass = true) {
    const seq = event.seq;
    if (typeof seq !== "number")
        return;
    const data = event.data;
    if (event.type === "step/start") {
        // The host is about to send a request: everything that has landed is in it.
        state.tracker.noteRequestSent();
        return;
    }
    if (event.type === "user/message") {
        state.tracker.noteUserMessage();
        return;
    }
    if (event.type === "tool/call") {
        const callId = canaryString(data, "callId");
        const name = canaryString(data, "name");
        if (callId === undefined || name === undefined || !isRefetchTool(name))
            return;
        state.callSeqs.set(callId, seq);
        const args = parseToolArguments(canaryValue(data, "arguments"));
        rememberCallKey(state, callId, name, args);
        noteRefetch(ctx, state, name, args);
        state.tracker.noteCall({ name, args, blockId: callId, seq, blockAge: state.tracker.resultsSeen });
        return;
    }
    if (event.type === "tool/ptc-dispatch") {
        // One program call runs several tools; the model-visible block is the root
        // call's result, so every sub-call is attributed to it.
        const rootCallId = canaryString(data, "rootCallId");
        const name = canaryString(data, "name");
        if (rootCallId === undefined || name === undefined || !isRefetchTool(name))
            return;
        const args = canaryValue(data, "arguments");
        rememberCallKey(state, rootCallId, name, args);
        noteRefetch(ctx, state, name, args);
        state.tracker.noteCall({ name, args, blockId: rootCallId, seq, blockAge: state.tracker.resultsSeen });
        state.tracker.noteOutput(seq, estimateTokens([canaryText(canaryValue(data, "content"))]));
        return;
    }
    if (event.type === "tool/result") {
        const message = canaryValue(data, "message");
        const callId = canaryString(message, "toolCallId");
        if (callId === undefined)
            return;
        const tokens = estimateTokens([canaryText(canaryValue(message, "content"))]);
        noteToolOutcome(state, callId, canaryValue(message, "isError") === true);
        state.tracker.noteBlockLanding();
        const blockTurn = canaryValue(data, "turn");
        state.tracker.noteBlockTokens(callId, tokens, seq, typeof blockTurn === "number" ? blockTurn : undefined);
        const callSeq = state.callSeqs.get(callId);
        if (callSeq !== undefined) {
            state.callSeqs.delete(callId);
            state.tracker.noteOutput(callSeq, tokens);
        }
        return;
    }
    if (event.type === "step/end") {
        // Seeding a resumed session replays history: a pass there would decide
        // again on a boundary that already happened in a previous run.
        if (!allowPass)
            return;
        maybeMidTurnPass(ctx, session, state, canaryValue(data, "turn"), canaryValue(data, "step"));
        return;
    }
    if (event.type !== "turn/end")
        return;
    if (!allowPass)
        return;
    // A boundary is the only place a *batch* pass runs, and `peekBatch` is
    // read-only: a pass the gate, the occupancy floor, or a missing projection
    // skips leaves its candidates for the next boundary instead of consuming them.
    const turn = canaryValue(data, "turn");
    const boundary = typeof turn === "number" && Number.isSafeInteger(turn) ? turn : undefined;
    const batch = state.tracker.peekBatch(boundary);
    const usage = hostUsageFor(session, state.config);
    const suffixTokens = dshBatchSuffixTokens(session, batch.candidates);
    if (batch.candidates.length === 0) {
        // An empty batch is a decision too: the selector looked and found nothing.
        // Recording it is what separates "no rot yet" from a gate that never opens.
        state.auto.last = { turn, candidates: 0, tokens: 0, outcome: "no-candidate" };
        if (canaryEnabled(state.config)) {
            writeCanaryRecord(ctx, session, state, settlementOf(state, { turn }, batch, false, usage));
        }
        resetTurnQuality(state);
        return;
    }
    // Snapshot before scheduling: the turn counters belong to the turn that just
    // ended, and the host may append the next turn before the deferred pass runs.
    // The channel decides together with the volume gate: `rot` is today's shape,
    // `money` additionally refuses a batch whose suffix cannot amortize, and
    // `both` falls back to rot for exactly those batches.
    const volume = batchPassesGate(batch, state.gate, usage?.tokens ?? 0, usage?.contextWindow ?? 0);
    const money = moneyVerdict(state.config, batch, suffixTokens);
    const gate = state.config.autoClear.channel === "both"
        ? volume || money
        : volume && money;
    const settlement = settlementOf(state, { turn }, batch, gate, usage, suffixTokens);
    resetTurnQuality(state);
    scheduleSettlement(ctx, session, state, settlement);
}
/**
 * Clear a block before the turn boundary, but only when waiting is provably
 * worse than the prefix break it causes.
 *
 * The turn boundary is the right settlement point for a *batch*: one break is
 * shared by every block in it, and replayed sessions give 4.4 blocks per pass
 * there versus 2.3 for a step boundary, which is +31% prefix re-prefill for the
 * same freed content. A single block is the exception: when the tail behind it is
 * cheaper than the rent the remaining steps keep paying, clearing it now beats
 * carrying it to the boundary.
 *
 * One test gates it, and it does not guess how long the turn will run:
 * `autoClear.midTurnSuffixTokens` bounds the tail that would have to be
 * re-prefilled. 0.1.18 also required the saved rent to pay for the break
 * (`earlyClearPays`); that was a money test, and on the anti-rot channel the
 * harm being prevented (dead content still in the prompt) is the thing that
 * matters, not the cache arithmetic. One pass per turn keeps a long turn from
 * turning into one break per step.
 */
function maybeMidTurnPass(ctx, session, state, turn, step) {
    if (!autoClearEnabled(state.config))
        return;
    const suffixBudget = state.config.autoClear.midTurnSuffixTokens;
    if (!(suffixBudget > 0))
        return;
    if (state.auto.stop !== undefined)
        return;
    const turnNumber = typeof turn === "number" && Number.isSafeInteger(turn) ? turn : undefined;
    const stepNumber = typeof step === "number" && Number.isSafeInteger(step) ? step : undefined;
    if (turnNumber === undefined || stepNumber === undefined)
        return;
    if (state.midTurnTurn === turnNumber)
        return;
    const batch = liveBatchOf(state, state.tracker.peekBatch(turnNumber));
    if (batch.candidates.length === 0)
        return;
    const tails = dshSurfaceTokensAfterEach(session, batch.candidates.map((candidate) => candidate.seq).filter((seq) => Number.isSafeInteger(seq) && seq >= 0));
    const cheap = batch.candidates.filter((candidate) => {
        if (!Number.isSafeInteger(candidate.seq) || candidate.seq < 0)
            return false;
        // What the next request must re-prefill is the tail *minus* the body this
        // clear removes; a re-read of the same target sits in that tail, so it is
        // the size difference that counts, not the raw tail. The tail budget is
        // the whole test: payback was a money gate and does not belong on the
        // anti-rot channel.
        const suffix = Math.max(0, (tails.get(candidate.seq) ?? 0) - Math.max(0, candidate.tokens));
        return suffix <= suffixBudget;
    });
    if (cheap.length === 0)
        return;
    const freed = cheap.reduce((total, candidate) => total + Math.max(0, candidate.tokens), 0);
    // The volume gate is deliberately bypassed: it exists to amortise one break
    // over many blocks, and this break is already free (or priced above).
    const usage = hostUsageFor(session, state.config);
    const suffix = batchSuffixTokens(cheap, tails);
    if (!moneyVerdict(state.config, { ...batch, candidates: cheap, tokens: freed }, suffix))
        return;
    const settlement = settlementOf(state, { turn: turnNumber, step: stepNumber }, { ...batch, candidates: cheap, tokens: freed }, true, usage, suffix);
    // The ration is spent only by a pass that actually wrote its record: a skip for
    // a transient reason (occupancy, projection not registered) must get another
    // chance inside this same turn. Reserve it now — a second `step/end` in the
    // same tick must not schedule a second break — and hand it back if nothing was
    // written.
    state.midTurnTurn = turnNumber;
    scheduleSettlement(ctx, session, state, settlement, (applied) => {
        if (!applied)
            state.midTurnTurn = undefined;
    });
}
/** Everything one settlement needs, read at the boundary it belongs to. */
function settlementOf(state, where, batch, gate, usage, suffixTokens) {
    return {
        where,
        batch,
        gate,
        usage,
        ...(suffixTokens === undefined ? {} : { suffixTokens }),
        turn: {
            rereads: state.auto.turnRereads,
            errors: state.auto.turnErrors,
            errorRereads: state.auto.turnErrorRereads,
        },
        dirty: state.auto.qualityDirty,
        fresh: batch.candidates.filter((candidate) => !state.reported.has(candidate.blockId)),
    };
}
/**
 * Settle one boundary after the host finishes publishing the event that opened
 * it.
 *
 * `Session.commit()` notifies `session/event` observers while the append is
 * still marked active, and `appendPluginRecord` refuses a nested append
 * ("session append cannot reenter while another append is being published").
 * Writing the clear record from inside the observer therefore fails on every
 * boundary and reports `rejected` with `0 pass(es)`: the decision is sound, the
 * record is not. The microtask runs once that append has returned; the
 * settlement carries everything the decision reads, so nothing drifts in
 * between.
 */
function scheduleSettlement(ctx, session, state, settlement, onSettled) {
    queueMicrotask(() => {
        if (state.disposed === true)
            return;
        try {
            // Not `onSettled?.(runPass(...))`: an optional call does not evaluate its
            // arguments, so the settlement itself would be skipped whenever there is
            // no callback to hand the result to.
            const applied = runPass(ctx, session, state, settlement);
            onSettled?.(applied);
        }
        catch (error) {
            ctx.logger?.warn?.(`oh-my-clm: settlement failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
}
/**
 * One settlement: canary record, admissibility, apply.
 *
 * Shared by the turn boundary and the mid-turn exception so both obey the same
 * breaker, occupancy floor and seam checks.
 */
function runPass(ctx, session, state, settlement) {
    const { where, gate } = settlement;
    // The file can change after the boundary queued this pass. Recheck the
    // switches before any durable write, even when no new request has started.
    const liveConfig = sessionConfig(session);
    // Two boundaries announced in one tick (a step that ends its turn) both capture
    // the same live blocks, and the settlement queued first retires them. Trim to
    // what is still live, or the same target is written twice and the pass, the
    // freed tokens and the breaker's denominator are all counted twice.
    const batch = liveBatchOf(state, settlement.batch);
    if (batch.candidates.length === 0) {
        // The honest report: this boundary saw only what a pass ahead of it already
        // cleared.
        state.auto.last = { turn: where.turn, candidates: 0, tokens: 0, outcome: "no-candidate" };
        if (canaryEnabled(liveConfig))
            writeCanaryRecord(ctx, session, state, { ...settlement, batch });
        return false;
    }
    // Execute first, then log: the ledger's quality block reports what this pass
    // actually did (blocks retired, tokens freed), so writing it before the write
    // would report the previous pass's totals one boundary late.
    const enabled = autoClearEnabled(state.config) && autoClearEnabled(liveConfig);
    const blocked = enabled ? admitClear(state, gate, settlement.usage) : undefined;
    const applied = enabled && blocked === undefined ? applyClear(ctx, session, state, batch) : false;
    // A settlement that cleared nothing still has to say which check stopped it;
    // otherwise `0 pass(es)` is the same text for six different states.
    state.auto.last = {
        turn: where.turn,
        candidates: batch.candidates.length,
        tokens: batch.tokens,
        outcome: passOutcome(applied, blocked, enabled, gate),
    };
    if (canaryEnabled(liveConfig))
        writeCanaryRecord(ctx, session, state, { ...settlement, batch });
    return applied;
}
/**
 * Why this settlement cleared or skipped, in the order the checks ran: the pass
 * either applied, was refused by one named check, was rejected by the host, or
 * never ran because clearing is off (canary armed the gate, or it stayed shut).
 */
function passOutcome(applied, blocked, enabled, gate) {
    if (applied)
        return "cleared";
    if (blocked !== undefined)
        return blocked;
    if (enabled)
        return "rejected";
    return gate ? "canary" : "gate";
}
/**
 * The part of a captured batch a settlement may still act on: nothing a pass
 * ahead of it retired, and nothing touching a key this session refused.
 */
function liveBatchOf(state, batch) {
    const candidates = batch.candidates.filter((candidate) => !state.tracker.isRetired(candidate.blockId) && !candidateRefused(state.auto.reread, candidate));
    if (candidates.length === batch.candidates.length)
        return batch;
    // Keep the withheld count: the ledger line must still say how many blocks the
    // selector held back as unseen, not just how many survived this filter.
    return { ...batch, candidates, tokens: candidates.reduce((total, candidate) => total + Math.max(0, candidate.tokens), 0) };
}
/**
 * One ledger line per boundary: the newly dead blocks plus what the previous
 * clear actually did to the session.
 *
 * A skipped pass re-offers the same candidates at the next boundary; the
 * `reported` set keeps one line per block so repeated skipping cannot bury the
 * decisions under duplicates. The quality block is why a line is also written
 * when no new block died: a clear that the model immediately undoes shows up as
 * a re-read/error after the fact, and a ledger that only recorded proposals
 * could never answer whether clearing helped.
 */
function writeCanaryRecord(ctx, session, state, settlement) {
    // Read the snapshot, then intersect with `reported`: another settlement queued
    // ahead of this one may have logged a block already. The snapshot still decides
    // the line, so a candidate logged once is never logged twice.
    const fresh = settlement.fresh.filter((candidate) => !state.reported.has(candidate.blockId));
    // An empty batch is written even without a fresh candidate or a new outcome:
    // the line is the only evidence that the selector ran and found nothing.
    if (fresh.length === 0 && settlement.batch.candidates.length > 0 && !settlement.dirty)
        return;
    const record = {
        at: Date.now(),
        turn: settlement.where.turn ?? null,
        ...(settlement.where.step !== undefined ? { step: settlement.where.step } : {}),
        tokens: fresh.reduce((total, candidate) => total + candidate.tokens, 0),
        ...(settlement.suffixTokens === undefined ? {} : { suffixTokens: settlement.suffixTokens }),
        candidates: fresh,
        ...(settlement.batch.unseen === undefined ? {} : { unseen: settlement.batch.unseen }),
        gate: settlement.gate,
        ...(state.auto.last !== undefined ? { outcome: state.auto.last.outcome } : {}),
        // The session totals are read here, after the apply this line reports; only
        // the turn counters need the snapshot, because the boundary resets them.
        quality: qualityOf(state, settlement.usage?.tokens ?? 0, settlement.turn),
    };
    try {
        appendPrivateLine(sessionCanaryPath(session.id), JSON.stringify(record));
        for (const candidate of fresh)
            state.reported.add(candidate.blockId);
        state.auto.qualityDirty = false;
    }
    catch (error) {
        ctx.logger?.warn?.(`oh-my-clm: canary log write failed: ${String(error)}`);
    }
}
/** Quality counters, split into this turn's outcomes and the session totals. */
function qualityOf(state, contextTokens, turn) {
    return {
        contextTokens: Math.max(0, Math.round(contextTokens)),
        turn: turn ?? {
            rereads: state.auto.turnRereads,
            errors: state.auto.turnErrors,
            errorRereads: state.auto.turnErrorRereads,
        },
        session: {
            results: state.tracker.resultsSeen,
            clearedBlocks: state.auto.clearedTotal,
            clearedTokens: state.auto.clearedTokens,
            passes: state.auto.passes,
            rereads: state.auto.rereads,
            errors: state.auto.errors,
            errorRereads: state.auto.errorRereads,
        },
    };
}
/** Turn-scoped quality counters are reported once and then start over. */
function resetTurnQuality(state) {
    state.auto.turnRereads = 0;
    state.auto.turnErrors = 0;
    state.auto.turnErrorRereads = 0;
}
/** Remember which target a re-fetch call named, so a later error can be attributed. */
function rememberCallKey(state, callId, name, args) {
    const key = targetKeyOf(name, args);
    if (key !== undefined)
        state.callKeys.set(callId, key);
}
/**
 * Count one tool result's error outcome.
 *
 * `errorRereads` is the sharp quality signal: an error on a target this session
 * cleared means the pointer sent the model back to something that no longer
 * works (a moved file, a stale range). A plain `errors` count is the background
 * rate that makes the first number readable.
 */
function noteToolOutcome(state, callId, isError) {
    const key = state.callKeys.get(callId);
    state.callKeys.delete(callId);
    if (!isError)
        return;
    state.auto.errors += 1;
    state.auto.turnErrors += 1;
    if (key === undefined)
        return;
    if (!state.auto.recent.some((entry) => entry.key === key))
        return;
    state.auto.errorRereads += 1;
    state.auto.turnErrorRereads += 1;
    state.auto.qualityDirty = true;
}
/**
 * Why this pass must not run, or `undefined` to run it.
 *
 * The limits answer different failures: the breaker answers a selector that
 * cleared something live, the missing record seam answers a host that cannot
 * store the decision safely, and the occupancy stop hands the tail of the job
 * to host compaction instead of fighting it. The breaker and the seam latch;
 * occupancy and projection readiness are re-measured every pass.
 *
 * There is deliberately no cumulative-volume cap: while `autoClear.enabled`
 * is true, a healthy session keeps clearing, and only the breaker, the seam or
 * host occupancy can stop it.
 */
function admitClear(state, gate, usage) {
    if (state.auto.stop !== undefined)
        return state.auto.stop;
    if (state.writer.state === "missing")
        return "unrecordable";
    // `pending` is not fatal: the writer is resolved from this session's config
    // after the canary seeds its history, so the first boundary skips the pass.
    if (state.writer.state === "pending")
        return "unavailable";
    // Not latched: the projection is registered once `sessions` is available, so a
    // pass that runs before that is skipped, not fatal.
    if (!state.projection.ready)
        return "unavailable";
    if (!gate)
        return "gate";
    if (usage !== undefined && (usage.tokens / usage.contextWindow) * 100 >= autoClearStopPercent(state.config)) {
        return "occupancy";
    }
    return undefined;
}
/** Append the durable decision that the registered projection interprets. */
function applyClear(ctx, session, state, batch) {
    if (state.writer.state !== "ready")
        return false;
    const seam = state.writer.seam;
    // A bare specifier can resolve to a second copy of `@deepseek-ai/dsh-session`
    // (a hoisted install next to the host). Its `appendPluginRecord` closes over
    // that copy's `Session` private field, so writing through it would throw.
    // Refuse up front and say why, instead of turning the first clear into a
    // mysterious rejection.
    if (seam.owns?.(session) === false) {
        state.auto.stop = "unrecordable";
        ctx.logger?.warn?.("oh-my-clm: the resolved plugin-record seam belongs to a different @deepseek-ai/dsh-session copy; clearing stays off");
        return false;
    }
    const targets = [];
    const retired = [];
    let tokens = 0;
    for (const candidate of batch.candidates) {
        if (!Number.isSafeInteger(candidate.seq) || candidate.seq < 0)
            continue;
        if (candidate.label.length === 0 || candidate.label.length > CLEAR_LABEL_MAX_CHARS)
            continue;
        const size = Math.max(0, Math.round(candidate.tokens));
        // The model-visible text is written with the decision, not derived when the
        // log is read: a replay must reproduce the bytes the model was shown even
        // after this build's wording changes. A pointer past the record bound would
        // throw on replay and take the whole log with it, so an over-long one leaves
        // the block alone instead of writing a record nothing can read back.
        const text = clearPlaceholder(candidate.label, size);
        if (text.length > CLEAR_PLACEHOLDER_MAX_CHARS)
            continue;
        targets.push({
            seq: candidate.seq,
            label: candidate.label,
            tokens: size,
            text,
            // Replay metadata: the projection ignores it, and a resumed session uses
            // it to keep the breaker's re-read evidence.
            ...(candidate.keys.length > 0 ? { keys: candidate.keys } : {}),
        });
        retired.push(candidate.blockId);
        tokens += size;
    }
    if (targets.length === 0)
        return false;
    try {
        // An ignorable plugin record: no surfaceOp, so it adds no model-visible
        // node, and a reader that does not know the type skips it.
        seam.write(session, CLEAR_EVENT_TYPE, { v: CLEAR_VERSION, targets });
    }
    catch (error) {
        ctx.logger?.warn?.(`oh-my-clm: clearing record rejected: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
    // Only a committed decision retires a block; a rejected append leaves the
    // candidates available for the next boundary.
    state.tracker.retire(retired);
    state.auto.passes += 1;
    state.auto.clearedTokens += tokens;
    state.auto.clearedTotal += retired.length;
    const now = state.tracker.resultsSeen;
    for (const candidate of batch.candidates) {
        for (const key of candidate.keys)
            rememberClearedKey(state, key, now);
    }
    pruneRecent(state);
    ctx.logger?.info?.(`oh-my-clm: cleared ${targets.length} block(s) (~${tokens} tokens); the model now reads a re-read pointer`);
    return true;
}
/** Drop breaker evidence older than its window so the list cannot grow with the session. */
function pruneRecent(state) {
    const now = state.tracker.resultsSeen;
    state.auto.recent = state.auto.recent.filter((entry) => now - entry.at <= BREAKER_WINDOW_RESULTS);
}
/**
 * Put one cleared target into the breaker window, keeping one entry per key.
 *
 * The window counts targets, and a batch can clear two dead copies of one target
 * at once. One entry per cleared block would make a single re-fetch count once
 * per copy — refusing the key after one round trip and inflating the rate that
 * latches the session. The latest clear of a key owns its position.
 */
function rememberClearedKey(state, key, at) {
    const index = state.auto.recent.findIndex((entry) => entry.key === key);
    if (index < 0) {
        state.auto.recent.push({ key, at });
        return;
    }
    const existing = state.auto.recent[index];
    if (existing !== undefined && existing.at < at)
        state.auto.recent[index] = { key, at };
}
/**
 * Count a cleared target the model asked for again, and trip the breaker.
 *
 * A re-read is *not* by itself a mistake: the placeholder orders one before an
 * edit, and a file that changed after the clear legitimately needs re-reading.
 * So a plain re-read only moves the ledger. What the breaker watches is refused
 * targets — a key the model came back to a second time, after the re-read it was
 * told to make — and their rate against everything this session cleared. When
 * most cleared targets had to be refused, clearing is manufacturing tool calls
 * instead of removing dead weight, and the session stops clearing. A sample
 * below {@link BREAKER_MIN_REFUSED} is one hot file, not a rate, so it can only
 * refuse itself.
 */
function noteRefetch(ctx, state, name, args) {
    if (state.auto.stop !== undefined)
        return;
    pruneRecent(state);
    if (state.auto.recent.length === 0)
        return;
    const key = targetKeyOf(name, args);
    if (key === undefined)
        return;
    for (const cleared of state.auto.recent) {
        if (cleared.key !== key)
            continue;
        state.auto.rereads += 1;
        state.auto.turnRereads += 1;
        state.auto.qualityDirty = true;
        // One target that keeps coming back is a mispriced target, not a broken
        // selector. Refuse that key, drop its evidence, and leave the channel open
        // for every other block; the session-wide latch is for a rate spread across
        // several keys.
        if (noteKeyReread(state.auto.reread, key)) {
            state.auto.recent = state.auto.recent.filter((entry) => entry.key !== key);
            ctx.logger?.warn?.(`oh-my-clm: not clearing ${key} again this session: it came back ${BREAKER_KEY_REREADS}× after being cleared`);
            // Refused keys are counted here rather than added up from the re-read
            // ledger: `rereads` includes the one re-read the placeholder ordered, so
            // a rate over it fires on compliance. `refused` cannot.
            const total = Math.max(state.auto.clearedTotal, 1);
            const refused = state.auto.reread.refused.size;
            if (refused < BREAKER_MIN_REFUSED || refused * 2 < total)
                return;
            state.auto.stop = "breaker";
            ctx.logger?.warn?.(`oh-my-clm: clearing stopped for this session: ${refused} of ${total} cleared target(s) had to be refused after re-reads`);
            return;
        }
    }
}
/**
 * Register the clearing projection, waiting for the `sessions` service.
 *
 * Without this projection a clearing record would be inert: the model would keep
 * reading the full body while the ledger claimed a clear. So the flag stays
 * false until registration actually succeeded, and clearing stays disabled.
 */
function installClearProjection(ctx, state) {
    const install = (target) => {
        const sessions = optionalService(target, "sessions");
        if (typeof sessions?.registerMessageProjection !== "function")
            return;
        try {
            sessions.registerMessageProjection(clearProjection);
            state.ready = true;
        }
        catch (error) {
            ctx.logger?.warn?.(`oh-my-clm: clearing projection unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    if (typeof ctx.inject === "function") {
        ctx.inject(["sessions"], (injected) => install(injected));
        return;
    }
    install(ctx);
}
/**
 * Build a canary that already knows the session's history.
 *
 * A resumed session reaches the plugin with its log intact, so the selector is
 * fed the recorded tool traffic first and the recorded decisions retire the
 * blocks a previous run already cleared. A recorded turn boundary is skipped on
 * purpose: replaying it would consume candidates the first live boundary has to
 * report, and a boundary that already happened decided nothing in this run.
 */
function seedCanary(ctx, session, projection, config) {
    const state = {
        config,
        tracker: new SupersessionTracker({
            staleTurns: config.autoClear.staleTurns,
            staleSteps: config.autoClear.staleSteps,
            minAgeSteps: config.autoClear.minAgeSteps,
            maxAgeSteps: config.autoClear.maxAgeSteps,
            minResultTokens: config.autoClear.minResultTokens,
            images: config.autoClear.clearImages,
        }),
        callSeqs: new Map(),
        callKeys: new Map(),
        gate: canaryGate(config),
        projection,
        reported: new Set(),
        auto: {
            recent: [],
            clearedTotal: 0,
            clearedTokens: 0,
            passes: 0,
            rereads: 0,
            errors: 0,
            errorRereads: 0,
            turnRereads: 0,
            turnErrors: 0,
            turnErrorRereads: 0,
            qualityDirty: false,
            reread: createRereadPolicy(),
        },
        writer: { state: "pending" },
    };
    const history = session.snapshotEvents?.() ?? [];
    for (const event of history) {
        const seeded = event;
        if (seeded.type === "turn/end")
            continue;
        if (seeded.type === CLEAR_EVENT_TYPE) {
            seedCleared(state, seeded.data);
            continue;
        }
        feedCanary(ctx, session, seeded, state, false);
    }
    return state;
}
/**
 * Replay one recorded decision: retire its targets and carry its cost forward.
 *
 * Without this a resumed session would clear the same block twice (the record is
 * log-only, so the original body is still there) and forget how many tokens it
 * had already freed; the freed total feeds only `/clm` status now that there is
 * no cumulative budget to spend it against.
 */
function seedCleared(state, data) {
    const targets = canaryValue(data, "targets");
    if (!Array.isArray(targets))
        return;
    for (const target of targets) {
        const seq = canaryValue(target, "seq");
        if (typeof seq !== "number")
            continue;
        state.tracker.retireBySeq(seq);
        state.auto.clearedTotal += 1;
        const tokens = canaryValue(target, "tokens");
        if (typeof tokens === "number" && Number.isFinite(tokens))
            state.auto.clearedTokens += Math.max(0, tokens);
        // Put the cleared keys back in the breaker window at the position they had
        // in the log: the seed replays events in order, so a later recorded re-read
        // ages them exactly as it did live.
        const keys = canaryValue(target, "keys");
        if (!Array.isArray(keys))
            continue;
        for (const key of keys) {
            if (typeof key === "string" && key.length > 0)
                rememberClearedKey(state, key, state.tracker.resultsSeen);
        }
    }
    pruneRecent(state);
}
function readText(filePath) {
    try {
        return fs.readFileSync(filePath, "utf8");
    }
    catch {
        return undefined;
    }
}
const fileSystem = { readText, writeText: writePrivateText };
/**
 * Live mode override set by `/clm mode`. The config file can change between
 * requests, but a live override must still A/B-test the index shape without a
 * restart; this field keeps that experiment possible.
 */
const indexModeOverride = {};
/**
 * `digest` lists one line per closed turn and is the default; `blocks` lists
 * individual blocks. `index.mode` in the config file selects the process
 * default, and `/clm mode` selects it for the lifetime of the running process.
 */
function indexMode(config) {
    if (indexModeOverride.value)
        return indexModeOverride.value;
    return config.index.mode;
}
/**
 * The model-visible contract for the live-context index.
 *
 * This section is injected into every request of every session, so each line
 * here is a standing tax on the model's attention. It carries only facts the
 * model cannot get anywhere else: what the index is, that `cleanup` is the
 * preferred way to free window, that the mirror is editable for compression,
 * and what is protected.
 *
 * The mirror path and its editability are in scope because the mirror is the
 * compression interface. Everything else stays out, however useful it sounds:
 * - the `cleanup` API itself (parameters, `ranges`, `skipRoles`, `list`, result
 *   copy). `cleanupParameters` below is the single source of truth; repeating
 *   it here is what previously pushed this section to ~4 KB and made a rare
 *   maintenance tool compete with the user's actual task;
 * - the mirror file format, edit validation, refresh cadence, host-vs-sandbox
 *   `/tmp` differences, and session event ordering: the model has no action for
 *   any of them;
 * - config keys or operational switches.
 *
 * `test/features/live-context/dsh-bridge.test.ts` caps the rendered length, so
 * growth fails the suite instead of silently taxing every request.
 */
function promptText() {
    const mirrorTemplate = `${CLM_TEMP_ROOT}/clm-<session-id>/${CLM_MIRROR_FILENAME}`;
    return dshPromptText({ mirrorTemplate });
}
/**
 * Copy mode for the model-visible cleanup result. The bridge stamps it into its
 * transient result, but the tool strips that host-only field before DSH
 * validates the output; the renderer parses the same config value
 * independently, so both sides stay in sync.
 */
function cleanupResultCopy(config) {
    return parseCleanupResultCopy(config.cleanup.resultMode);
}
/** Process-scoped host Context, like indexModeOverride; set by apply(). */
let activeContext;
/**
 * Read an optional host service.
 *
 * `sessionProjections` stays out of `inject` so the plugin still loads on hosts
 * without it, but Cordis resolves every undeclared service through a proxy that
 * throws `cannot get property "<name>" without inject`. `ctx.get(name)` is the
 * documented inject-free read; older or synthetic contexts that expose the
 * service as a plain property are still supported behind a try/catch, because
 * an absent service must degrade to the `~` estimate, never fail silently.
 */
function optionalService(ctx, name) {
    if (!ctx)
        return undefined;
    if (typeof ctx.get === "function") {
        try {
            return ctx.get(name) ?? undefined;
        }
        catch {
            return undefined;
        }
    }
    try {
        return ctx[name] ?? undefined;
    }
    catch {
        return undefined;
    }
}
const nonNegativeCount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
/**
 * Occupancy from the DSH host's `contextPressure` projection.
 *
 * Do NOT read `tokenUsage`: its wire view is `state.totals`, documented as
 * "durable cumulative provider usage for a complete session log"
 * (`@deepseek-ai/dsh-token-meter/lib/types/projection.d.ts`). Summing its two
 * input buckets counts every prompt of the session, so a 20-turn session on a
 * 1M window reports millions of tokens and 300%+ pressure. Fed into the shrink
 * gate as `beforeTokens`, that number rejects every cleanup - however much it
 * removes - because the calibrated post-edit usage can never drop below the
 * cap. Occupancy is `projectedTokens` (the next request's prompt: provider
 * sample plus the surface's signed delta since it was sampled), with
 * `pressureTokens` (the raw last sample) as the fallback; both are whole
 * values, never sums over the log.
 *
 * No sample yet (or no window) returns undefined, so callers label the
 * estimate `~` instead of passing a cumulative total off as exact.
 */
function hostUsageFor(session, config) {
    const projections = optionalService(activeContext, "sessionProjections");
    if (typeof projections?.snapshot !== "function")
        return undefined;
    let block;
    try {
        block = projections.snapshot(session, ["contextPressure", "sessionStats"]);
    }
    catch {
        return undefined;
    }
    if (typeof block !== "object" || block === null)
        return undefined;
    const values = block.values;
    if (typeof values !== "object" || values === null)
        return undefined;
    const record = values;
    const pressure = record.contextPressure;
    if (typeof pressure !== "object" || pressure === null)
        return undefined;
    const tokens = nonNegativeCount(pressure.projectedTokens) ?? nonNegativeCount(pressure.pressureTokens);
    if (tokens === undefined)
        return undefined;
    const stats = record.sessionStats;
    const windowCandidate = pressure.contextWindow ?? stats?.contextWindow;
    const configuredWindow = config.context.windowTokens;
    const contextWindow = typeof windowCandidate === "number" && windowCandidate > 0
        ? windowCandidate
        : (configuredWindow > 0 ? configuredWindow : undefined);
    if (contextWindow === undefined)
        return undefined;
    return hostUsageOf({ tokens, contextWindow });
}
function optionsFor(session) {
    const sessionId = String(session.id);
    const mirrorPath = sessionMirrorPath(sessionId);
    const config = sessionConfig(session);
    const configuredWindow = config.context.windowTokens;
    return {
        mirrorPath,
        mirrorDisplayPath: mirrorPath,
        maxBlockChars: config.context.maxBlockChars,
        maxMirrorChars: config.context.maxMirrorChars,
        fixedTokens: config.context.fixedTokens,
        hostUsage: hostUsageFor(session, config),
        ...(configuredWindow > 0 ? { contextWindow: configuredWindow } : {}),
        trigger: triggerOptions(config),
        cleanupResult: cleanupResultCopy(config),
        indexMode: indexMode(config),
        autoClear: autoClearEnabled(config),
        refreshSteps: config.index.refreshSteps,
        blockIndex: {
            maxPreviewChars: config.index.previewChars,
            headBlocks: config.index.headBlocks,
            tailBlocks: config.index.tailBlocks,
            maxLines: config.index.maxLines,
        },
    };
}
/**
 * Put the cleanup candidates inside the block index the model already reads, so
 * the confirmation and the IDs it refers to arrive as one payload.
 */
function withCleanupCandidates(index, candidateText) {
    if (!candidateText)
        return index;
    const close = "</oh-my-clm-block-index>";
    const at = index.lastIndexOf(close);
    if (at < 0)
        return `${index}\n${candidateText}`;
    return `${index.slice(0, at)}${candidateText}\n${index.slice(at)}`;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Fold the clearing records in a session log into the marks the index shows.
 *
 * The projection already hides the body from the model; the index must agree
 * with it, or the model sees a preview for content it can no longer read. The
 * map is keyed by the same `dsh:<seq>` id `buildMirrorRecords` assigns.
 */
function clearedMarksOf(session) {
    const marks = new Map();
    // Optional call on purpose: a host built without the log view exposes no
    // `snapshotEvents`, and the index must then simply show original bodies rather
    // than fail and blank the whole block index.
    for (const event of session.snapshotEvents?.() ?? []) {
        if (event.type !== CLEAR_EVENT_TYPE)
            continue;
        const data = event.data;
        if (!isRecord(data) || !Array.isArray(data.targets))
            continue;
        for (const target of data.targets) {
            if (!isRecord(target))
                continue;
            const seq = target.seq;
            const label = target.label;
            const tokens = target.tokens;
            if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0)
                continue;
            if (typeof label !== "string" || label.length === 0)
                continue;
            if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0)
                continue;
            marks.set(`dsh:${seq}`, { label, tokens: Math.round(tokens) });
        }
    }
    return marks;
}
/**
 * Render the current editable block index into DSH's dynamic runtime context.
 * DSH appends this snapshot as a sourced user message, so the same 1-based IDs
 * that `cleanup` accepts are visible in chat context without a mirror read. A
 * failure returns empty text rather than breaking prompt assembly.
 *
 * The usage line and any cleanup candidates ride along with the index: they are
 * computed once per turn boundary (`dshTriggerView`), so the same turn still
 * appends one snapshot instead of one per step.
 *
 * The concrete mirror path belongs here rather than in the static section: the
 * section is registered once per process and could only show the
 * `<session-id>` template, which the model cannot resolve. Keep this prefix to
 * the path alone, so the snapshot stays a stable, cache-friendly header.
 */
function blockIndexContextText(context, states) {
    const session = context.agent?.session;
    if (!session)
        return "";
    try {
        const options = optionsFor(session);
        const state = states.get(String(session.id));
        const cleared = clearedMarksOf(session);
        const index = dshBlockIndexText(session, options, state, options.refreshSteps ?? 4, cleared);
        if (!index)
            return "";
        const { usageLine, candidateText } = dshTriggerView(session, options, state, cleared);
        return `Mirror: ${options.mirrorPath}\n${usageLine}\n${withCleanupCandidates(index, candidateText)}`;
    }
    catch {
        return "";
    }
}
// DSH host packages are peer dependencies, never bundled runtime dependencies.
// Importing `defineTool` from `@deepseek-ai/dsh-tools` would make pnpm install a
// second copy of that host package into the profile, and DSH's in-process tool
// scheduler is identified by a Symbol defined per module copy. With two copies,
// `ctx.tools[TOOL_RUNTIME_SCHEDULER]` is undefined and every model tool call
// fails after `tool/call` is recorded. The registry only needs the plain tool
// definition below, so this plugin keeps no runtime import of DSH packages.
const cleanupParameters = {
    type: "object",
    properties: {
        blockIds: {
            type: "array",
            items: { type: "integer" },
            description: "1-based editable block IDs from the live block index. Use this for individual blocks; IDs renumber after each removal, so pass every target in one call.",
        },
        ranges: {
            type: "array",
            items: { type: "string" },
            description: "Inclusive ID ranges such as \"3-16\" or \"42\". Prefer one range for a whole turn. A range that runs past the current surface clamps, and block 1 is preserved.",
        },
        skipRoles: {
            type: "array",
            items: { type: "string", enum: ["user", "assistant", "toolResult", "custom"] },
            description: "Roles to keep even when a requested range covers them; use [\"user\"] to drop a turn's tool noise but keep the human message.",
        },
        offload: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    blockId: { type: "integer", minimum: 1 },
                    note: { type: "string", minLength: 1, maxLength: 240 },
                },
                required: ["blockId", "note"],
                additionalProperties: false,
            },
            description: "Keep a block in place and replace its body with `[offloaded: <note>]`, a shorter line you write. Use it when the block's fact still matters; the placeholder must shrink the block. assistant and toolResult blocks only; block 1 and user blocks cannot be offloaded.",
        },
        list: {
            type: "string",
            description: "Read-only: return the rows of this inclusive ID range (\"3-16\" or \"42\") without removing anything. Use it to inspect a range the index named but did not list. Cannot be combined with blockIds, ranges, skipRoles, or offload.",
        },
    },
    additionalProperties: false,
};
/**
 * The declared output is the tool's model-visible contract: DSH validates the
 * returned body value against it and rejects any undeclared property because
 * of `additionalProperties: false`, so host-only rendering state (the cleanup
 * copy mode) must not ride along in the returned object.
 */
const cleanupOutputSchema = {
    type: "object",
    properties: {
        status: { type: "string", enum: ["applied", "rejected", "listed"] },
        requestedBlockIds: { type: "array", items: { type: "integer" } },
        removedBlockIds: { type: "array", items: { type: "integer" } },
        pairedRemovalIds: { type: "array", items: { type: "integer" } },
        offloadedBlockIds: { type: "array", items: { type: "integer" } },
        reason: { type: "string" },
        blockIndex: { type: "string" },
        rows: { type: "string" },
    },
    required: ["status", "requestedBlockIds", "removedBlockIds", "pairedRemovalIds", "reason"],
    additionalProperties: false,
};
function createDshCleanupTool(getState) {
    // The tool's value is validated against `cleanupOutputSchema` with
    // `additionalProperties: false`, so the host-only copy mode cannot ride in the
    // returned object. Keep it beside the value instead; the render callback
    // receives that same object.
    const renderCopy = new WeakMap();
    return {
        name: "cleanup",
        description: "Remove stale CLM context blocks by ID range or by individual ID from the live block index without reading or reconstructing their bodies, keep one with a shorter `[offloaded: <note>]` body, or list the rows of a range (read-only) to identify targets the index only named.",
        parameters: cleanupParameters,
        output: {
            schema: cleanupOutputSchema,
            render: (_args, value) => [
                {
                    type: "text",
                    text: formatCleanupToolResult(value, (typeof value === "object" && value !== null ? renderCopy.get(value) : undefined) ?? "compact"),
                },
            ],
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const parsed = parseCleanupArgs(args);
            if (!parsed.ok)
                throw new Error(parsed.reason);
            // The shared bridge intentionally models only the public append/surface
            // subset; DSH's concrete Session carries branded sequence types that are
            // erased at this host boundary.
            const session = exec.agent?.session;
            if (!session)
                throw new Error("cleanup requires an active DSH agent session.");
            const result = await executeDshCleanup(session, parsed.args, optionsFor(session), fileSystem, getState(String(session.id)));
            // `copy` steers how much text output.render emits. It is host-side
            // rendering state, not tool-output data, so keep it out of the value
            // DSH snapshots and validates against cleanupOutputSchema.
            const { copy, ...output } = result;
            if (typeof copy === "string")
                renderCopy.set(output, copy);
            return output;
        },
    };
}
const CLM_COMMAND_USAGE = "Usage: /clm [status | mode [blocks|digest|auto]]";
/** Compare the on-disk mirror with the projection the bridge would write now. */
function mirrorStateText(current, canonical) {
    if (current === undefined)
        return "missing (written on the next bridge pass)";
    if (current === canonical)
        return "in sync";
    return "differs from the current projection (pending edit or stale)";
}
/**
 * Human-readable status for the active DSH session. Everything is derived from
 * the session surface and the canonical mirror projection; no state is cached,
 * so `/clm status` is accurate even before the first bridge pass.
 */
function dshStatusText(session, options) {
    const records = buildDshMirrorRecords(session, options);
    const editable = records.filter((record) => !record.protected);
    const canonicalText = renderMirror(records);
    const fixedTokens = options.fixedTokens ?? 0;
    const canonicalTokens = estimateMirrorTokens(editable);
    const previewTokens = estimateMirrorTokens(editable, (record) => record.renderText ?? record.text);
    // The mirror is the editing surface and keeps every body; the request is not.
    // A cleared target is a one-line pointer the model reads instead, so deduct it
    // exactly as the usage line and the block digest do. Otherwise this estimate
    // prices bodies the model can no longer read.
    const cleared = clearedMarksOf(session);
    const clearedTokens = editable.reduce((total, record) => total + (cleared.get(record.id)?.tokens ?? 0), 0);
    const requestTokens = Math.max(0, fixedTokens + canonicalTokens - clearedTokens);
    const clearedNote = clearedTokens > 0 ? ` - cleared ~${clearedTokens}` : "";
    return [
        "oh-my-clm status (DSH)",
        `session: ${String(session.id)}`,
        `mirror: ${options.mirrorPath}`,
        `mirror state: ${mirrorStateText(readText(options.mirrorPath), canonicalText)}`,
        `mirror bytes: ${Buffer.byteLength(canonicalText, "utf8")}`,
        `editable blocks: ${editable.length}`,
        `protected blocks: ${records.length - editable.length}`,
        `mirror preview: ~${previewTokens} tokens; canonical editable: ~${canonicalTokens} tokens`,
        `estimated request: ~${requestTokens} tokens (fixed request ~${fixedTokens} + editable mirror ~${canonicalTokens}${clearedNote})`,
        options.hostUsage
            ? `DSH projectedTokens: ${options.hostUsage.tokens}/${options.hostUsage.contextWindow} tokens (contextPressure occupancy; host-exact, the 3.5 chars/token estimate is used only for the edit delta)`
            : "DSH projectedTokens: unavailable; the shrink gate falls back to the ~ estimate",
        `DSH surface nodes: ${session.surface.nodes.length}`,
        `block index: ${options.indexMode ?? "blocks"}`,
        "edit policy: shrink-only",
        `mirror limits: ${options.maxBlockChars ?? 12_000} chars/block, ${options.maxMirrorChars ?? 96_000} chars total`,
    ].join("\n");
}
/** One status line for `/clm`, so the user can see what clearing did. */
function autoClearStatusText(state) {
    if (state === undefined) {
        return "auto-clear: not armed (set autoClear.canary to record decisions; autoClear.enabled also clears)";
    }
    // The mid-turn switch is a separate decision from the turn-boundary pass, and
    // a status line that hid it would make a silent `0` look like a broken gate.
    const midTurn = state.config.autoClear.midTurnSuffixTokens > 0
        ? `mid-turn ≤${state.config.autoClear.midTurnSuffixTokens} tok tail`
        : "mid-turn off";
    // Four zeroes are one fact unless the line says which check stopped the last
    // settlement: no candidate, the gate, occupancy, the seam, or the breaker.
    const last = state.auto.last;
    // A refused key is a per-target stop, so the line has to name it: otherwise a
    // block that is never cleared again looks like a selector that missed it.
    const refused = state.auto.reread.refused.size > 0
        ? ` · ${state.auto.reread.refused.size} key(s) refused after re-reads`
        : "";
    const lastText = last === undefined
        ? "last: none"
        : `last: ${last.outcome} (turn ${String(last.turn ?? "?")}, ${last.candidates} candidate(s), ~${last.tokens} tok)`;
    if (!state.config.autoClear.enabled) {
        const stop = state.auto.stop === undefined ? "open" : `stopped (${state.auto.stop})`;
        const mode = canaryEnabled(state.config) ? "canary only" : "off";
        return `auto-clear: ${mode} · ${midTurn} · ${state.auto.passes} pass(es) · ~${state.auto.clearedTokens} tokens cleared · ${stop} · ${state.auto.rereads} re-read(s) · ${state.auto.errorRereads} error re-read(s)${refused} · ${lastText}`;
    }
    const armed = state.writer.state === "missing"
        ? "off: this host exposes no ignorable plugin-record seam"
        : state.writer.state === "pending"
            ? "starting: resolving the host record seam"
            : state.projection.ready ? "armed" : "armed, no projection";
    const stop = state.auto.stop === undefined ? "open" : `stopped (${state.auto.stop})`;
    return `auto-clear: ${armed} · ${midTurn} · ${state.auto.passes} pass(es) · ~${state.auto.clearedTokens} tokens cleared · ${stop} · ${state.auto.rereads} re-read(s) · ${state.auto.errorRereads} error re-read(s)${refused} · ${lastText}`;
}
function createDshClmCommand(onModeChange, autoStatus) {
    return {
        name: "clm",
        description: "Show the oh-my-clm live context status or switch the index mode",
        input: { hint: "status | mode [blocks|digest|auto]" },
        handler: (invocation) => {
            const input = invocation.rawInput.trim();
            const session = invocation.agent?.session;
            const config = session ? sessionConfig(session) : loadClmConfig(process.cwd()).config;
            if (input.startsWith("mode")) {
                const requested = input.slice(4).trim();
                if (requested === "") {
                    const current = indexMode(config);
                    const source = indexModeOverride.value ? "process override" : `config index.mode=${config.index.mode}`;
                    return { kind: "success", text: `oh-my-clm index mode: ${current} (${source})` };
                }
                if (requested !== "blocks" && requested !== "digest" && requested !== "auto") {
                    return { kind: "error", text: CLM_COMMAND_USAGE };
                }
                indexModeOverride.value = requested === "auto" ? undefined : requested;
                onModeChange(indexMode(config));
                return {
                    kind: "success",
                    text: requested === "auto"
                        ? `oh-my-clm index mode: ${indexMode(config)} (auto; follows index.mode in the config file, default digest).`
                        : `oh-my-clm index mode: ${requested}. The next step re-renders the block index; this override lasts until the process restarts (set index.mode in .oh-my-clm.json to persist it, or /clm mode auto to drop it).`,
                };
            }
            if (input.length > 0 && input !== "status") {
                return { kind: "error", text: CLM_COMMAND_USAGE };
            }
            if (!session) {
                return { kind: "error", text: "oh-my-clm: the active DSH agent has no session." };
            }
            try {
                const status = dshStatusText(session, optionsFor(session));
                const extra = autoStatus?.(String(session.id));
                return { kind: "success", text: extra ? `${status}\n${extra}` : status };
            }
            catch (error) {
                return {
                    kind: "error",
                    text: `oh-my-clm: could not render status: ${error instanceof Error ? error.message : String(error)}`,
                };
            }
        },
    };
}
function logResult(ctx, result) {
    if (result.status === "applied") {
        const tokenNote = result.beforeTokens !== undefined && result.afterTokens !== undefined
            ? ` (~${result.beforeTokens} -> ~${result.afterTokens} estimated mirror tokens)`
            : "";
        ctx.logger?.info?.(`oh-my-clm: DSH mirror edit applied through Session.append surface replacement${tokenNote}`);
    }
    else if (result.status === "rejected") {
        ctx.logger?.warn?.(`oh-my-clm: DSH mirror edit rejected: ${result.reason ?? "invalid edit"}`);
    }
}
function reconcile(ctx, session, state) {
    try {
        logResult(ctx, reconcileDshMirror(state, session, fileSystem, optionsFor(session)));
    }
    catch (error) {
        ctx.logger?.warn?.(`oh-my-clm: mirror bridge unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * DSH publishes `session/event` observers synchronously from Session.append()
 * while the append is still marked as active. Queue the bridge pass so a
 * native replacement never attempts to re-enter the append that announced the
 * event. `step/start` is the first point in a new step at which DSH accepts a
 * step-scoped developer/message replacement, so the queue is drained there
 * rather than from `agent/pre-step`, which still runs before `step/start`.
 */
function enqueueReconcile(ctx, session, state, queues, isActive) {
    const previous = queues.get(state) ?? Promise.resolve();
    const run = () => new Promise((resolve) => queueMicrotask(resolve)).then(() => {
        if (isActive())
            reconcile(ctx, session, state);
    });
    const next = previous.then(run, run);
    queues.set(state, next);
    void next.then(() => {
        if (queues.get(state) === next)
            queues.delete(state);
    }, () => {
        if (queues.get(state) === next)
            queues.delete(state);
    });
    return next;
}
/**
 * DSH host entry. The bridge deliberately uses only public Cordis lifecycle
 * surfaces, the dedicated cleanup tool seam, and ordinary filesystem I/O; it
 * does not duplicate the DSH tool matrix or write unknown session events.
 */
export function apply(ctx) {
    activeContext = ctx;
    const states = new Map();
    const queues = new WeakMap();
    const canaries = new Map();
    const projection = { ready: false };
    installClearProjection(ctx, projection);
    // A selector captures config when it is seeded. Rebuild it on a config
    // change, retaining the live accounting, breaker and per-turn allowance.
    // Keep a disabled runtime tracking traffic so re-enabling cannot erase the
    // evidence that a cleared target was needed again while clearing was off.
    const refreshCanary = async (session, config) => {
        const key = String(session.id);
        const previous = canaries.get(key);
        if (previous && JSON.stringify(previous.config) === JSON.stringify(config))
            return;
        if (!previous && !canaryEnabled(config) && !autoClearEnabled(config))
            return;
        const seeded = seedCanary(ctx, session, projection, config);
        const canary = previous ? {
            ...seeded,
            auto: previous.auto,
            reported: previous.reported,
            midTurnTurn: previous.midTurnTurn,
            writer: previous.config.host.pluginRecordModule === config.host.pluginRecordModule
                ? previous.writer
                : { state: "pending" },
        } : seeded;
        if (previous)
            previous.disposed = true;
        canaries.set(key, canary);
        if (!autoClearEnabled(config) || canary.writer.state !== "pending")
            return;
        const seam = await resolvePluginRecordWriter(config.host.pluginRecordModule);
        if (canary.disposed || canaries.get(key) !== canary)
            return;
        canary.writer = seam ? { state: "ready", seam } : { state: "missing" };
        if (!seam) {
            if (canary.auto.stop !== "breaker")
                canary.auto.stop = "unrecordable";
            ctx.logger?.warn?.(`oh-my-clm: autoClear.enabled is set but ${config.host.pluginRecordModule} exposes no appendPluginRecord seam; clearing stays off for session ${key}`);
        }
        else if (canary.auto.stop === "unrecordable") {
            delete canary.auto.stop;
        }
    };
    ctx.effect?.(() => () => {
        states.clear();
        for (const canary of canaries.values())
            canary.disposed = true;
        canaries.clear();
        if (activeContext === ctx)
            activeContext = undefined;
    }, "oh-my-clm.state");
    ctx.systemPrompt?.section({
        name: PROMPT_SECTION,
        order: ctx.systemPrompt.getSectionOrder?.("TOOL_EDIT") ?? DEFAULT_ORDER,
        text: promptText(),
    });
    if (ctx.systemPrompt?.context) {
        ctx.systemPrompt.context({
            name: BLOCK_INDEX_CONTEXT,
            order: BLOCK_INDEX_ORDER,
            text: (context) => blockIndexContextText(context, states),
        });
    }
    else {
        ctx.logger?.warn?.("oh-my-clm: DSH systemPrompt.context unavailable; block IDs will not be shown in chat context");
    }
    if (ctx.tools) {
        // The official DSH tools registry owns this registration as a Cordis
        // effect; it is removed with the plugin fiber.
        ctx.tools.register(createDshCleanupTool((sessionId) => states.get(sessionId)));
    }
    else {
        ctx.logger?.warn?.("oh-my-clm: DSH tools runtime unavailable; cleanup tool was not registered");
    }
    if (ctx.commands) {
        // `/clm` mirrors the Pi extension's status command. The command registry
        // owns the definition as a Cordis effect, so it is removed with the plugin.
        ctx.commands.register(createDshClmCommand(() => {
            // Mode changes the rendered index; every cached preview is now wrong.
            for (const state of states.values())
                state.blockIndex = undefined;
        }, (sessionId) => autoClearStatusText(canaries.get(sessionId))));
    }
    else {
        ctx.logger?.warn?.("oh-my-clm: DSH commands runtime unavailable; /clm was not registered");
    }
    ctx.on("agent/created", async ({ agent }) => {
        const session = agent.session;
        if (!session) {
            ctx.logger?.warn?.("oh-my-clm: agent has no session; DSH bridge is inactive for it");
            return;
        }
        const state = {};
        // State is session-scoped: the cleanup tool and the block-index context
        // both look it up by session id, and a subagent's agent id need not match.
        const key = String(session.id);
        states.set(key, state);
        const loaded = loadClmConfig(typeof session.header?.cwd === "string" ? session.header.cwd : process.cwd());
        const config = loaded.config;
        for (const warning of loaded.warnings)
            ctx.logger?.warn?.(`oh-my-clm: ${warning}`);
        // This listener is async and the host does not await it, so an exception
        // here would surface as an unhandled rejection instead of a broken session.
        // Failing to arm clearing only costs the optimisation, never the transcript.
        try {
            await refreshCanary(session, config);
        }
        catch (error) {
            ctx.logger?.warn?.(`oh-my-clm: live-context clearing could not be armed for session ${key}: ${error instanceof Error ? error.message : String(error)}`);
        }
        const agentContext = agent.ctx ?? ctx;
        const disposePreStep = agentContext.on("agent/pre-step", async (_payload, next) => {
            await refreshCanary(session, sessionConfig(session));
            // agent/pre-step runs before step/start, so DSH is not accepting a
            // step-scoped developer/message replacement yet. A mutation there
            // would fail validation or, worse, commit an event whose turn/step
            // does not match the log's open step. Leave pending mirror edits
            // to the step/start observer below, which runs with the new step
            // open, and keep this hook for convergence only.
            if (dshOpenTurnStep(session))
                await enqueueReconcile(ctx, session, state, queues, () => states.get(key) === state);
            return next();
        });
        // The agent context owns the listener, while this effect also makes the
        // plugin's disposer explicit when a profile unloads first.
        ctx.effect?.(() => disposePreStep, `oh-my-clm.agent(${key})`);
    });
    ctx.on("session/event", (session, event) => {
        const key = String(session.id);
        const canary = canaries.get(key);
        if (canary !== undefined)
            feedCanary(ctx, session, event, canary);
        const state = states.get(key);
        if (!state)
            return;
        // Wait for a completed tool result (or a new user message) so a model
        // edit made by a tool is checked against the pre-step snapshot rather
        // than a half-settled assistant tool-call node. step/start also flushes
        // an edit that agent/pre-step had to defer because no step was open.
        if (event?.type === "tool/result" || event?.type === "user/message" || event?.type === "step/start") {
            void enqueueReconcile(ctx, session, state, queues, () => states.get(key) === state);
            return;
        }
        // A clearing record changes the projection and the index, but it is not a
        // surface edit, so neither reconcile nor the compaction branch sees it.
        if (event?.type === CLEAR_EVENT_TYPE) {
            state.blockIndex = undefined;
            state.trigger = undefined;
            return;
        }
        // Compaction rewrites the surface and can renumber editable IDs without
        // going through cleanup or a mirror edit.
        if (typeof event?.type === "string" && event.type.includes("compaction")) {
            state.blockIndex = undefined;
            state.trigger = undefined;
        }
    });
    ctx.on("agent/disposed", ({ agent }) => {
        const key = String(agent.session?.id ?? agent.id);
        states.delete(key);
        const canary = canaries.get(key);
        if (canary !== undefined)
            canary.disposed = true;
        canaries.delete(key);
    });
}
/**
 * Required services only. `sessionProjections` is deliberately absent so the
 * plugin still activates on hosts without @deepseek-ai/dsh-session-projection;
 * it is read through `ctx.get()` (see `optionalService`), never as a property,
 * because Cordis throws on undeclared service reads.
 */
export const inject = ["systemPrompt", "tools", "commands"];
