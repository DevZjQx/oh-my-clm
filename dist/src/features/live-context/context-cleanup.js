import { MIRROR_HEADER, MIRROR_VERSION, PRESERVE_FIRST_BLOCK_REASON, loadBearingRecord, mirrorFingerprint, calibrateWithHostUsage, estimateMirrorTokens, hostUsageOf, renderBlockList, reservedBodyReason, rewriteMirrorBlocks, scanMirrorBlocks, } from "./context-format.js";
const SNAPSHOT_PATTERN = /^<!-- CLM_SNAPSHOT ([a-f0-9]{16}) -->$/;
/**
 * Stable body marker for a soft unload. The fact after it is model-authored:
 * the plugin deliberately adds no second summarizer, and a shorter placeholder
 * means the original is still recoverable from the append-only session log
 * (I-4's diff/rollback remains the other half).
 */
export const OFFLOAD_PREFIX = "[offloaded: ";
export const OFFLOAD_SUFFIX = "]";
/** One line, one fact: long enough for a real key fact, short enough to shrink. */
export const MAX_OFFLOAD_NOTE_CHARS = 240;
/** The one-line body a soft unload writes into the kept block. */
export function offloadBody(note) {
    return `${OFFLOAD_PREFIX}${String(note ?? "").trim()}${OFFLOAD_SUFFIX}`;
}
/** Widest inclusive range a single cleanup call may expand to. */
const MAX_RANGE_SPAN = 10_000;
const RANGE_PATTERN = /^(\d+)(?:\s*-\s*(\d+))?$/;
const CLEANUP_ROLES = ["user", "assistant", "toolResult", "custom"];
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonNegativeSafeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function positiveSafeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
function fixedTokens(options) {
    return nonNegativeSafeInteger(options.fixedTokens) ? options.fixedTokens : 0;
}
function displayRecords(records) {
    let blockId = 0;
    return records.flatMap((record) => {
        if (record.protected)
            return [];
        blockId += 1;
        return [{ blockId, record }];
    });
}
/** The expanded ID list of either accepted target form. */
function requestedIdList(value) {
    if (Array.isArray(value))
        return [...value];
    return [...value.blockIds];
}
/**
 * Every block the caller named, removal or offload, for rejection reports. A
 * rejection must name the offloaded block too, otherwise `requestedBlockIds: []`
 * looks like no target was supplied.
 */
function targetBlockIds(args) {
    return [...new Set([...args.blockIds, ...args.offload.map((target) => target.blockId)])]
        .sort((a, b) => a - b);
}
function rejectPlan(requestedBlockIds, reason, beforeTokens = 0) {
    return {
        status: "rejected",
        edits: [],
        beforeTokens,
        afterTokens: beforeTokens,
        changedIds: [],
        omittedIds: [],
        warnings: [],
        reason,
        requestedBlockIds: [...requestedBlockIds],
        removedBlockIds: [],
        pairedRemovalIds: [],
        offloadedIds: [],
        offloadedBlockIds: [],
        offloads: [],
    };
}
/**
 * Validate the model-facing cleanup argument in both host adapters. Host
 * schemas catch basic JSON types; this check owns cross-host constraints such
 * as non-empty, unique, positive safe integer IDs, inclusive ranges, and the
 * role filter.
 *
 * Two target forms exist because the real cleanup decision has two scales:
 * `blockIds` names individual blocks, and `ranges` names a stretch such as a
 * whole turn (`"3-16"`). The distinction is preserved so a mistyped explicit ID
 * is rejected instead of silently ignored, while a range that runs past the end
 * of the current surface simply clamps.
 *
 * A third form, `list: "A-B"`, is read-only. It exists because the index names
 * gaps by range but cannot show what is inside them, and the model must be able
 * to inspect a range before deleting it without paying for the whole mirror.
 */
