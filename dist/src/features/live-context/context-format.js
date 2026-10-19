import { createHash } from "node:crypto";
/** Host-neutral format version shared by the Pi extension and the DSH bridge. */
export const MIRROR_VERSION = "clm-v2";
/** The exact protocol header line; rendering, parsing, and self-read detection all use it. */
export const MIRROR_HEADER = `<!-- ${MIRROR_VERSION} -->`;
export const DEFAULT_MAX_BLOCK_CHARS = 12_000;
export const DEFAULT_MAX_MIRROR_CHARS = 96_000;
/**
 * Defaults for the model-facing block index. They are deliberately small: the
 * index is injected as a dynamic runtime-context snapshot, and DSH appends a new
 * snapshot whenever its text changes. The static protocol prose lives in the
 * host's stable system-prompt section, not in this per-step payload.
 */
export const DEFAULT_BLOCK_INDEX_PREVIEW_CHARS = 64;
/**
 * Head rows are the "do not touch" anchor: the opening task and the first
 * exchange, which a cleanup almost never targets. The budget that is left over
 * goes to the trailing window, where stale-but-still-remembered noise (the
 * actual cleanup surface) accumulates.
 */
export const DEFAULT_BLOCK_INDEX_HEAD = 12;
/**
 * Width of the trailing block window. Blocks between the head and this window
 * are named by an omission line giving their ID range, so a jump in the listed
 * IDs is never ambiguous and the last listed ID is not mistaken for the last
 * block.
 */
export const DEFAULT_BLOCK_INDEX_TAIL = 40;
/**
 * Character budget for one `cleanup({ list: "A-B" })` response. A listing is a
 * drill-down, not a second mirror: it must stay cheaper than the index itself,
 * and a truncated listing names the range that continues it instead of leaving a
 * silently partial view.
 */
export const DEFAULT_BLOCK_LIST_CHARS = 6_000;
const EMPTY_MARKER = "<!-- CLM_EMPTY -->";
const SNAPSHOT_PATTERN = /^<!-- CLM_SNAPSHOT ([a-f0-9]{16}) -->$/;
const BLOCK_START_PATTERN = /^\[\[CLM_ENTRY\s+id=([^\s\]]+)\s+role=([^\s\]]+)\]\]$/;
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function textFromBlock(block) {
    if (block.type === "text" && typeof block.text === "string")
        return block.text;
    if (block.type === "thinking" && typeof block.thinking === "string")
        return block.thinking;
    if (block.type === "reasoning" && typeof block.text === "string")
        return block.text;
    if (block.type === "toolCall" || block.type === "tool-call") {
        const name = typeof block.name === "string" ? block.name : "tool";
        let args = "{}";
        try {
            args = typeof block.arguments === "string"
                ? block.arguments
                : JSON.stringify(block.arguments ?? {}) ?? "{}";
        }
        catch {
            args = "{}";
        }
        return `${name} ${args}`;
    }
    if (block.type === "image") {
        const mimeType = typeof block.mimeType === "string" ? block.mimeType : "image";
        return `[${mimeType}]`;
    }
    if (typeof block.text === "string")
        return block.text;
    if (typeof block.content === "string")
        return block.content;
    return "";
}
export function contentText(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .map((part) => (isRecord(part) ? textFromBlock(part) : typeof part === "string" ? part : ""))
        .filter(Boolean)
        .join("\n");
}
export function messageText(message) {
    if (!isRecord(message))
        return "";
    const role = typeof message.role === "string" ? message.role : "";
    if (role === "branchSummary" || role === "compactionSummary") {
        return typeof message.summary === "string" ? message.summary : "";
    }
    if (role === "bashExecution") {
        const command = typeof message.command === "string" ? message.command : "";
        const output = typeof message.output === "string" ? message.output : "";
        return [command && `$ ${command}`, output].filter(Boolean).join("\n\n");
    }
    return contentText(message.content);
}
function toolCallIds(message) {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content))
        return [];
    return message.content
        .filter((part) => isRecord(part) && (part.type === "toolCall" || part.type === "tool-call"))
        .map((part) => (typeof part.id === "string" ? part.id : ""))
        .filter(Boolean);
}
function sourceIsEditable(entry) {
    if (entry.sourceEntry.type !== "message" && entry.sourceEntry.type !== "custom_message")
        return false;
    if (entry.sourceEntry.type === "custom_message" && entry.sourceEntry.customType === "oh-my-clm")
        return false;
    return true;
}
function editableRole(message) {
    if (!isRecord(message))
        return undefined;
    switch (message.role) {
        case "user":
        case "assistant":
        case "toolResult":
            return message.role;
        case "tool":
            return "toolResult";
        case "custom":
            return message.role;
        default:
            return undefined;
    }
}
/**
 * Convert Pi's provenance-preserving projection into one stable block per
 * context-producing session entry. Compaction summaries are a pinned boundary;
 * retained entries after one are editable according to the policy below.
 */
