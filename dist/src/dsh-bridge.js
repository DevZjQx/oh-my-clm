import { buildMirrorRecords, DEFAULT_MAX_BLOCK_CHARS, DEFAULT_MAX_MIRROR_CHARS, mirrorFingerprint, mirrorSignature, parseMirror, planContextEdits, renderMirror, } from "./context-format.js";
/** The DSH-facing mirror location deliberately matches the Pi adapter. */
export const DSH_MIRROR_RELATIVE_PATH = ".pi/clm/LIVE_CTX_MAIN.md";
/** A proposal file; DSH does not have Pi's branch-local `context_edit`. */
export const DSH_PATCH_RELATIVE_PATH = ".pi/clm/LIVE_CTX_MAIN.patch.json";
export const DSH_PATCH_VERSION = "oh-my-clm-dsh-patch-v1";
function isRecord(value) {
    return typeof value === "object" && value !== null;
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
 * `snapshotEvents()` are the host-owned projection and log views.
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
        entries.push({
            sourceEntry: { id: `dsh:${String(seq)}`, type: "message" },
            messages: [message],
        });
    }
    return entries;
}
function patchFromPlan(plan, records, options) {
    const recordById = new Map(records.map((record) => [record.id, record]));
    return {
        protocol: DSH_PATCH_VERSION,
        host: "dsh",
        sessionId: options.sessionId,
        mirrorPath: options.mirrorDisplayPath ?? options.mirrorPath,
        baseSnapshot: mirrorFingerprint(records),
        generatedAt: options.now?.() ?? Date.now(),
        status: plan.status,
        beforeTokens: plan.beforeTokens,
        afterTokens: plan.afterTokens,
        changedIds: [...plan.changedIds],
        omittedIds: [...plan.omittedIds],
        warnings: [...plan.warnings],
        ...plan.reason === undefined ? {} : { reason: plan.reason },
        edits: plan.edits.map((edit) => {
            const record = recordById.get(edit.targetId);
            return {
                targetId: edit.targetId,
                role: record?.role ?? "custom",
                action: edit.replacement === null ? "omit" : "replace",
                ...edit.replacement === null ? {} : { body: typeof edit.replacement.content === "string"
                        ? edit.replacement.content
                        : Array.isArray(edit.replacement.content)
                            ? edit.replacement.content
                                .map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "")
                                .filter(Boolean)
                                .join("\n")
                            : "" },
                replacement: edit.replacement,
                reason: edit.reason,
            };
        }),
    };
}
function writePatch(io, patchPath, patch) {
    io.writeText(patchPath, JSON.stringify(patch, null, 2) + "\n");
}
/**
 * Synchronize one DSH session mirror and, when the file changed, emit an
 * explicit auditable patch proposal. This function never mutates the DSH
 * session: applying a proposal requires a host policy or a future native DSH
 * context-edit contract.
 */
export function reconcileDshMirror(state, session, io, options) {
    const current = io.readText(options.mirrorPath);
    const previous = state.snapshot;
    let candidatePlan;
    let patch;
    // Validate a model edit against the snapshot that was actually rendered
    // before refreshing for new session events. This preserves an edit made in
    // the same step that appended a tool/result pair.
    if (previous
        && current !== undefined
        && current !== previous.rendered
        && current !== state.lastProcessedMirror) {
        candidatePlan = planContextEdits(previous.records, parseMirror(current), {
            allowGrowth: false,
            fixedTokens: options.fixedTokens,
        });
        patch = patchFromPlan(candidatePlan, previous.records, options);
        if (candidatePlan.status !== "noop")
            writePatch(io, options.patchPath, patch);
        state.lastProcessedMirror = current;
    }
    const settings = {
        maxBlockChars: options.maxBlockChars ?? DEFAULT_MAX_BLOCK_CHARS,
        maxMirrorChars: options.maxMirrorChars ?? DEFAULT_MAX_MIRROR_CHARS,
    };
    const records = buildMirrorRecords(buildDshProjectionEntries(session), {
        mirrorPath: options.mirrorDisplayPath ?? options.mirrorPath,
        maxBlockChars: settings.maxBlockChars,
        maxMirrorChars: settings.maxMirrorChars,
    });
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
    else if (candidatePlan?.status === "noop") {
        // Formatting-only changes do not become a patch proposal.
        io.writeText(options.mirrorPath, rendered);
        state.lastProcessedMirror = undefined;
    }
    state.snapshot = snapshot;
    if (patch?.status === "rejected")
        return { status: "rejected", snapshot, patch };
    if (patch?.status === "applied")
        return { status: "patch-written", snapshot, patch };
    if (candidatePlan?.status === "noop")
        return { status: "noop", snapshot };
    return { status: projectionChanged || current === undefined ? "synced" : "noop", snapshot };
}