export function parseCleanupArgs(value) {
    if (!isRecord(value)) {
        return { ok: false, reason: "cleanup requires { blockIds: number[] } and/or { ranges: string[] }." };
    }
    const unknownKeys = Object.keys(value).filter((key) => key !== "blockIds" && key !== "ranges" && key !== "skipRoles" && key !== "list" && key !== "offload");
    if (unknownKeys.length > 0) {
        return { ok: false, reason: `cleanup does not accept unknown field(s): ${unknownKeys.join(", ")}.` };
    }
    const rawBlockIds = value.blockIds ?? [];
    const rawRanges = value.ranges ?? [];
    const rawSkipRoles = value.skipRoles ?? [];
    const rawOffload = value.offload ?? [];
    if (!Array.isArray(rawBlockIds)) {
        return { ok: false, reason: "cleanup blockIds must be an array of positive integers." };
    }
    if (!Array.isArray(rawRanges)) {
        return { ok: false, reason: "cleanup ranges must be an array of \"A-B\" strings." };
    }
    if (!Array.isArray(rawSkipRoles)) {
        return { ok: false, reason: "cleanup skipRoles must be an array of roles." };
    }
    if (!Array.isArray(rawOffload)) {
        return { ok: false, reason: "cleanup offload must be an array of { blockId, note } targets." };
    }
    const rawList = value.list;
    let list;
    if (rawList !== undefined) {
        if (typeof rawList !== "string") {
            return { ok: false, reason: "cleanup list must be a range string such as \"3-16\"." };
        }
        const match = rawList.trim().match(RANGE_PATTERN);
        if (!match) {
            return { ok: false, reason: `cleanup list "${rawList}" must be "A-B" or "A".` };
        }
        const start = Number(match[1]);
        const end = match[2] === undefined ? start : Number(match[2]);
        if (!positiveSafeInteger(start) || !positiveSafeInteger(end)) {
            return { ok: false, reason: `cleanup list "${rawList}" must use positive safe integers.` };
        }
        if (end < start) {
            return { ok: false, reason: `cleanup list "${rawList}" ends before it starts.` };
        }
        if (end - start + 1 > MAX_RANGE_SPAN) {
            return { ok: false, reason: `cleanup list "${rawList}" is wider than ${MAX_RANGE_SPAN} blocks.` };
        }
        // A listing and a removal in the same call would decide targets from a
        // partial view, so they stay separate calls by construction.
        if (rawBlockIds.length > 0 || rawRanges.length > 0 || rawSkipRoles.length > 0 || rawOffload.length > 0) {
            return {
                ok: false,
                reason: "cleanup list is read-only; call it with only `list`, then call cleanup again with the targets you verified.",
            };
        }
        list = { start, end };
    }
    const explicitIds = [];
    const seen = new Set();
    for (const valueId of rawBlockIds) {
        if (!positiveSafeInteger(valueId)) {
            return { ok: false, reason: "cleanup block IDs must be positive safe integers." };
        }
        if (seen.has(valueId)) {
            return { ok: false, reason: `cleanup block ID ${valueId} was supplied more than once.` };
        }
        seen.add(valueId);
        explicitIds.push(valueId);
    }
    const ranged = new Set();
    for (const entry of rawRanges) {
        if (typeof entry !== "string") {
            return { ok: false, reason: "cleanup ranges must be strings such as \"3-16\"." };
        }
        const match = entry.trim().match(RANGE_PATTERN);
        if (!match) {
            return { ok: false, reason: `cleanup range "${entry}" must be "A-B" or "A".` };
        }
        const start = Number(match[1]);
        const end = match[2] === undefined ? start : Number(match[2]);
        if (!positiveSafeInteger(start) || !positiveSafeInteger(end)) {
            return { ok: false, reason: `cleanup range "${entry}" must use positive safe integers.` };
        }
        if (end < start) {
            return { ok: false, reason: `cleanup range "${entry}" ends before it starts.` };
        }
        if (end - start + 1 > MAX_RANGE_SPAN) {
            return { ok: false, reason: `cleanup range "${entry}" is wider than ${MAX_RANGE_SPAN} blocks.` };
        }
        for (let blockId = start; blockId <= end; blockId += 1)
            ranged.add(blockId);
    }
    const skipRoles = [];
    for (const role of rawSkipRoles) {
        if (typeof role !== "string" || !CLEANUP_ROLES.includes(role)) {
            return { ok: false, reason: `cleanup skipRoles must use one of: ${CLEANUP_ROLES.join(", ")}.` };
        }
        if (!skipRoles.includes(role))
            skipRoles.push(role);
    }
    // A soft unload names one block and the fact that must survive it. It is
    // explicit by design: a range cannot invent the note that replaces a body.
    const offload = [];
    const offloadIds = new Set();
    for (const entry of rawOffload) {
        if (!isRecord(entry)) {
            return { ok: false, reason: "cleanup offload entries must be { blockId, note } objects." };
        }
        const unknownEntryKeys = Object.keys(entry).filter((key) => key !== "blockId" && key !== "note");
        if (unknownEntryKeys.length > 0) {
            return { ok: false, reason: `cleanup offload does not accept unknown field(s): ${unknownEntryKeys.join(", ")}.` };
        }
        if (!positiveSafeInteger(entry.blockId)) {
            return { ok: false, reason: "cleanup offload blockId must be a positive integer." };
        }
        if (offloadIds.has(entry.blockId)) {
            return { ok: false, reason: `cleanup offload block ${entry.blockId} was supplied more than once.` };
        }
        if (typeof entry.note !== "string") {
            return { ok: false, reason: "cleanup offload note must be a string." };
        }
        const note = entry.note.trim();
        if (note.length === 0) {
            return { ok: false, reason: `cleanup offload for block ${entry.blockId} needs a one-line note with the fact to keep.` };
        }
        if (/[\r\n]/.test(note)) {
            return { ok: false, reason: "cleanup offload note must be one line." };
        }
        if (note.length > MAX_OFFLOAD_NOTE_CHARS) {
            return { ok: false, reason: `cleanup offload note must be at most ${MAX_OFFLOAD_NOTE_CHARS} characters.` };
        }
        const reserved = reservedBodyReason(note);
        if (reserved)
            return { ok: false, reason: `cleanup offload note: ${reserved}.` };
        offloadIds.add(entry.blockId);
        offload.push({ blockId: entry.blockId, note });
    }
    const conflictingTargets = [...offloadIds].filter((blockId) => seen.has(blockId) || ranged.has(blockId));
    if (conflictingTargets.length > 0) {
        return {
            ok: false,
            reason: `cleanup block(s) ${conflictingTargets.join(", ")} cannot be both removed and offloaded; pick one action.`,
        };
    }
    if (list) {
        return { ok: true, args: { blockIds: [], explicitIds: [], rangedIds: [], skipRoles, offload, list } };
    }
    const rangedIds = [...ranged].filter((blockId) => !seen.has(blockId)).sort((a, b) => a - b);
    const blockIds = [...explicitIds, ...rangedIds].sort((a, b) => a - b);
    if (blockIds.length === 0 && offload.length === 0) {
        return { ok: false, reason: "cleanup requires at least one block ID, range, or offload target." };
    }
    return { ok: true, args: { blockIds, explicitIds, rangedIds, skipRoles, offload } };
}
/** Normalize either target form so every planner entry point stays compatible. */
export function normalizeCleanupArgs(value) {
    if (Array.isArray(value)) {
        return parseCleanupArgs({ blockIds: [...value] });
    }
    // A hand-built CleanupArgs from an older caller has no `offload` field; treat
    // it as none rather than crashing on `.length` in the planner.
    const args = value;
    return { ok: true, args: { ...args, offload: args.offload ?? [] } };
}
export function parseCleanupMirror(text) {
    const normalized = String(text ?? "").replace(/\r\n?/g, "\n");
    const lines = normalized.split("\n");
    const version = lines.some((line) => line.trim() === MIRROR_HEADER) ? MIRROR_VERSION : undefined;
    const snapshot = lines.map((line) => line.trim().match(SNAPSHOT_PATTERN)?.[1]).find(Boolean);
    const scan = scanMirrorBlocks(normalized);
    const blocks = new Map();
    for (const span of scan.blocks) {
        if (!blocks.has(span.id))
            blocks.set(span.id, { role: span.role });
    }
    const recognized = Boolean(version && snapshot && !scan.malformed && (scan.empty || blocks.size > 0));
    return {
        recognized,
        version,
        snapshot,
        empty: scan.empty,
        malformed: scan.malformed,
        blocks,
        duplicateIds: scan.duplicateIds,
        missingEndIds: scan.missingEndIds,
    };
}
/** Build the structural mirror view for DSH cleanup without rendering bodies. */
export function cleanupMirrorForRecords(records) {
    const blocks = new Map();
    let blockId = 0;
    for (const record of records) {
        if (record.protected)
            continue;
        blockId += 1;
        blocks.set(String(blockId), { role: record.role });
    }
    return {
        recognized: true,
        version: MIRROR_VERSION,
        snapshot: mirrorFingerprint(records),
        empty: blocks.size === 0,
        malformed: false,
        blocks,
        duplicateIds: [],
        missingEndIds: [],
    };
}
function validateMirrorForCleanup(records, parsed, args, options) {
    const requestedBlockIds = targetBlockIds(args);
    const beforeTokens = fixedTokens(options) + estimateMirrorTokens(records);
    if (!parsed.recognized) {
        return rejectPlan(requestedBlockIds, parsed.malformed
            ? `Malformed ${MIRROR_VERSION} mirror; refusing to clean a partial document` +
                (parsed.missingEndIds.length > 0
                    ? ` (unclosed CLM_ENTRY id(s): ${parsed.missingEndIds.join(", ")}).`
                    : ".")
            : "No valid CLM mirror header was found; refusing to clean the file.", beforeTokens);
    }
    if (parsed.snapshot !== mirrorFingerprint(records)) {
        return rejectPlan(requestedBlockIds, "The mirror snapshot is stale; refresh it before cleanup.", beforeTokens);
    }
    if (parsed.duplicateIds.length > 0) {
        return rejectPlan(requestedBlockIds, `Duplicate CLM_ENTRY ids are not allowed: ${[...new Set(parsed.duplicateIds)].join(", ")}.` +
            " A marker line inside a body needs one leading backslash.", beforeTokens);
    }
    if (parsed.empty) {
        return rejectPlan(requestedBlockIds, "The mirror is already empty; there are no cleanup targets.", beforeTokens);
    }
    const displayed = displayRecords(records);
    const byBlockId = new Map(displayed.map((entry) => [entry.blockId, entry.record]));
    const expectedIds = new Set(displayed.map((entry) => String(entry.blockId)));
    const actualIds = new Set(parsed.blocks.keys());
    const unknownIds = [...actualIds].filter((id) => !expectedIds.has(id));
    if (unknownIds.length > 0) {
        return rejectPlan(requestedBlockIds, `Unknown CLM_ENTRY ids are not allowed: ${unknownIds.join(", ")}`, beforeTokens);
    }
    const missingIds = [...expectedIds].filter((id) => !actualIds.has(id));
    if (missingIds.length > 0) {
        return rejectPlan(requestedBlockIds, `The mirror is missing current CLM_ENTRY ids: ${missingIds.join(", ")}`, beforeTokens);
    }
    for (const entry of displayed) {
        const block = parsed.blocks.get(String(entry.blockId));
        if (!block)
            continue;
        if (block.role !== entry.record.role) {
            return rejectPlan(requestedBlockIds, `CLM_ENTRY role changed for block ${entry.blockId}; refusing cleanup.`, beforeTokens);
        }
    }
    // Explicit IDs are strict: a typo must not silently become a no-op. Ranges
    // are lenient: a turn range that runs past the current surface clamps, and
    // block 1 is simply preserved instead of rejecting the whole batch.
    for (const blockId of args.explicitIds) {
        if (!byBlockId.has(blockId)) {
            return rejectPlan(requestedBlockIds, `Unknown cleanup block ID: ${blockId}.`, beforeTokens);
        }
        if ((options.preserveFirstBlock ?? true) && blockId === 1) {
            return rejectPlan(requestedBlockIds, PRESERVE_FIRST_BLOCK_REASON, beforeTokens);
        }
    }
    // An offload keeps the block and rewrites only its body. That is a rewrite,
    // so it inherits the two rules a model mirror edit already has: block 1 is
    // load-bearing, and user-authored text may be omitted but never replaced
    // (the note would otherwise become the human's words). It must also shrink
    // the block on its own, or the placeholder is a growth path around the
    // shrink-only gate.
    const preserveFirst = options.preserveFirstBlock ?? true;
    for (const target of args.offload) {
        const record = byBlockId.get(target.blockId);
        if (!record) {
            return rejectPlan(requestedBlockIds, `Unknown cleanup block ID: ${target.blockId}.`, beforeTokens);
        }
        if (preserveFirst && target.blockId === 1) {
            return rejectPlan(requestedBlockIds, PRESERVE_FIRST_BLOCK_REASON, beforeTokens);
        }
        if (record.role !== "assistant" && record.role !== "toolResult") {
            return rejectPlan(requestedBlockIds, `Block ${target.blockId} is ${record.role}-authored; offload keeps the block and rewrites its body, which is only allowed for assistant and toolResult blocks. Omit it instead.`, beforeTokens);
        }
        const body = offloadBody(target.note);
        if (estimateMirrorTokens([record], () => body) >= estimateMirrorTokens([record])) {
            return rejectPlan(requestedBlockIds, `Offload note for block ${target.blockId} is not shorter than the block body; keep it to one short fact or omit the block instead.`, beforeTokens);
        }
    }
    return undefined;
}
/**
 * Plan a cleanup using only canonical records and block IDs. No block body is
 * inspected, so a preview truncated by the host cannot cause an old_string
 * reconstruction or a false edit.
 */
