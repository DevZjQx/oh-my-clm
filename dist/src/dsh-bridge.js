import { CLM_MIRROR_FILENAME } from "./clm-paths.js";
import { cleanupMirrorForRecords, cleanupToolResult, planCleanup, } from "./context-cleanup.js";
import { buildMirrorRecords, DEFAULT_MAX_BLOCK_CHARS, DEFAULT_MAX_MIRROR_CHARS, estimateMessageTokens, estimateMirrorTokens, mirrorSignature, parseMirror, planContextEdits, renderBlockIndex, renderMirror, } from "./context-format.js";
/** The DSH-facing mirror filename deliberately matches the Pi adapter. */
export const DSH_MIRROR_FILENAME = CLM_MIRROR_FILENAME;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function messageForEvent(event) {
    if (event.type === "user/message")
        return isRecord(event.data) ? event.data : undefined;
    if (!isRecord(event.data))
        return undefined;
    const message = event.data.message;
    return isRecord(message) ? message : undefined;
}
function isSurfaceMessageEvent(type) {
    return type === "system/message"
        || type === "developer/message"
        || type === "user/message"
        || type === "assistant/message"
        || type === "tool/result";
}
/**
 * Adapt DSH's event-sourced surface to the format layer's provenance shape.
 * The adapter does not fold the session itself: `surface.nodes` and
 * `snapshotEvents()` are the host-owned log and projection views.
 *
 * DSH projects its own dynamic runtime-context facts (sandbox/approval policy,
 * this bridge's block index, and any other contributor) as sourced user
 * messages. They are neither user-authored conversation nor cleanup targets, so
 * they are omitted here. Keeping them out also prevents the block index from
 * listing itself and growing on every step.
 */
export function buildDshProjectionEntries(session) {
    const events = new Map(session.snapshotEvents().map((event) => [event.seq, event]));
    const entries = [];
    for (const seq of session.surface.nodes) {
        const event = events.get(seq);
        if (!event || !isSurfaceMessageEvent(event.type))
            continue;
        const message = messageForEvent(event);
        if (!message)
            continue;
        const source = message.source;
        if (isRecord(source) && source.kind === "runtime-context")
            continue;
        entries.push({
            sourceEntry: { id: `dsh:${String(seq)}`, type: "message" },
            messages: [message],
        });
    }
    return entries;
}
/** Build the canonical mirror records for one DSH surface. */
export function buildDshMirrorRecords(session, options) {
    return buildMirrorRecords(buildDshProjectionEntries(session), {
        mirrorPath: options.mirrorDisplayPath ?? options.mirrorPath,
        maxBlockChars: options.maxBlockChars ?? DEFAULT_MAX_BLOCK_CHARS,
        maxMirrorChars: options.maxMirrorChars ?? DEFAULT_MAX_MIRROR_CHARS,
    });
}
/**
 * Render the chat-context block index for one DSH session. This is the same
 * ordinal space the cleanup tool accepts, so the model never needs to open the
 * mirror just to discover IDs or identify a block.
 */