export function buildMirrorRecords(entries, options = {}) {
    const hasCompaction = entries.some((entry) => entry.messages.some((message) => isRecord(message) && message.role === "compactionSummary"));
    const records = [];
    const seen = new Set();
    for (const entry of entries) {
        if (!sourceIsEditable(entry) || !entry.sourceEntry.id || seen.has(entry.sourceEntry.id))
            continue;
        const message = entry.messages.find((candidate) => editableRole(candidate)) ?? entry.messages[0];
        const role = editableRole(message);
        if (!role)
            continue;
        seen.add(entry.sourceEntry.id);
        const text = messageText(message);
        records.push({
            id: entry.sourceEntry.id,
            role,
            text,
            protected: false,
            toolCallIds: toolCallIds(message),
            toolCallId: isRecord(message) && typeof message.toolCallId === "string" ? message.toolCallId : undefined,
            sourceMessage: message,
        });
    }
    const protectedRecords = hasCompaction || records.length === 0
        ? records
        : (() => {
            const firstUser = records.findIndex((record) => record.role === "user");
            const protectedThrough = firstUser >= 0 ? firstUser : 0;
            return records.map((record, index) => ({ ...record, protected: index <= protectedThrough }));
        })();
    return applyMirrorDisplayBudget(protectedRecords, options);
}
function selfReferenceText(text, mirrorPath) {
    const normalized = normalizeText(text);
    if (!normalized)
        return undefined;
    const looksLikeMirror = normalized.includes(MIRROR_HEADER) && normalized.includes("[[CLM_ENTRY");
    const namesTheMirror = Boolean(mirrorPath && normalized.includes(mirrorPath));
    if (!looksLikeMirror && !namesTheMirror)
        return undefined;
    return "[oh-my-clm] Self-referential live-context output omitted from the editable mirror (" +
        normalized.length +
        " source characters). The canonical tool result remains available for explicit context editing.";
}
function compactMirrorText(text, maxChars) {
    const normalized = normalizeText(text);
    if (normalized.length <= maxChars)
        return normalized;
    const marker = "\n...[oh-my-clm mirror preview truncated; " +
        normalized.length +
        " source characters retained unless this block is edited]...\n";
    const available = Math.max(0, maxChars - marker.length);
    const head = Math.ceil(available * 0.6);
    const tail = Math.max(0, available - head);
    return (normalized.slice(0, head) + marker + (tail > 0 ? normalized.slice(-tail) : "")).trim();
}
function applyMirrorDisplayBudget(records, options) {
    const maxBlockChars = Math.max(256, options.maxBlockChars ?? DEFAULT_MAX_BLOCK_CHARS);
    const maxMirrorChars = Math.max(maxBlockChars, options.maxMirrorChars ?? DEFAULT_MAX_MIRROR_CHARS);
    const editableCount = records.filter((record) => !record.protected).length;
    const fairShare = editableCount > 0 ? Math.max(256, Math.floor(maxMirrorChars / editableCount)) : maxBlockChars;
    return records.map((record) => {
        if (record.protected)
            return { ...record, renderText: undefined };
        const safeText = record.role === "toolResult" ? selfReferenceText(record.text, options.mirrorPath) ?? record.text : record.text;
        const renderText = compactMirrorText(safeText, Math.min(maxBlockChars, fairShare));
        return { ...record, renderText: renderText === record.text ? undefined : renderText };
    });
}
function decodeId(id) {
    try {
        return decodeURIComponent(id);
    }
    catch {
        return id;
    }
}
function editableDisplayIds(records) {
    const ids = new Map();
    let index = 0;
    for (const record of records) {
        if (!record.protected)
            ids.set(record.id, String(++index));
    }
    return ids;
}
function blockPreview(text, maxChars) {
    const collapsed = normalizeText(text).replace(/\s+/g, " ");
    if (!collapsed)
        return "(empty)";
    if (collapsed.length <= maxChars)
        return collapsed;
    return collapsed.slice(0, maxChars).trimEnd() + "…";
}
/**
 * Render the compact model-facing index of editable blocks.
 *
 * The chat context needs the same 1-based ordinals that `cleanup` accepts, so
 * the model can choose a cleanup target without opening LIVE_CTX_MAIN.md. The
 * preview intentionally stays short: it identifies a block, while an actual
 * rewrite still has to read the full body from the mirror. Protected blocks are
 * excluded because they have no cleanup ID and are never editable.
 *
 * Only the dynamic payload lives here. The cleanup discipline, the head/tail
 * rule, the load-bearing note, and the refresh cadence belong to the host's
 * stable system-prompt section so they are cached once instead of repeated in
 * every runtime-context snapshot.
 *
 * The index lists two runs: the first `headBlocks` editable blocks and the last
 * `tailBlocks`. Recency gets the larger budget because the trailing blocks are
 * the ones the model still remembers producing; the head is only the "do not
 * touch" anchor. Every block left between the runs is accounted for by an
 * omission line naming its ID range, so a jump in the listed IDs is never
 * ambiguous and the end of the list is never mistaken for the end of the
 * session. With the defaults, 200 editable blocks list 1-12, an omission line
 * for 13-160, and 161-200.
 */
