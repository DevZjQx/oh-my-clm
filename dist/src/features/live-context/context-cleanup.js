import { MIRROR_HEADER, MIRROR_VERSION, mirrorFingerprint, estimateMirrorTokens, } from "./context-format.js";
const SNAPSHOT_PATTERN = /^<!-- CLM_SNAPSHOT ([a-f0-9]{16}) -->$/;
const BLOCK_START_PATTERN = /^\[\[CLM_ENTRY\s+id=([^\s\]]+)\s+role=([^\s\]]+)\]\]$/;
const EMPTY_MARKER = "<!-- CLM_EMPTY -->";
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
function decodeId(id) {
    try {
        return decodeURIComponent(id);
    }
    catch {
        return id;
    }
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
 */
export function parseCleanupArgs(value) {
    if (!isRecord(value)) {
        return { ok: false, reason: "cleanup requires { blockIds: number[] } and/or { ranges: string[] }." };
    }
    const unknownKeys = Object.keys(value).filter((key) => key !== "blockIds" && key !== "ranges" && key !== "skipRoles");
    if (unknownKeys.length > 0) {
        return { ok: false, reason: `cleanup does not accept unknown field(s): ${unknownKeys.join(", ")}.` };
    }
    const rawBlockIds = value.blockIds ?? [];
    const rawRanges = value.ranges ?? [];
    const rawSkipRoles = value.skipRoles ?? [];
    if (!Array.isArray(rawBlockIds)) {
        return { ok: false, reason: "cleanup blockIds must be an array of positive integers." };
    }
    if (!Array.isArray(rawRanges)) {
        return { ok: false, reason: "cleanup ranges must be an array of \"A-B\" strings." };
    }
    if (!Array.isArray(rawSkipRoles)) {
        return { ok: false, reason: "cleanup skipRoles must be an array of roles." };
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
    const rangedIds = [...ranged].filter((blockId) => !seen.has(blockId)).sort((a, b) => a - b);
    const blockIds = [...explicitIds, ...rangedIds].sort((a, b) => a - b);
    if (blockIds.length === 0) {
        return { ok: false, reason: "cleanup requires at least one block ID or range." };
    }
    return { ok: true, args: { blockIds, explicitIds, rangedIds, skipRoles } };
}
/** Normalize either target form so every planner entry point stays compatible. */
export function normalizeCleanupArgs(value) {
    if (Array.isArray(value)) {
        return parseCleanupArgs({ blockIds: [...value] });
    }
    return { ok: true, args: value };
}
export function parseCleanupMirror(text) {
    const normalized = String(text ?? "").replace(/\r\n?/g, "\n");
    const lines = normalized.split("\n");
    const version = lines.some((line) => line.trim() === MIRROR_HEADER) ? MIRROR_VERSION : undefined;
    const snapshot = lines.map((line) => line.trim().match(SNAPSHOT_PATTERN)?.[1]).find(Boolean);
    const blocks = new Map();
    const duplicateIds = [];
    const missingEndIds = [];
    let empty = false;
    let malformed = false;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]?.trim() ?? "";
        if (line === EMPTY_MARKER) {
            if (blocks.size > 0)
                malformed = true;
            empty = true;
            continue;
        }
        const match = line.match(BLOCK_START_PATTERN);
        if (!match)
            continue;
        const encodedId = match[1] ?? "";
        const id = decodeId(encodedId);
        const role = match[2] ?? "user";
        const endMarker = `[[/CLM_ENTRY id=${encodedId}]]`;
        let end = index + 1;
        while (end < lines.length && (lines[end]?.trim() ?? "") !== endMarker)
            end += 1;
        if (end >= lines.length) {
            missingEndIds.push(id);
            malformed = true;
            break;
        }
        if (blocks.has(id))
            duplicateIds.push(id);
        else
            blocks.set(id, { role });
        index = end;
    }
    if (empty && blocks.size > 0)
        malformed = true;
    const recognized = Boolean(version && snapshot && !malformed && (empty || blocks.size > 0));
    return { recognized, version, snapshot, empty, malformed, blocks, duplicateIds, missingEndIds };
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
    const requestedBlockIds = args.blockIds;
    const beforeTokens = fixedTokens(options) + estimateMirrorTokens(records);
    if (!parsed.recognized) {
        return rejectPlan(requestedBlockIds, parsed.malformed
            ? `Malformed ${MIRROR_VERSION} mirror; refusing to clean a partial document.`
            : "No valid CLM mirror header was found; refusing to clean the file.", beforeTokens);
    }
    if (parsed.snapshot !== mirrorFingerprint(records)) {
        return rejectPlan(requestedBlockIds, "The mirror snapshot is stale; refresh it before cleanup.", beforeTokens);
    }
    if (parsed.duplicateIds.length > 0) {
        return rejectPlan(requestedBlockIds, `Duplicate CLM_ENTRY ids are not allowed: ${parsed.duplicateIds.join(", ")}`, beforeTokens);
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
            return rejectPlan(requestedBlockIds, "Cleanup preserves load-bearing block 1.", beforeTokens);
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
    if (pending.length === 0) {
        return rejectPlan(args.args.blockIds, "Nothing in the requested targets is removable: block 1, its paired result, and every skipRoles match are preserved.", fixedTokens(options) + estimateMirrorTokens(records));
    }
    const addOmission = (record, reason) => {
        if (record.protected)
            return `Protected block ${record.id} cannot be omitted.`;
        const displayId = displayed.find((entry) => entry.record.id === record.id)?.blockId;
        if ((options.preserveFirstBlock ?? true) && displayId === 1) {
            return "Cleanup preserves load-bearing block 1, including paired owners.";
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
            return rejectPlan(args.args.blockIds, failure, fixedTokens(options) + estimateMirrorTokens(records));
        if (action.record.role === "assistant") {
            for (const callId of action.record.toolCallIds) {
                const result = byResultCallId.get(callId);
                if (!result) {
                    return rejectPlan(args.args.blockIds, `Cannot clean assistant block ${displayed.find((entry) => entry.record.id === action.record.id)?.blockId ?? action.record.id} while tool call ${callId} has no current result.`, fixedTokens(options) + estimateMirrorTokens(records));
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
    const omitted = records.filter((record) => actions.has(record.id));
    const beforeTokens = fixedTokens(options) + estimateMirrorTokens(records);
    const afterTokens = fixedTokens(options) + records.reduce((total, record) => {
        return actions.has(record.id) ? total : total + estimateMirrorTokens([record]);
    }, 0);
    if (afterTokens >= beforeTokens) {
        return rejectPlan(args.args.blockIds, "Cleanup must strictly shrink the estimated context; no safe cleanup was applied.", beforeTokens);
    }
    const removedBlockIds = omitted
        .map((record) => displayed.find((entry) => entry.record.id === record.id)?.blockId)
        .filter((blockId) => blockId !== undefined);
    const requestedSet = new Set(args.args.blockIds);
    const pairedRemovalIds = removedBlockIds.filter((blockId) => !requestedSet.has(blockId));
    const edits = omitted.map((record) => ({
        targetId: record.id,
        replacement: null,
        reason: "omit",
    }));
    return {
        status: "applied",
        edits,
        beforeTokens,
        afterTokens,
        changedIds: omitted.map((record) => record.id),
        omittedIds: omitted.map((record) => record.id),
        warnings: [],
        requestedBlockIds: [...args.args.blockIds],
        removedBlockIds,
        pairedRemovalIds,
    };
}
/**
 * Remove whole CLM_ENTRY spans from a mirror after planCleanup has validated
 * the protocol. This preserves all header comments and never reconstructs a
 * block body from the visible preview.
 */
export function removeMirrorBlocks(text, blockIds) {
    const normalized = String(text ?? "").replace(/\r\n?/g, "\n");
    const targets = new Set(blockIds.map((blockId) => String(blockId)));
    const lines = normalized.split("\n");
    const kept = [];
    let retainedBlocks = 0;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]?.trim() ?? "";
        const match = line.match(BLOCK_START_PATTERN);
        if (!match || !targets.has(decodeId(match[1] ?? ""))) {
            if (match)
                retainedBlocks += 1;
            kept.push(lines[index] ?? "");
            continue;
        }
        const encodedId = match[1] ?? "";
        const endMarker = `[[/CLM_ENTRY id=${encodedId}]]`;
        let end = index + 1;
        while (end < lines.length && (lines[end]?.trim() ?? "") !== endMarker)
            end += 1;
        if (end >= lines.length)
            throw new Error(`Cannot remove malformed CLM_ENTRY id=${encodedId}.`);
        index = end;
    }
    let result = kept.join("\n");
    if (!result.endsWith("\n"))
        result += "\n";
    const hasEmptyMarker = kept.some((line) => line.trim() === EMPTY_MARKER);
    if (retainedBlocks === 0 && !hasEmptyMarker) {
        result = result.trimEnd() + `\n\n${EMPTY_MARKER}\n`;
    }
    return result;
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
    if (copy === "none")
        return "";
    if (result.status !== "applied") {
        const rejected = `cleanup rejected; ${result.reason}`;
        return copy === "full" && result.blockIndex ? `${rejected}\n\n${result.blockIndex}` : rejected;
    }
    const removed = formatBlockIdRuns(result.removedBlockIds);
    const paired = result.pairedRemovalIds ?? [];
    const summary = `cleanup applied; removed ${result.removedBlockIds.length} block(s): ${removed}.` +
        (paired.length > 0 ? ` Paired (not requested): ${formatBlockIdRuns(paired)}.` : "");
    return copy === "full" && result.blockIndex ? `${summary}\n\n${result.blockIndex}` : summary;
}