export function planCleanup(records, parsed, requested, options = {}) {
    const args = normalizeCleanupArgs(requested);
    const requestedBlockIds = requestedIdList(requested);
    if (!args.ok)
        return rejectPlan(requestedBlockIds, args.reason);
    if (args.args.list) {
        // A listing never reaches the mutation planner. Both hosts branch before
        // this point; this guard keeps a future caller from treating rows as
        // targets.
        return rejectPlan([], "cleanup list is read-only; it does not remove blocks.", fixedTokens(options) + estimateMirrorTokens(records));
    }
    const validation = validateMirrorForCleanup(records, parsed, args.args, options);
    if (validation)
        return validation;
    const displayed = displayRecords(records);
    const byBlockId = new Map(displayed.map((entry) => [entry.blockId, entry.record]));
    const byToolCallId = new Map();
    const byResultCallId = new Map();
    for (const record of records) {
        for (const callId of record.toolCallIds)
            byToolCallId.set(callId, record);
        if (record.role === "toolResult" && record.toolCallId)
            byResultCallId.set(record.toolCallId, record);
    }
    const actions = new Map();
    const pending = [];
    const rangedIds = new Set(args.args.rangedIds);
    const preserveFirst = options.preserveFirstBlock ?? true;
    const ownerBlockId = (record) => {
        if (!record.toolCallId)
            return undefined;
        const owner = byToolCallId.get(record.toolCallId);
        return owner ? displayed.find((entry) => entry.record.id === owner.id)?.blockId : undefined;
    };
    for (const blockId of args.args.blockIds) {
        const record = byBlockId.get(blockId);
        if (!record)
            continue;
        // Block 1 is the load-bearing anchor: a range that covers it keeps it.
        if (preserveFirst && blockId === 1 && rangedIds.has(blockId))
            continue;
        // Keeping block 1 means keeping its paired result too; otherwise the
        // batch would be rejected for an owner the model never asked to remove.
        if (preserveFirst && record.role === "toolResult" && ownerBlockId(record) === 1)
            continue;
        if (args.args.skipRoles.includes(record.role))
            continue;
        pending.push({ record, reason: `requested block ${blockId}` });
    }
    if (pending.length === 0 && args.args.offload.length === 0) {
        return rejectPlan(targetBlockIds(args.args), "Nothing in the requested targets is removable: block 1, its paired result, and every skipRoles match are preserved.", fixedTokens(options) + estimateMirrorTokens(records));
    }
    const addOmission = (record, reason) => {
        if (record.protected)
            return `Protected block ${record.id} cannot be omitted.`;
        if ((options.preserveFirstBlock ?? true) && record.id === loadBearingRecord(records)?.id) {
            return PRESERVE_FIRST_BLOCK_REASON;
        }
        if (!actions.has(record.id))
            actions.set(record.id, { record, reason });
        return undefined;
    };
    while (pending.length > 0) {
        const action = pending.shift();
        if (!action || actions.has(action.record.id))
            continue;
        const failure = addOmission(action.record, action.reason);
        if (failure)
            return rejectPlan(targetBlockIds(args.args), failure, fixedTokens(options) + estimateMirrorTokens(records));
        if (action.record.role === "assistant") {
            for (const callId of action.record.toolCallIds) {
                const result = byResultCallId.get(callId);
                if (!result) {
                    return rejectPlan(targetBlockIds(args.args), `Cannot clean assistant block ${displayed.find((entry) => entry.record.id === action.record.id)?.blockId ?? action.record.id} while tool call ${callId} has no current result.`, fixedTokens(options) + estimateMirrorTokens(records));
                }
                pending.push({ record: result, reason: `paired result for tool call ${callId}` });
            }
        }
        if (action.record.role === "toolResult" && action.record.toolCallId) {
            const owner = byToolCallId.get(action.record.toolCallId);
            if (owner)
                pending.push({ record: owner, reason: `owner of tool result ${action.record.id}` });
        }
    }
    const offloads = [];
    for (const target of args.args.offload) {
        const record = byBlockId.get(target.blockId);
        if (!record)
            continue; // validated above
        offloads.push({ blockId: target.blockId, recordId: record.id, body: offloadBody(target.note) });
    }
    const offloadByRecordId = new Map(offloads.map((item) => [item.recordId, item]));
    // A block cannot be both dropped and kept as a placeholder: a range may
    // cover an explicitly offloaded block, and the two actions are opposite.
    for (const item of offloads) {
        if (!actions.has(item.recordId))
            continue;
        return rejectPlan(targetBlockIds(args.args), `Block ${item.blockId} cannot be both removed and offloaded; pick one action.`, fixedTokens(options) + estimateMirrorTokens(records));
    }
    // Rewriting an assistant tool-call body drops the call itself, so its
    // result would be orphaned. Offload therefore reuses the mirror-rewrite
    // cascade: the kept block stays, and its paired result is omitted.
    for (const item of offloads) {
        const record = byBlockId.get(item.blockId);
        if (!record || record.role !== "assistant")
            continue;
        for (const callId of record.toolCallIds) {
            const result = byResultCallId.get(callId);
            if (!result) {
                return rejectPlan(targetBlockIds(args.args), `Cannot offload assistant block ${item.blockId} while tool call ${callId} has no current result.`, fixedTokens(options) + estimateMirrorTokens(records));
            }
            if (actions.has(result.id))
                continue;
            const failure = addOmission(result, `paired result for offloaded tool call ${callId}`);
            if (failure)
                return rejectPlan(targetBlockIds(args.args), failure, fixedTokens(options) + estimateMirrorTokens(records));
        }
    }
    const omitted = records.filter((record) => actions.has(record.id));
    const estimatedBefore = fixedTokens(options) + estimateMirrorTokens(records);
    const estimatedAfter = fixedTokens(options) + records.reduce((total, record) => {
        const offload = offloadByRecordId.get(record.id);
        if (offload)
            return total + estimateMirrorTokens([record], () => offload.body);
        return actions.has(record.id) ? total : total + estimateMirrorTokens([record]);
    }, 0);
    let beforeTokens = estimatedBefore;
    let afterTokens = estimatedAfter;
    const warnings = [];
    const hostUsage = hostUsageOf(options.hostUsage);
    if (hostUsage) {
        const calibrated = calibrateWithHostUsage(estimatedBefore, estimatedAfter, hostUsage);
        beforeTokens = calibrated.beforeTokens;
        afterTokens = calibrated.afterTokens;
        if (calibrated.warning)
            warnings.push(calibrated.warning);
        if (calibrated.reason)
            return rejectPlan(targetBlockIds(args.args), calibrated.reason, beforeTokens);
    }
    if (afterTokens >= beforeTokens) {
        return rejectPlan(targetBlockIds(args.args), "Cleanup must strictly shrink the estimated context; no safe cleanup was applied.", beforeTokens);
    }
    const removedBlockIds = omitted
        .map((record) => displayed.find((entry) => entry.record.id === record.id)?.blockId)
        .filter((blockId) => blockId !== undefined);
    const requestedSet = new Set(args.args.blockIds);
    const pairedRemovalIds = removedBlockIds.filter((blockId) => !requestedSet.has(blockId));
    // Edits follow record order so the host applies them deterministically; an
    // offloaded block keeps its ID/role and only swaps its body.
    const edits = [];
    for (const record of records) {
        if (actions.has(record.id)) {
            edits.push({ targetId: record.id, replacement: null, reason: "omit", provenance: "runtime-cleanup" });
            continue;
        }
        const offload = offloadByRecordId.get(record.id);
        if (offload) {
            edits.push({
                targetId: record.id,
                replacement: { content: [{ type: "text", text: offload.body }] },
                reason: "replace",
                provenance: "runtime-cleanup",
            });
        }
    }
    const changedIds = records
        .filter((record) => actions.has(record.id) || offloadByRecordId.has(record.id))
        .map((record) => record.id);
    return {
        status: "applied",
        edits,
        beforeTokens,
        afterTokens,
        changedIds,
        omittedIds: omitted.map((record) => record.id),
        warnings,
        requestedBlockIds: [...args.args.blockIds],
        removedBlockIds,
        pairedRemovalIds,
        offloadedIds: offloads.map((item) => item.recordId),
        offloadedBlockIds: offloads.map((item) => item.blockId),
        offloads,
    };
}
/**
 * Answer a read-only drill-down: the rows of one ID range, never a mutation.
 *
 * This is the other half of the block index. The index names every gap by range
 * but deliberately does not list what is inside it, so a model that wants to
 * remove a gap can read its rows here for a few hundred tokens instead of
 * opening the full mirror. Both hosts branch on `args.list` before planning a
 * cleanup, so a listing can never be scheduled as a deletion.
 */