export function renderBlockIndex(records, options = {}) {
    const editable = records.filter((record) => !record.protected);
    if (editable.length === 0)
        return "";
    const displayIds = editableDisplayIds(records);
    const maxPreviewChars = Math.max(24, Math.floor(options.maxPreviewChars ?? DEFAULT_BLOCK_INDEX_PREVIEW_CHARS));
    const headCount = Math.max(0, Math.floor(options.headBlocks ?? DEFAULT_BLOCK_INDEX_HEAD));
    const tailCount = Math.max(0, Math.floor(options.tailBlocks ?? DEFAULT_BLOCK_INDEX_TAIL));
    const lineFor = (record) => {
        const blockId = displayIds.get(record.id) ?? record.id;
        return `${blockId}. ${record.role}: ${blockPreview(record.text, maxPreviewChars)}`;
    };
    const omittedLine = (start, end) => {
        const count = end - start + 1;
        const where = start === end ? `ID ${start}` : `IDs ${start}-${end}`;
        return `... ${count} editable block(s) omitted (${where}).`;
    };
    const lines = [];
    const appendRun = (start, end) => {
        if (start > end)
            return;
        lines.push(...editable.slice(start - 1, end).map(lineFor));
    };
    const appendOmittedRun = (start, end) => {
        if (start > end)
            return;
        lines.push(omittedLine(start, end));
    };
    const headEnd = Math.min(editable.length, headCount);
    appendRun(1, headEnd);
    const tail = selectTailWindow(editable.length, headEnd, tailCount);
    if (tail) {
        appendOmittedRun(headEnd + 1, tail.start - 1);
        appendRun(tail.start, tail.end);
    }
    else {
        appendOmittedRun(headEnd + 1, editable.length);
    }
    return [
        "<oh-my-clm-block-index>",
        "Editable blocks by cleanup ID; call cleanup({ blockIds: [...] }) to omit them, cleanup({ list: \"A-B\" }) to read a range's rows.",
        ...lines,
        "</oh-my-clm-block-index>",
    ].join("\n");
}
/**
 * Pick the 1-based trailing window: the last `count` blocks, never overlapping
 * the head. Returns undefined when there is nothing left to list after it.
 */
export function selectTailWindow(total, headEnd, count) {
    if (count <= 0 || headEnd >= total)
        return undefined;
    const span = Math.min(count, total - headEnd);
    return { start: total - span + 1, end: total };
}
/**
 * Render the read-only rows of one ID range: the drill-down a model needs when
 * the index only named a gap. The budget is characters rather than rows so one
 * tool result stays cheaper than the index itself; when it truncates, the footer
 * names the exact range that continues the listing, so a partial view can never
 * be mistaken for the whole range.
 */