export function renderDshBlockIndex(session, options) {
    return renderBlockIndex(buildDshMirrorRecords(session, options));
}
function sequenceFromRecordId(id) {
    if (!id.startsWith("dsh:"))
        return undefined;
    const value = Number(id.slice(4));
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function nextSessionSequence(session) {
    if (typeof session.seq === "number" && Number.isSafeInteger(session.seq) && session.seq >= 0) {
        return session.seq;
    }
    const events = session.snapshotEvents();
    return events.reduce((next, event) => Math.max(next, event.seq + 1), 0);
}
function mutationMessageId(session, targetSeq, role) {
    return `oh-my-clm:${session.id}:context-edit:${nextSessionSequence(session)}:${role}:${targetSeq}`;
}
function replacementContent(edit) {
    const content = edit.replacement?.content;
    return Array.isArray(content) ? content : undefined;
}
function fixedTokens(options) {
    return typeof options.fixedTokens === "number"
        && Number.isFinite(options.fixedTokens)
        && options.fixedTokens >= 0
        ? Math.ceil(options.fixedTokens)
        : 0;
}
function actionMessage(record, action) {
    if (action.replacement === null)
        return undefined;
    const content = replacementContent(action);
    if (!content)
        return undefined;
    const source = record.sourceMessage;
    if (!isRecord(source))
        return undefined;
    return { ...source, content };
}
function estimateAfterMutation(records, actions) {
    return records.reduce((total, record) => {
        const action = actions.get(record.id);
        if (action?.replacement === null)
            return total;
        if (!action)
            return total + estimateMirrorTokens([record]);
        const message = actionMessage(record, action);
        return total + (message ? estimateMessageTokens(message) : estimateMirrorTokens([record]));
    }, 0);
}
function rejectMutation(reason, beforeTokens, afterTokens) {
    return { status: "rejected", reason, beforeTokens, afterTokens };
}
function positiveSafeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
/**
 * Fold the open turn/step from a log snapshot.
 *
 * DSH validates a `developer/message` as a *step* event: its `turn` and `step`
 * must be positive and must name the turn/step that is open at the append
 * position. They are not coordinates copied from the node being shadowed. A
 * cleanup can replace nodes that belong to several older steps while the tool
 * itself runs in the current step, so every replacement must use the current
 * open pair. User messages have no turn/step envelope at all, which is why the
 * previous implementation fell back to `0` and produced the format error
 * `developer/message turn must be positive`.
 */
function openTurnStepFromEvents(events) {
    let turn;
    let step;
    for (const event of events) {
        if (!isRecord(event) || typeof event.type !== "string")
            continue;
        const data = isRecord(event.data) ? event.data : undefined;
        switch (event.type) {
            case "turn/start":
                turn = positiveSafeInteger(data?.turn) ? data.turn : undefined;
                step = undefined;
                break;
            case "turn/end":
                turn = undefined;
                step = undefined;
                break;
            case "step/start":
                step = turn !== undefined && positiveSafeInteger(data?.step) ? data.step : undefined;
                break;
            case "step/end":
                step = undefined;
                break;
            default:
                break;
        }
    }
    return turn !== undefined && step !== undefined ? { turn, step } : undefined;
}
/**
 * Return the turn/step DSH is currently accepting step events for, or
 * undefined outside an open step (for example inside `agent/pre-step`, which
 * runs before `step/start`).
 */
export function dshOpenTurnStep(session) {
    if (!session || typeof session.snapshotEvents !== "function")
        return undefined;
    return openTurnStepFromEvents(session.snapshotEvents());
}
/**
 * Append an empty developer node that replaces one current surface node.
 * DSH deliberately keeps the replacement node in the append-only surface, but
 * empty developer messages derive to no LLM message, which gives omission the
 * same active-history effect as Pi's `context_edit: replacement=null`.
 */
function appendOmission(session, targetSeq, coordinates) {
    session.append("developer/message", {
        turn: coordinates.turn,
        step: coordinates.step,
        message: {
            id: mutationMessageId(session, targetSeq, "omit"),
            role: "developer",
            content: [],
            source: { kind: "user" },
        },
    }, {
        surfaceOp: { op: "replace", startSeq: targetSeq, endSeq: targetSeq },
        sourceEventSeqs: [targetSeq],
    });
}
/**
 * Build one DSH-native replacement from a mirror edit.
 *
 * DSH validates every surface replacement by requiring `sourceEventSeqs` to
 * name all shadowed nodes, but `assistant/message` is explicitly forbidden from
 * carrying `sourceEventSeqs` because it embeds its provider stream. An assistant
 * node therefore cannot be rewritten in place as another assistant message:
 * the seam only allows a same-shape `tool/result` content rewrite or a
 * `developer/message` replacement. Assistant edits keep the original turn/step
 * envelope but are materialized as a developer message with the shortened text;
 * edited content is intentionally not an original model response. Omission of an
 * assistant node uses the same developer event with empty content.
 */
function appendContentReplacement(session, record, event, action, targetSeq, coordinates) {
    const content = replacementContent(action);
    if (!content)
        throw new Error(`edit ${record.id} has no structured replacement content`);
    const data = isRecord(event.data) ? event.data : undefined;
    const message = messageForEvent(event);
    if (!data || !message)
        throw new Error(`current DSH event ${targetSeq} has no message payload`);
    if (record.role === "assistant") {
        const source = message.source;
        if (!isRecord(source)
            || source.kind !== "model"
            || typeof source.provider !== "string"
            || source.provider.length === 0
            || typeof source.model !== "string"
            || source.model.length === 0) {
            throw new Error(`assistant event ${targetSeq} has no valid model source`);
        }
        session.append("developer/message", {
            turn: coordinates.turn,
            step: coordinates.step,
            message: {
                id: mutationMessageId(session, targetSeq, "developer"),
                role: "developer",
                content,
                source: { kind: "user" },
            },
        }, {
            surfaceOp: { op: "replace", startSeq: targetSeq, endSeq: targetSeq },
            sourceEventSeqs: [targetSeq],
        });
        return;
    }
    if (record.role === "toolResult") {
        if (event.type !== "tool/result")
            throw new Error(`tool result record ${record.id} is not a tool/result event`);
        // DSH validates tool/result replacements as content-only rewrites:
        // every other field, including the original turn/step envelope, must be
        // byte-for-byte unchanged. Only the content array may differ.
        session.append("tool/result", {
            ...data,
            message: { ...message, content },
        }, {
            surfaceOp: { op: "replace", startSeq: targetSeq, endSeq: targetSeq },
            sourceEventSeqs: [targetSeq],
        });
        return;
    }
    throw new Error(`DSH user/custom record ${record.id} cannot be rewritten by this bridge`);
}
/**
 * Apply a validated mirror plan through DSH's public Session mutation seam.
 *
 * The seam is `Session.append(surfaceEvent, data, { surfaceOp: { op:
 * 'replace', ... }, sourceEventSeqs })`. It is the same append-only
 * replacement primitive used by DSH compaction and tool-result pruning; the
 * original events remain in the log while the current surface and
 * `deriveMessages()` change immediately. Every replacement cites each shadowed
 * node: `tool/result` keeps its shape and changes only content, while
 * `developer/message` carries omissions (empty content) and rewritten assistant
 * text, since `assistant/message` cannot carry `sourceEventSeqs`. No custom
 * event or proposal file is involved.
 */
export function applyDshContextEdits(session, plan, records, options) {
    if (plan.status !== "applied")
        return rejectMutation("Only an applied edit plan can mutate a DSH session.");
    if (typeof session.append !== "function") {
        return rejectMutation("The active DSH session does not expose Session.append; refusing a mirror-only fallback.");
    }
    const snapshotEvents = session.snapshotEvents();
    const events = new Map(snapshotEvents.map((event) => [event.seq, event]));
    const currentSurface = new Set(session.surface.nodes);
    const coordinates = openTurnStepFromEvents(snapshotEvents);
    if (!coordinates) {
        return rejectMutation("The DSH session has no open step; developer/message replacements require an open turn/step and must be retried after step/start.");
    }
    const recordsById = new Map(records.map((record) => [record.id, record]));
    const actions = new Map();
    for (const edit of plan.edits) {
        const record = recordsById.get(edit.targetId);
        if (!record)
            return rejectMutation(`The DSH surface changed before edit ${edit.targetId} could be applied.`);
        if (record.protected)
            return rejectMutation(`Protected DSH record ${edit.targetId} cannot be mutated.`);
        if (edit.replacement !== null && !replacementContent(edit)) {
            return rejectMutation(`DSH edit ${edit.targetId} does not contain structured message content.`);
        }
        actions.set(edit.targetId, edit);
    }
    const byToolCallId = new Map();
    const byResultCallId = new Map();
    for (const record of records) {
        for (const callId of record.toolCallIds)
            byToolCallId.set(callId, record);
        if (record.role === "toolResult" && record.toolCallId)
            byResultCallId.set(record.toolCallId, record);
    }
    const omit = (record, reason) => {
        if (record.protected)
            return rejectMutation(`Protected DSH record ${record.id} cannot be omitted: ${reason}`);
        const existing = actions.get(record.id);
        if (existing?.replacement === null)
            return undefined;
        actions.set(record.id, { targetId: record.id, replacement: null, reason: "omit" });
        return undefined;
    };
    // Match the shared Pi policy: no edited assistant tool call may leave a
    // current result behind, and no omitted result may leave its owner behind.
    for (const record of records) {
        const action = actions.get(record.id);
        if (record.role !== "assistant" || !action)
            continue;
        for (const callId of record.toolCallIds) {
            const result = byResultCallId.get(callId);
            if (!result) {
                return rejectMutation(`Cannot mutate assistant ${record.id} while tool call ${callId} has no current result; retry after the tool step settles.`);
            }
            const failure = omit(result, `assistant tool call ${callId} was rewritten`);
            if (failure)
                return failure;
        }
    }
    for (const record of records) {
        const action = actions.get(record.id);
        if (record.role !== "toolResult" || action?.replacement !== null || !record.toolCallId)
            continue;
        const owner = byToolCallId.get(record.toolCallId);
        if (!owner || actions.has(owner.id))
            continue;
        const failure = omit(owner, `tool result ${record.id} was omitted`);
        if (failure)
            return failure;
    }
    for (const record of records) {
        const action = actions.get(record.id);
        if (record.role !== "assistant" || action?.replacement !== null)
            continue;
        for (const callId of record.toolCallIds) {
            const result = byResultCallId.get(callId);
            if (result) {
                const failure = omit(result, `assistant ${record.id} was omitted`);
                if (failure)
                    return failure;
            }
        }
    }
    const before = fixedTokens(options) + estimateMirrorTokens(records);
    const after = fixedTokens(options) + estimateAfterMutation(records, actions);
    if (after >= before) {
        return rejectMutation("A DSH surface mutation must SHRINK context; replace stale text with a shorter summary instead.", before, after);
    }
    // Resolve every target before the first append. Cleanup is intentionally a
    // preflighted batch so a stale surface cannot cause a partial omission.
    const targets = new Map();
    for (const record of records) {
        const action = actions.get(record.id);
        if (!action)
            continue;
        const targetSeq = sequenceFromRecordId(record.id);
        if (targetSeq === undefined || !currentSurface.has(targetSeq)) {
            return rejectMutation(`DSH surface no longer contains edit target ${record.id}.`);
        }
        const event = events.get(targetSeq);
        if (!event)
            return rejectMutation(`DSH event ${targetSeq} for ${record.id} is unavailable.`);
        targets.set(record.id, { targetSeq, event });
    }
    for (const record of records) {
        const action = actions.get(record.id);
        const target = targets.get(record.id);
        if (!action || !target)
            continue;
        if (action.replacement === null) {
            appendOmission(session, target.targetSeq, coordinates);
        }
        else {
            appendContentReplacement(session, record, target.event, action, target.targetSeq, coordinates);
        }
    }
    return { status: "applied", beforeTokens: before, afterTokens: after };
}
/**
 * Execute the DSH-native cleanup tool without reading or writing the mirror.
 * The active session surface is the source of truth; the bridge will render a
 * fresh canonical mirror after the tool result settles.
 */
export function executeDshCleanup(session, blockIds, options, io, state) {
    const records = buildDshMirrorRecords(session, options);
    const plan = planCleanup(records, cleanupMirrorForRecords(records), blockIds, { fixedTokens: options.fixedTokens });
    if (plan.status !== "applied") {
        return cleanupToolResult(plan, renderBlockIndex(records));
    }
    try {
        const mutation = applyDshContextEdits(session, plan, records, options);
        if (mutation.status !== "applied") {
            return {
                status: "rejected",
                requestedBlockIds: [...plan.requestedBlockIds],
                removedBlockIds: [],
                reason: mutation.reason ?? "The DSH session rejected the cleanup mutation.",
                blockIndex: renderBlockIndex(buildDshMirrorRecords(session, options)),
            };
        }
        const nextRecords = buildDshMirrorRecords(session, options);
        if (io) {
            // Session.append() has already settled the active surface by the time
            // this synchronous write runs. Finish the canonical mirror write before
            // returning from the model-facing tool; the lifecycle queue is only a
            // later no-op convergence pass.
            const rendered = renderMirror(nextRecords);
            io.writeText(options.mirrorPath, rendered);
            if (state) {
                state.snapshot = {
                    filePath: options.mirrorPath,
                    records: nextRecords,
                    rendered,
                    signature: mirrorSignature(nextRecords),
                };
                state.lastProcessedMirror = undefined;
            }
        }
        // Return the post-mutation ordinal space with the tool result. A second
        // cleanup call in the same step would otherwise use IDs that shifted.
        return cleanupToolResult(plan, renderBlockIndex(nextRecords));
    }
    catch (error) {
        return {
            status: "rejected",
            requestedBlockIds: [...plan.requestedBlockIds],
            removedBlockIds: [],
            reason: `DSH cleanup mutation failed: ${error instanceof Error ? error.message : String(error)}`,
            blockIndex: renderBlockIndex(buildDshMirrorRecords(session, options)),
        };
    }
}
/**
 * Synchronize one DSH session mirror and apply legal edits through the
 * host-owned Session append/surface replacement seam. The canonical mirror is
 * always rewritten after processing so the file remains a projection rather
 * than an independent source of truth.
 */
export function reconcileDshMirror(state, session, io, options) {
    const current = io.readText(options.mirrorPath);
    const previous = state.snapshot;
    let candidatePlan;
    // Validate a model edit against the snapshot that was actually rendered
    // before refreshing for new session events. The mutation preflight below
    // rechecks targets and tool pairing against the current surface.
    if (previous
        && current !== undefined
        && current !== previous.rendered
        && current !== state.lastProcessedMirror) {
        candidatePlan = planContextEdits(previous.records, parseMirror(current), {
            allowGrowth: false,
            fixedTokens: options.fixedTokens,
        });
        state.lastProcessedMirror = current;
    }
    let records = buildDshMirrorRecords(session, options);
    let mutation;
    if (candidatePlan?.status === "applied") {
        try {
            mutation = applyDshContextEdits(session, candidatePlan, records, options);
        }
        catch (error) {
            mutation = rejectMutation(`DSH session mutation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        // Session.append() synchronously changes the host projection. Rebuild
        // from the session log instead of deriving a mirror from the plan.
        records = buildDshMirrorRecords(session, options);
    }
    const rendered = renderMirror(records);
    const signature = mirrorSignature(records);
    const snapshot = {
        filePath: options.mirrorPath,
        records,
        rendered,
        signature,
    };
    const projectionChanged = !previous || previous.signature !== signature || previous.filePath !== options.mirrorPath;
    if (current === undefined || projectionChanged) {
        io.writeText(options.mirrorPath, rendered);
        state.lastProcessedMirror = undefined;
    }
    else if (candidatePlan && candidatePlan.status !== "noop") {
        // Both successful native mutations and rejected candidates converge the
        // external artifact back to the host-owned projection.
        io.writeText(options.mirrorPath, rendered);
        state.lastProcessedMirror = undefined;
    }
    else if (candidatePlan?.status === "noop") {
        io.writeText(options.mirrorPath, rendered);
        state.lastProcessedMirror = undefined;
    }
    state.snapshot = snapshot;
    if (candidatePlan?.status === "rejected") {
        return { status: "rejected", snapshot, reason: candidatePlan.reason };
    }
    if (mutation?.status === "rejected") {
        return {
            status: "rejected",
            snapshot,
            reason: mutation.reason,
            beforeTokens: mutation.beforeTokens,
            afterTokens: mutation.afterTokens,
        };
    }
    if (mutation?.status === "applied") {
        return {
            status: "applied",
            snapshot,
            beforeTokens: mutation.beforeTokens,
            afterTokens: mutation.afterTokens,
        };
    }
    if (candidatePlan?.status === "noop")
        return { status: "noop", snapshot };
    return { status: projectionChanged || current === undefined ? "synced" : "noop", snapshot };
}