export function describeCleanupList(records, list, options = {}) {
    const rendered = renderBlockList(records, list, options);
    if (!rendered.ok) {
        return {
            status: "rejected",
            requestedBlockIds: [],
            removedBlockIds: [],
            pairedRemovalIds: [],
            reason: rendered.reason,
        };
    }
    return {
        status: "listed",
        requestedBlockIds: [],
        removedBlockIds: [],
        pairedRemovalIds: [],
        reason: "",
        rows: rendered.text,
    };
}
/**
 * Remove whole CLM_ENTRY spans from a mirror after planCleanup has validated
 * the protocol. Spans come from the same top-level scan that parsing uses, so a
 * marker quoted inside a body is never mistaken for a deletable block. This
 * preserves all header comments and never reconstructs a block body from the
 * visible preview.
 *
 * Failures are returned, not thrown: a malformed mirror must reach the model as
 * a cleanup rejection with a reason, never as a lost write or an exception.
 */
export function removeMirrorBlocks(text, blockIds) {
    return rewriteMirrorBlocks(text, { remove: blockIds });
}
export function cleanupToolResult(plan, blockIndex, copy = "compact") {
    const result = {
        status: plan.status === "applied" ? "applied" : "rejected",
        requestedBlockIds: [...plan.requestedBlockIds],
        removedBlockIds: [...plan.removedBlockIds],
        pairedRemovalIds: [...(plan.pairedRemovalIds ?? [])],
        reason: plan.status === "applied" ? "" : plan.reason ?? "Cleanup was rejected.",
        copy,
    };
    if (plan.offloadedBlockIds && plan.offloadedBlockIds.length > 0) {
        result.offloadedBlockIds = [...plan.offloadedBlockIds];
    }
    if (blockIndex)
        result.blockIndex = blockIndex;
    return result;
}
/**
 * Parse the `CLM_CLEANUP_RESULT` environment value. Unknown values fall back
 * to `compact` so a typo never silently restores the verbose result.
 */