export function renderBlockList(records, range, options = {}) {
    const editable = records.filter((record) => !record.protected);
    if (editable.length === 0) {
        return { ok: false, reason: "The editable context is empty; there are no block rows to list." };
    }
    const start = Math.max(1, Math.floor(range.start));
    const end = Math.min(editable.length, Math.floor(range.end));
    if (start > editable.length) {
        return {
            ok: false,
            reason: `IDs ${range.start}-${range.end} start past the end of the editable surface (last ID ${editable.length}).`,
        };
    }
    const maxPreviewChars = Math.max(24, Math.floor(options.maxPreviewChars ?? DEFAULT_BLOCK_INDEX_PREVIEW_CHARS));
    const maxChars = Math.max(240, Math.floor(options.maxChars ?? DEFAULT_BLOCK_LIST_CHARS));
    const header = `Read-only rows for IDs ${start}-${end}; nothing was removed.`;
    const footer = (next) => {
        const remaining = end - next + 1;
        return `... ${remaining} more block(s); call cleanup({ list: "${next}-${end}" }) to continue.`;
    };
    const lines = [header];
    let used = header.length;
    let last = start - 1;
    for (let blockId = start; blockId <= end; blockId += 1) {
        const record = editable[blockId - 1];
        const line = `${blockId}. ${record.role}: ${blockPreview(record.text, maxPreviewChars)}`;
        // Reserve the continuation footer before admitting a row, so the cut is
        // always explicit and the follow-up range is already named.
        const reserved = blockId < end ? footer(blockId + 1).length + 1 : 0;
        if (blockId > start && used + line.length + 1 + reserved > maxChars)
            break;
        lines.push(line);
        used += line.length + 1;
        last = blockId;
    }
    if (last < end)
        lines.push(footer(last + 1));
    return {
        ok: true,
        text: ["<oh-my-clm-block-list>", ...lines, "</oh-my-clm-block-list>"].join("\n"),
    };
}
export const DEFAULT_DIGEST_MAX_LINES = 40;
function compactTokens(tokens) {
    if (tokens < 1_000)
        return `${tokens} tok`;
    const thousands = tokens / 1_000;
    return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1)}k tok`;
}
function unitTokens(unit) {
    return estimateMirrorTokens(unit.records);
}
function runRoleLabel(records) {
    const roles = new Set(records.map((record) => record.role));
    if (roles.size === 1)
        return [...roles][0] ?? "block";
    return "assistant+toolResult";
}
/**
 * Group editable blocks into the units a cleanup decision actually uses: one
 * turn is the unit between two user messages. Turn boundaries come from the
 * projected roles alone, so both hosts produce the same grouping without
 * passing turn/step metadata, and a deletable range never includes a later
 * user block.
 *
 * The final turn is marked open: it is still growing as the turn continues, so
 * keeping its contents out of the listing is what makes the digest text stable
 * across steps (and is also the safer deletion boundary, because its tool
 * pairs may not be settled yet).
 */
export function buildBlockDigestUnits(records) {
    const displayIds = editableDisplayIds(records);
    const units = [];
    for (const record of records) {
        if (record.protected)
            continue;
        const ordinal = Number(displayIds.get(record.id));
        if (!Number.isFinite(ordinal))
            continue;
        const last = units[units.length - 1];
        if (record.role === "user" || !last) {
            units.push({ kind: record.role === "user" ? "user" : "run", start: ordinal, end: ordinal, records: [record] });
            continue;
        }
        last.end = ordinal;
        last.records.push(record);
    }
    const last = units[units.length - 1];
    if (last)
        last.open = true;
    return units;
}
/**
 * Render the turn-shaped digest of editable blocks.
 *
 * The static protocol lives in the host's system-prompt section; this payload
 * only carries addresses. Its unit is the cleanup unit rather than the
 * message: one line per turn, giving the ID range, the block count and the
 * estimated token cost of that stretch. That is the mapping the model cannot
 * derive from its own transcript — it can see the content of recent turns, but
 * not which range and how many tokens each stretch costs, and not where its
 * own recollection of "that failed attempt a few turns ago" sits.
 *
 * The text is deliberately invariant while a turn appends ordinary messages:
 * only completed turns are listed and the growing turn is represented by its
 * stable start ID. DSH dedupes identical runtime-context snapshots, so the
 * digest is appended once per turn instead of once per step.
 */
export function renderBlockDigest(records, options = {}) {
    const editable = records.filter((record) => !record.protected);
    if (editable.length === 0)
        return "";
    const maxPreviewChars = Math.max(24, Math.floor(options.maxPreviewChars ?? DEFAULT_BLOCK_INDEX_PREVIEW_CHARS));
    const maxLines = Math.max(1, Math.floor(options.maxLines ?? DEFAULT_DIGEST_MAX_LINES));
    const units = buildBlockDigestUnits(records);
    const open = units.find((unit) => unit.open);
    // Only completed turns are listed; the growing turn is always represented by
    // its stable start anchor below, so the payload is never empty and never
    // changes while ordinary messages are appended.
    const visible = units.filter((unit) => !unit.open);
    const lines = [];
    const lineFor = (unit) => {
        const tokens = compactTokens(unitTokens(unit));
        const first = unit.records[0];
        const preview = first ? blockPreview(first.text, maxPreviewChars) : "(empty)";
        const load = unit.records.length;
        const count = load > 1 ? ` ×${load}` : "";
        const where = unit.start === unit.end ? `${unit.start}` : `${unit.start}-${unit.end}`;
        if (unit.kind === "run") {
            return `${where}. ${runRoleLabel(unit.records)}${count} (${tokens}): ${blockPreview(first?.text ?? "", maxPreviewChars)}`;
        }
        if (load === 1) {
            // A turn that is just the user message needs no "turn/user" double label.
            return `${where}. user (${tokens}): ${preview}`;
        }
        const userTokens = first ? compactTokens(estimateMirrorTokens([first])) : "0 tok";
        const noise = load - 1;
        const noiseNote = noise > 0 ? ` + ${noise} noise` : "";
        return `${where}. turn${count} (${tokens}): user (${userTokens})${noiseNote}: ${preview}`;
    };
    const omittedLine = (start, end) => {
        const count = end - start + 1;
        const where = start === end ? `ID ${start}` : `IDs ${start}-${end}`;
        return `... ${count} editable block(s) omitted (${where}).`;
    };
    const head = Math.min(visible.length, Math.max(0, Math.floor(maxLines / 2)));
    const tail = Math.max(0, maxLines - head);
    const selected = visible.length <= maxLines
        ? visible
        : [...visible.slice(0, head), ...visible.slice(visible.length - tail)];
    // When turns are collapsed, name the biggest of them by cost: reclaimable size
    // is the quantity a cleanup decision actually needs, and the collapsed middle
    // is exactly where the model cannot compute it from its own transcript. The
    // line only reads completed units, so it stays byte-stable inside a turn.
    const shown = new Set(selected);
    const hidden = visible.filter((unit) => !shown.has(unit));
    const rankedHidden = [...hidden].sort((a, b) => unitTokens(b) - unitTokens(a)).slice(0, 3);
    const hiddenLine = rankedHidden.length === 0
        ? undefined
        : `... largest omitted turns: ${rankedHidden.map((unit) => {
            const where = unit.start === unit.end ? `${unit.start}` : `${unit.start}-${unit.end}`;
            return `${where} (${compactTokens(unitTokens(unit))})`;
        }).join(", ")}.`;
    let hiddenNamed = false;
    const emitHiddenLine = () => {
        if (hiddenNamed || !hiddenLine)
            return;
        hiddenNamed = true;
        lines.push(hiddenLine);
    };
    let previousEnd = 0;
    for (const unit of selected) {
        if (unit.start > previousEnd + 1) {
            lines.push(omittedLine(previousEnd + 1, unit.start - 1));
            emitHiddenLine();
        }
        lines.push(lineFor(unit));
        previousEnd = unit.end;
    }
    const lastVisible = visible[visible.length - 1];
    if (lastVisible && lastVisible.end > previousEnd) {
        lines.push(omittedLine(previousEnd + 1, lastVisible.end));
        emitHiddenLine();
    }
    if (open) {
        // Only the start is stable while the turn grows; the end is deliberately
        // omitted so appending ordinary messages cannot change this text.
        lines.push(`IDs ${open.start}.. (current turn, not listed): ${blockPreview(open.records[0]?.text ?? "", maxPreviewChars)}`);
    }
    return [
        "<oh-my-clm-block-index>",
        "Editable blocks by cleanup ID; ranges are inclusive. One line per turn; call cleanup({ ranges: [\"A-B\"] }) to omit a turn, cleanup({ list: \"A-B\" }) to read its rows.",
        ...lines,
        "</oh-my-clm-block-index>",
    ].join("\n");
}
export function renderMirror(records, options = {}) {
    const header = [
        MIRROR_HEADER,
        "<!-- CLM_SNAPSHOT " + (options.snapshot ?? mirrorFingerprint(records)) + " -->",
        "<!-- Edit block bodies only. Keep CLM_ENTRY and closing markers intact. -->",
        "<!-- id is the editable block's ordinal; do not change it or reorder blocks. -->",
        "<!-- Delete an editable block to omit that message; use CLM_EMPTY when deleting the last one. -->",
        "<!-- The protected initial task is intentionally not shown here. -->",
    ];
    const displayIds = editableDisplayIds(records);
    const blocks = records
        .filter((record) => !record.protected)
        .map((record) => {
        const body = record.renderText ?? record.text;
        const displayId = displayIds.get(record.id) ?? record.id;
        return "[[CLM_ENTRY id=" + displayId + " role=" + record.role + "]]\n" +
            body +
            "\n[[/CLM_ENTRY id=" + displayId + "]]";
    });
    if (blocks.length === 0)
        blocks.push(EMPTY_MARKER);
    return [...header, ...blocks].join("\n\n") + "\n";
}
export function parseMirror(text) {
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
        const endMarker = "[[/CLM_ENTRY id=" + encodedId + "]]";
        let end = index + 1;
        while (end < lines.length && (lines[end]?.trim() ?? "") !== endMarker)
            end += 1;
        if (end >= lines.length) {
            missingEndIds.push(id);
            malformed = true;
            break;
        }
        const block = { id, role, body: lines.slice(index + 1, end).join("\n").trim() };
        if (blocks.has(id))
            duplicateIds.push(id);
        else
            blocks.set(id, block);
        index = end;
    }
    if (empty && blocks.size > 0)
        malformed = true;
    const recognized = Boolean(version && snapshot && !malformed && (empty || blocks.size > 0));
    return { recognized, version, snapshot, empty, malformed, blocks, duplicateIds, missingEndIds };
}
export function normalizeText(text) {
    return String(text ?? "").replace(/\r\n?/g, "\n").trim();
}
function estimatorMessage(message) {
    if (!isRecord(message) || typeof message.role !== "string")
        return undefined;
    if (message.role === "tool") {
        return {
            ...message,
            role: "toolResult",
            toolCallId: typeof message.tool_call_id === "string"
                ? message.tool_call_id
                : message.toolCallId,
        };
    }
    if (!["system", "developer", "user", "assistant", "toolResult", "custom", "bashExecution", "branchSummary", "compactionSummary"].includes(message.role)) {
        return undefined;
    }
    return message;
}
function fallbackEstimatorMessage(role, text, toolCallId) {
    const content = normalizeText(text);
    if (role === "assistant") {
        return { role: "assistant", content: [{ type: "text", text: content }] };
    }
    if (role === "toolResult") {
        return {
            role: "toolResult",
            content: [{ type: "text", text: content }],
            toolCallId: toolCallId ?? "",
        };
    }
    return { role, content };
}
const CHARS_PER_TOKEN = 3.5;
const ESTIMATED_IMAGE_CHARS = 4_800;
function safeJsonStringify(value) {
    try {
        return JSON.stringify(value) ?? "undefined";
    }
    catch {
        return "[unserializable]";
    }
}
function contentEstimateChars(content) {
    if (typeof content === "string")
        return content.length;
    if (!Array.isArray(content))
        return 0;
    return content.reduce((total, part) => {
        if (!isRecord(part))
            return total + (typeof part === "string" ? part.length : 0);
        if (part.type === "text" && typeof part.text === "string")
            return total + part.text.length;
        if (part.type === "thinking" && typeof part.thinking === "string")
            return total + part.thinking.length;
        if (part.type === "reasoning" && typeof part.text === "string")
            return total + part.text.length;
        if (part.type === "image")
            return total + ESTIMATED_IMAGE_CHARS;
        return total;
    }, 0);
}
/** Match Pi's system-message text projection without importing the Pi host. */
function systemTextChars(message) {
    const parts = [];
    const content = message.content;
    if (typeof content === "string") {
        parts.push(content);
    }
    else if (Array.isArray(content)) {
        parts.push(content
            .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("\n"));
    }
    const sections = message.sections;
    if (isRecord(sections)) {
        for (const value of Object.values(sections)) {
            if (typeof value === "string")
                parts.push(value);
        }
    }
    return parts.filter((part) => part.length > 0).join("\n\n").length;
}
/** Match Pi's independent rounding for system tool additions/removals. */
function estimateToolsTokens(tools) {
    if (!Array.isArray(tools) || tools.length === 0)
        return 0;
    return Math.ceil(safeJsonStringify(tools).length / CHARS_PER_TOKEN);
}
/**
 * Estimate one structured message without importing a host runtime.
 *
 * Supported Pi message shapes follow the current provider-independent host
 * estimator: 3.5 characters per token, rounded per message (and per system
 * tool declaration list). The shared layer also accepts DSH's `reasoning`,
 * `tool-call`, and `tool` vocabulary. Keeping the estimator here makes the
 * format layer loadable by both Pi and DSH; it is still an approximation, not
 * a provider tokenizer.
 */
export function estimateMessageTokens(message) {
    const candidate = estimatorMessage(message);
    if (!candidate)
        return 0;
    let chars = 0;
    switch (candidate.role) {
        case "system":
            return Math.ceil(systemTextChars(candidate) / CHARS_PER_TOKEN)
                + estimateToolsTokens(candidate.toolsAdded)
                + estimateToolsTokens(candidate.toolsRemoved);
        case "user":
        case "toolResult":
        case "tool":
            chars = contentEstimateChars(candidate.content);
            break;
        case "developer":
        case "custom":
            chars = contentEstimateChars(candidate.content);
            break;
        case "assistant":
            if (Array.isArray(candidate.content)) {
                for (const part of candidate.content) {
                    if (!isRecord(part))
                        continue;
                    if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
                        chars += part.text.length;
                    }
                    else if (part.type === "thinking" && typeof part.thinking === "string") {
                        chars += part.thinking.length;
                    }
                    else if (part.type === "toolCall" || part.type === "tool-call") {
                        chars += typeof part.name === "string" ? part.name.length : 0;
                        chars += safeJsonStringify(part.arguments).length;
                    }
                }
            }
            break;
        case "bashExecution":
            chars = (typeof candidate.command === "string" ? candidate.command.length : 0)
                + (typeof candidate.output === "string" ? candidate.output.length : 0);
            break;
        case "branchSummary":
        case "compactionSummary":
            chars = typeof candidate.summary === "string" ? candidate.summary.length : 0;
            break;
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
}
/**
 * Estimate text snippets as individual user messages.
 *
 * This compatibility helper keeps the old text-array API, but delegates the
 * actual counting and per-message rounding to the shared 3.5 chars/token
 * estimator instead of aggregating all characters and rounding only once.
 */
export function estimateTokens(texts) {
    return texts.reduce((total, text) => total + estimateMessageTokens(fallbackEstimatorMessage("user", text)), 0);
}
function estimateRecordTokens(record, text, useSourceMessage = text === record.text) {
    const source = useSourceMessage ? estimatorMessage(record.sourceMessage) : undefined;
    return estimateMessageTokens(source ?? fallbackEstimatorMessage(record.role, text, record.toolCallId));
}
/** Estimate mirror records while preserving their original structured messages. */
export function estimateMirrorTokens(records, textForRecord) {
    const useSourceMessage = textForRecord === undefined;
    const selectText = textForRecord ?? ((record) => record.text);
    return records.reduce((total, record) => total + estimateRecordTokens(record, selectText(record), useSourceMessage), 0);
}
export function mirrorSignature(records) {
    return records
        .map((record) => [
        record.id,
        record.role,
        record.protected ? "1" : "0",
        normalizeText(record.text),
        normalizeText(record.renderText ?? ""),
    ].join("\u0000"))
        .join("\u0001");
}
export function mirrorFingerprint(records) {
    return createHash("sha256").update(mirrorSignature(records)).digest("hex").slice(0, 16);
}
function contentReplacement(role, text) {
    if (role === "assistant" || role === "toolResult")
        return [{ type: "text", text }];
    return text;
}
/**
 * Turn a user/model-edited mirror into append-only Pi context edits. The
 * function deliberately cannot add arbitrary new entries: a summary replaces
 * an existing block, which keeps the session tree and role constraints valid.
 */
export function planContextEdits(records, parsed, options = {}) {
    const fixedTokens = typeof options.fixedTokens === "number" && Number.isFinite(options.fixedTokens) && options.fixedTokens >= 0
        ? Math.ceil(options.fixedTokens)
        : 0;
    const beforeTokens = fixedTokens + estimateMirrorTokens(records);
    if (!parsed.recognized) {
        return {
            status: "rejected",
            edits: [],
            beforeTokens,
            afterTokens: beforeTokens,
            changedIds: [],
            omittedIds: [],
            warnings: [],
            reason: parsed.malformed
                ? `Malformed ${MIRROR_VERSION} mirror; refusing to apply a partial document.`
                : "No valid CLM mirror header was found; refusing to interpret the whole file as a deletion.",
        };
    }
    const warnings = [];
    if (parsed.snapshot !== mirrorFingerprint(records)) {
        return {
            status: "rejected",
            edits: [],
            beforeTokens,
            afterTokens: beforeTokens,
            changedIds: [],
            omittedIds: [],
            warnings,
            reason: "The mirror snapshot is stale; refresh it before editing context.",
        };
    }
    if (parsed.duplicateIds.length > 0) {
        return {
            status: "rejected",
            edits: [],
            beforeTokens,
            afterTokens: beforeTokens,
            changedIds: [],
            omittedIds: [],
            warnings,
            reason: `Duplicate CLM_ENTRY ids are not allowed: ${parsed.duplicateIds.join(", ")}`,
        };
    }
    const knownIds = new Set(records.map((record) => record.id));
    const displayIds = editableDisplayIds(records);
    const knownDisplayIds = new Set(displayIds.values());
    const aliases = new Map();
    for (const record of records) {
        const addAlias = (alias) => {
            if (!alias)
                return;
            const owners = aliases.get(alias) ?? new Set();
            owners.add(record.id);
            aliases.set(alias, owners);
        };
        addAlias(record.id);
        addAlias(displayIds.get(record.id));
    }
    const ambiguousAliases = [...aliases.entries()]
        .filter(([, owners]) => owners.size > 1)
        .map(([alias]) => alias);
    if (ambiguousAliases.length > 0) {
        return {
            status: "rejected",
            edits: [],
            beforeTokens,
            afterTokens: beforeTokens,
            changedIds: [],
            omittedIds: [],
            warnings: [],
            reason: `Ambiguous CLM_ENTRY aliases are not allowed: ${ambiguousAliases.join(", ")}`,
        };
    }
    const aliasDuplicates = records
        .filter((record) => {
        const displayId = displayIds.get(record.id);
        return Boolean(displayId && displayId !== record.id && parsed.blocks.has(record.id) && parsed.blocks.has(displayId));
    })
        .map((record) => record.id);
    if (aliasDuplicates.length > 0) {
        return {
            status: "rejected",
            edits: [],
            beforeTokens,
            afterTokens: beforeTokens,
            changedIds: [],
            omittedIds: [],
            warnings: [],
            reason: `Duplicate CLM_ENTRY aliases are not allowed: ${aliasDuplicates.join(", ")}`,
        };
    }
    const blockForRecord = (record) => parsed.blocks.get(record.id) ?? parsed.blocks.get(displayIds.get(record.id) ?? "");
    const unknownIds = [...parsed.blocks.keys()].filter((id) => !knownIds.has(id) && !knownDisplayIds.has(id));
    if ((options.rejectUnknownIds ?? true) && unknownIds.length > 0) {
        return {
            status: "rejected",
            edits: [],
            beforeTokens,
            afterTokens: beforeTokens,
            changedIds: [],
            omittedIds: [],
            warnings,
            reason: `Unknown CLM_ENTRY ids are not allowed: ${unknownIds.join(", ")}`,
        };
    }
    if (unknownIds.length > 0)
        warnings.push(`Unknown CLM_ENTRY ignored: ${unknownIds.join(", ")}`);
    const roleMismatches = records.filter((record) => {
        const block = blockForRecord(record);
        return Boolean(block && block.role !== record.role);
    });
    if (roleMismatches.length > 0) {
        return {
            status: "rejected",
            edits: [],
            beforeTokens,
            afterTokens: beforeTokens,
            changedIds: [],
            omittedIds: [],
            warnings,
            reason: `CLM_ENTRY role changed for: ${roleMismatches.map((record) => record.id).join(", ")}`,
        };
    }
    const userReplacementIds = records
        .filter((record) => {
        if (record.role !== "user" || options.allowUserReplacement)
            return false;
        const block = blockForRecord(record);
        if (!block)
            return false;
        const body = normalizeText(block.body);
        return Boolean(body && normalizeText(record.renderText ?? record.text) !== body);
    })
        .map((record) => record.id);
    if (userReplacementIds.length > 0) {
        return {
            status: "rejected",
            edits: [],
            beforeTokens,
            afterTokens: beforeTokens,
            changedIds: userReplacementIds,
            omittedIds: [],
            warnings,
            reason: `User-authored blocks cannot be rewritten by default: ${userReplacementIds.join(", ")}`,
        };
    }
    const actions = new Map();
    for (const record of records) {
        if (record.protected) {
            actions.set(record.id, { kind: "keep" });
            continue;
        }
        const block = blockForRecord(record);
        if (!block) {
            actions.set(record.id, { kind: "omit", reason: "block deleted" });
            continue;
        }
        const body = normalizeText(block.body);
        const renderedBaseline = normalizeText(record.renderText ?? record.text);
        if (!body) {
            actions.set(record.id, { kind: "omit", reason: "block emptied" });
        }
        else if (renderedBaseline === body) {
            actions.set(record.id, { kind: "keep" });
        }
        else {
            actions.set(record.id, { kind: "replace", body, reason: "block edited" });
        }
    }
    const byToolCallId = new Map();
    for (const record of records) {
        for (const id of record.toolCallIds)
            byToolCallId.set(id, record);
    }
    const byResultCallId = new Map();
    for (const record of records) {
        if (record.role === "toolResult" && record.toolCallId)
            byResultCallId.set(record.toolCallId, record);
    }
    const omit = (record, reason) => {
        if (record.protected) {
            warnings.push(`Could not remove protected entry ${record.id}; ${reason}.`);
            return false;
        }
        const current = actions.get(record.id);
        if (!current || current.kind !== "omit")
            actions.set(record.id, { kind: "omit", reason });
        return true;
    };
    // Replacing an assistant block removes Pi tool-call metadata. Remove the
    // paired tool results too, otherwise the provider would see orphan results.
    for (const record of records) {
        const action = actions.get(record.id);
        if (record.role === "assistant" && record.toolCallIds.length > 0 && action?.kind !== "keep") {
            for (const callId of record.toolCallIds) {
                const result = byResultCallId.get(callId);
                if (result)
                    omit(result, `assistant tool call ${callId} was rewritten`);
            }
        }
    }
    // Removing a tool result also removes its owner assistant turn, preventing
    // an assistant tool call from surviving without a result.
    for (const record of records) {
        if (record.role !== "toolResult" || actions.get(record.id)?.kind !== "omit" || !record.toolCallId)
            continue;
        const owner = byToolCallId.get(record.toolCallId);
        const ownerAction = owner ? actions.get(owner.id) : undefined;
        if (owner && ownerAction?.kind === "keep")
            omit(owner, `tool result ${record.id} was removed`);
    }
    // The previous pass can newly omit an owner, so repeat the paired-result rule.
    for (const record of records) {
        const action = actions.get(record.id);
        if (record.role === "assistant" && record.toolCallIds.length > 0 && action?.kind === "omit") {
            for (const callId of record.toolCallIds) {
                const result = byResultCallId.get(callId);
                if (result)
                    omit(result, `assistant tool call ${callId} was removed`);
            }
        }
    }
    const changed = records.filter((record) => actions.get(record.id)?.kind !== "keep");
    if (changed.length === 0) {
        return {
            status: "noop",
            edits: [],
            beforeTokens,
            afterTokens: beforeTokens,
            changedIds: [],
            omittedIds: [],
            warnings,
        };
    }
    const afterTokens = fixedTokens + records.reduce((total, record) => {
        const action = actions.get(record.id) ?? { kind: "keep" };
        if (action.kind === "omit")
            return total;
        const text = action.kind === "replace" ? action.body ?? "" : record.text;
        return total + estimateRecordTokens(record, text);
    }, 0);
    const allowGrowth = options.allowGrowth ?? true;
    const budgetTokens = options.budgetTokens ?? 0;
    if (!allowGrowth && afterTokens >= beforeTokens) {
        return {
            status: "rejected",
            edits: [],
            beforeTokens,
            afterTokens,
            changedIds: changed.map((record) => record.id),
            omittedIds: changed.filter((record) => actions.get(record.id)?.kind === "omit").map((record) => record.id),
            warnings,
            reason: "A compaction must SHRINK context; replace stale text with a shorter summary instead.",
        };
    }
    if (allowGrowth && budgetTokens > 0 && afterTokens > budgetTokens) {
        return {
            status: "rejected",
            edits: [],
            beforeTokens,
            afterTokens,
            changedIds: changed.map((record) => record.id),
            omittedIds: changed.filter((record) => actions.get(record.id)?.kind === "omit").map((record) => record.id),
            warnings,
            reason: `An edit must FIT the ${budgetTokens}-token CLM budget.`,
        };
    }
    const edits = [];
    for (const record of records) {
        const action = actions.get(record.id);
        if (!action || action.kind === "keep" || record.protected)
            continue;
        if (action.kind === "omit") {
            edits.push({ targetId: record.id, replacement: null, reason: "omit" });
        }
        else {
            edits.push({
                targetId: record.id,
                replacement: { content: contentReplacement(record.role, action.body ?? "") },
                reason: "replace",
            });
        }
    }
    return {
        status: "applied",
        edits,
        beforeTokens,
        afterTokens,
        changedIds: changed.map((record) => record.id),
        omittedIds: changed.filter((record) => actions.get(record.id)?.kind === "omit").map((record) => record.id),
        warnings,
    };
}