export function parseCleanupResultCopy(value) {
    return value === "full" || value === "none" ? value : "compact";
}
/** Compress sorted IDs into inclusive runs: [3,4,5,7] -> "3-5, 7". */
export function formatBlockIdRuns(blockIds) {
    const sorted = [...new Set(blockIds)].sort((a, b) => a - b);
    const runs = [];
    let index = 0;
    while (index < sorted.length) {
        const start = sorted[index];
        let end = start;
        while (sorted[index + 1] === end + 1) {
            end += 1;
            index += 1;
        }
        runs.push(start === end ? String(start) : `${start}-${end}`);
        index += 1;
    }
    return runs.join(", ");
}
/**
 * Model-visible cleanup summary. Paired removals are reported separately: an
 * ID the model never requested would otherwise look like an index or off-by-one
 * failure instead of the structural pairing rule it actually is.
 */
export function formatCleanupToolResult(result, copy = result.copy ?? "full") {
    if (result.status === "listed") {
        // A listing is the content the caller asked for, so the copy mode must not
        // suppress it; only the one-line mutation confirmation is optional.
        return result.rows ?? "";
    }
    if (result.status !== "applied") {
        // A rejection must always reach the model with its reason, even when
        // `none` suppresses success confirmations: otherwise the model cannot
        // take a next step.
        const rejected = `cleanup rejected; ${result.reason}`;
        return copy === "full" && result.blockIndex ? `${rejected}\n\n${result.blockIndex}` : rejected;
    }
    if (copy === "none")
        return "";
    const removed = formatBlockIdRuns(result.removedBlockIds);
    const offloadedIds = result.offloadedBlockIds ?? [];
    const paired = result.pairedRemovalIds ?? [];
    // Report both actions honestly: an offload kept every block, so a bare
    // "removed 0 block(s)" would read like a failed call.
    const actions = [];
    if (result.removedBlockIds.length > 0)
        actions.push(`removed ${result.removedBlockIds.length} block(s): ${removed}`);
    if (offloadedIds.length > 0) {
        actions.push(`offloaded ${offloadedIds.length} block(s): ${formatBlockIdRuns(offloadedIds)}`);
    }
    const summary = `cleanup applied; ${actions.join("; ")}.` +
        (paired.length > 0 ? ` Paired (not requested): ${formatBlockIdRuns(paired)}.` : "");
    return copy === "full" && result.blockIndex ? `${summary}\n\n${result.blockIndex}` : summary;
}
