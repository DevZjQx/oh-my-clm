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
export const DEFAULT_BLOCK_INDEX_HEAD = 40;
export const DEFAULT_BLOCK_INDEX_MIDDLE = 24;

/**
 * The single cleanup habit that is both the most useful and the least likely to
 * remove something load-bearing. It is deliberately mechanical rather than
 * judgment-based, because the failure mode is a wrong ID, not a wrong opinion:
 * batch every target into one call (IDs renumber after each removal), name the
 * block by an identity the model can verify, and treat a skipped block as far
 * cheaper than a guessed one. Kept as one string so the Pi prompt, the DSH
 * block index, and the tool descriptions cannot drift apart.
 */
export const CLEANUP_DISCIPLINE =
	"Batch every removal into one cleanup call using only IDs you can positively identify — IDs renumber after each removal, so never chain calls on stale IDs. " +
	"Delete a tool-call block together with its paired result, prefer assistant/tool-result noise over user turns, and leave any uncertain ID for a later pass: an unremoved block costs window, a wrong one costs correctness.";

const EMPTY_MARKER = "<!-- CLM_EMPTY -->";
const SNAPSHOT_PATTERN = /^<!-- CLM_SNAPSHOT ([a-f0-9]{16}) -->$/;
const BLOCK_START_PATTERN = /^\[\[CLM_ENTRY\s+id=([^\s\]]+)\s+role=([^\s\]]+)\]\]$/;

export type MirrorRole = "user" | "assistant" | "toolResult" | "custom";

export interface ProjectionEntryLike {
	sourceEntry: {
		id: string;
		type: string;
		customType?: string;
	};
	messages: readonly unknown[];
}

export interface MirrorRecord {
	id: string;
	role: MirrorRole;
	text: string;
	/** Text shown in the editable mirror; the canonical source text remains in `text`. */
	renderText?: string;
	protected: boolean;
	toolCallIds: string[];
	toolCallId?: string;
	/** Original structured Pi message, retained for role-aware token estimation. */
	sourceMessage?: unknown;
}

export interface ParsedMirrorBlock {
	id: string;
	role: string;
	body: string;
}

export interface ParsedMirror {
	recognized: boolean;
	version?: string;
	snapshot?: string;
	empty: boolean;
	malformed: boolean;
	blocks: Map<string, ParsedMirrorBlock>;
	duplicateIds: string[];
	missingEndIds: string[];
}

export interface ContextEditDraft {
	targetId: string;
	replacement: { content: unknown } | null;
	reason: "replace" | "omit";
}

export interface EditPlan {
	status: "noop" | "applied" | "rejected";
	edits: ContextEditDraft[];
	beforeTokens: number;
	afterTokens: number;
	changedIds: string[];
	omittedIds: string[];
	warnings: string[];
	reason?: string;
}

export interface EditPlanOptions {
	/** `true` means fit-gate behavior; `false` means shrink-gate behavior. */
	allowGrowth?: boolean;
	/** Optional approximate context budget used by the fit gate. */
	budgetTokens?: number;
	/** Estimated request tokens outside the editable mirror, such as the system prompt. */
	fixedTokens?: number;
	/** Reject blocks that are not part of the canonical projection. */
	rejectUnknownIds?: boolean;
	/** Allow replacing user-authored content; omission remains possible by default. */
	allowUserReplacement?: boolean;
}

export interface MirrorBuildOptions {
	/** Relative or absolute path of the live mirror, used to stop self-referential reads. */
	mirrorPath?: string;
	/** Maximum source characters shown for one block. */
	maxBlockChars?: number;
	/** Maximum approximate characters shown by the complete mirror. */
	maxMirrorChars?: number;
}

interface TextBlock {
	type?: string;
	text?: unknown;
	thinking?: unknown;
	name?: unknown;
	arguments?: unknown;
	data?: unknown;
	content?: unknown;
	mimeType?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function textFromBlock(block: TextBlock): string {
	if (block.type === "text" && typeof block.text === "string") return block.text;
	if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking;
	if (block.type === "reasoning" && typeof block.text === "string") return block.text;
	if (block.type === "toolCall" || block.type === "tool-call") {
		const name = typeof block.name === "string" ? block.name : "tool";
		let args = "{}";
		try {
			args = typeof block.arguments === "string"
				? block.arguments
				: JSON.stringify(block.arguments ?? {}) ?? "{}";
		} catch {
			args = "{}";
		}
		return `${name} ${args}`;
	}
	if (block.type === "image") {
		const mimeType = typeof block.mimeType === "string" ? block.mimeType : "image";
		return `[${mimeType}]`;
	}
	if (typeof block.text === "string") return block.text;
	if (typeof block.content === "string") return block.content;
	return "";
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (isRecord(part) ? textFromBlock(part as TextBlock) : typeof part === "string" ? part : ""))
		.filter(Boolean)
		.join("\n");
}

export function messageText(message: unknown): string {
	if (!isRecord(message)) return "";
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

function toolCallIds(message: unknown): string[] {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content
		.filter((part): part is Record<string, unknown> =>
			isRecord(part) && (part.type === "toolCall" || part.type === "tool-call"),
		)
		.map((part) => (typeof part.id === "string" ? part.id : ""))
		.filter(Boolean);
}

function sourceIsEditable(entry: ProjectionEntryLike): boolean {
	if (entry.sourceEntry.type !== "message" && entry.sourceEntry.type !== "custom_message") return false;
	if (entry.sourceEntry.type === "custom_message" && entry.sourceEntry.customType === "oh-my-clm") return false;
	return true;
}

function editableRole(message: unknown): MirrorRole | undefined {
	if (!isRecord(message)) return undefined;
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
export function buildMirrorRecords(
	entries: readonly ProjectionEntryLike[],
	options: MirrorBuildOptions = {},
): MirrorRecord[] {
	const hasCompaction = entries.some((entry) =>
		entry.messages.some((message) => isRecord(message) && message.role === "compactionSummary"),
	);
	const records: MirrorRecord[] = [];
	const seen = new Set<string>();

	for (const entry of entries) {
		if (!sourceIsEditable(entry) || !entry.sourceEntry.id || seen.has(entry.sourceEntry.id)) continue;
		const message = entry.messages.find((candidate) => editableRole(candidate)) ?? entry.messages[0];
		const role = editableRole(message);
		if (!role) continue;
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

function selfReferenceText(text: string, mirrorPath?: string): string | undefined {
	const normalized = normalizeText(text);
	if (!normalized) return undefined;
	const looksLikeMirror = normalized.includes(MIRROR_HEADER) && normalized.includes("[[CLM_ENTRY");
	const namesTheMirror = Boolean(mirrorPath && normalized.includes(mirrorPath));
	if (!looksLikeMirror && !namesTheMirror) return undefined;
	return "[oh-my-clm] Self-referential live-context output omitted from the editable mirror (" +
		normalized.length +
		" source characters). The canonical tool result remains available for explicit context editing.";
}

function compactMirrorText(text: string, maxChars: number): string {
	const normalized = normalizeText(text);
	if (normalized.length <= maxChars) return normalized;
	const marker = "\n...[oh-my-clm mirror preview truncated; " +
		normalized.length +
		" source characters retained unless this block is edited]...\n";
	const available = Math.max(0, maxChars - marker.length);
	const head = Math.ceil(available * 0.6);
	const tail = Math.max(0, available - head);
	return (normalized.slice(0, head) + marker + (tail > 0 ? normalized.slice(-tail) : "")).trim();
}

function applyMirrorDisplayBudget(records: readonly MirrorRecord[], options: MirrorBuildOptions): MirrorRecord[] {
	const maxBlockChars = Math.max(256, options.maxBlockChars ?? DEFAULT_MAX_BLOCK_CHARS);
	const maxMirrorChars = Math.max(maxBlockChars, options.maxMirrorChars ?? DEFAULT_MAX_MIRROR_CHARS);
	const editableCount = records.filter((record) => !record.protected).length;
	const fairShare = editableCount > 0 ? Math.max(256, Math.floor(maxMirrorChars / editableCount)) : maxBlockChars;
	return records.map((record) => {
		if (record.protected) return { ...record, renderText: undefined };
		const safeText = record.role === "toolResult" ? selfReferenceText(record.text, options.mirrorPath) ?? record.text : record.text;
		const renderText = compactMirrorText(safeText, Math.min(maxBlockChars, fairShare));
		return { ...record, renderText: renderText === record.text ? undefined : renderText };
	});
}

function decodeId(id: string): string {
	try {
		return decodeURIComponent(id);
	} catch {
		return id;
	}
}

function editableDisplayIds(records: readonly MirrorRecord[]): Map<string, string> {
	const ids = new Map<string, string>();
	let index = 0;
	for (const record of records) {
		if (!record.protected) ids.set(record.id, String(++index));
	}
	return ids;
}

export interface BlockIndexOptions {
	/** Maximum characters of one block preview shown in the index. */
	maxPreviewChars?: number;
	/** Number of leading editable blocks listed in the index. */
	headBlocks?: number;
	/** Number of blocks listed immediately after the head; the rest are not listed. */
	middleBlocks?: number;
}

function blockPreview(text: string, maxChars: number): string {
	const collapsed = normalizeText(text).replace(/\s+/g, " ");
	if (!collapsed) return "(empty)";
	if (collapsed.length <= maxChars) return collapsed;
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
 * Only the dynamic payload lives here. The cleanup discipline, the head/middle
 * rule, the load-bearing note, and the refresh cadence belong to the host's
 * stable system-prompt section so they are cached once instead of repeated in
 * every runtime-context snapshot.
 *
 * The index lists a contiguous prefix: the first `headBlocks` editable blocks,
 * then the next `middleBlocks`. It intentionally omits the tail and the
 * middle-range summary; later IDs have to be discovered from the mirror.
 */
export function renderBlockIndex(
	records: readonly MirrorRecord[],
	options: BlockIndexOptions = {},
): string {
	const editable = records.filter((record) => !record.protected);
	if (editable.length === 0) return "";
	const displayIds = editableDisplayIds(records);
	const maxPreviewChars = Math.max(24, Math.floor(options.maxPreviewChars ?? DEFAULT_BLOCK_INDEX_PREVIEW_CHARS));
	const headCount = Math.max(0, Math.floor(options.headBlocks ?? DEFAULT_BLOCK_INDEX_HEAD));
	const middleCount = Math.max(0, Math.floor(options.middleBlocks ?? DEFAULT_BLOCK_INDEX_MIDDLE));
	const lineFor = (record: MirrorRecord): string => {
		const blockId = displayIds.get(record.id) ?? record.id;
		return `${blockId}. ${record.role}: ${blockPreview(record.text, maxPreviewChars)}`;
	};
	const lines = editable
		.slice(0, Math.min(editable.length, headCount + middleCount))
		.map(lineFor);
	return [
		"<oh-my-clm-block-index>",
		"Editable blocks by cleanup ID; call cleanup({ blockIds: [...] }) to omit them.",
		...lines,
		"</oh-my-clm-block-index>",
	].join("\n");
}

export function renderMirror(records: readonly MirrorRecord[], options: { snapshot?: string } = {}): string {
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

	if (blocks.length === 0) blocks.push(EMPTY_MARKER);
	return [...header, ...blocks].join("\n\n") + "\n";
}

export function parseMirror(text: string): ParsedMirror {
	const normalized = String(text ?? "").replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	const version = lines.some((line) => line.trim() === MIRROR_HEADER) ? MIRROR_VERSION : undefined;
	const snapshot = lines.map((line) => line.trim().match(SNAPSHOT_PATTERN)?.[1]).find(Boolean);
	const blocks = new Map<string, ParsedMirrorBlock>();
	const duplicateIds: string[] = [];
	const missingEndIds: string[] = [];
	let empty = false;
	let malformed = false;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]?.trim() ?? "";
		if (line === EMPTY_MARKER) {
			if (blocks.size > 0) malformed = true;
			empty = true;
			continue;
		}
		const match = line.match(BLOCK_START_PATTERN);
		if (!match) continue;
		const encodedId = match[1] ?? "";
		const id = decodeId(encodedId);
		const role = match[2] ?? "user";
		const endMarker = "[[/CLM_ENTRY id=" + encodedId + "]]";
		let end = index + 1;
		while (end < lines.length && (lines[end]?.trim() ?? "") !== endMarker) end += 1;
		if (end >= lines.length) {
			missingEndIds.push(id);
			malformed = true;
			break;
		}
		const block = { id, role, body: lines.slice(index + 1, end).join("\n").trim() };
		if (blocks.has(id)) duplicateIds.push(id);
		else blocks.set(id, block);
		index = end;
	}

	if (empty && blocks.size > 0) malformed = true;
	const recognized = Boolean(version && snapshot && !malformed && (empty || blocks.size > 0));
	return { recognized, version, snapshot, empty, malformed, blocks, duplicateIds, missingEndIds };
}

export function normalizeText(text: string): string {
	return String(text ?? "").replace(/\r\n?/g, "\n").trim();
}

function estimatorMessage(message: unknown): Record<string, unknown> | undefined {
	if (!isRecord(message) || typeof message.role !== "string") return undefined;
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

function fallbackEstimatorMessage(role: MirrorRole, text: string, toolCallId?: string): Record<string, unknown> {
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

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function contentEstimateChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	return content.reduce((total, part) => {
		if (!isRecord(part)) return total + (typeof part === "string" ? part.length : 0);
		if (part.type === "text" && typeof part.text === "string") return total + part.text.length;
		if (part.type === "thinking" && typeof part.thinking === "string") return total + part.thinking.length;
		if (part.type === "reasoning" && typeof part.text === "string") return total + part.text.length;
		if (part.type === "image") return total + ESTIMATED_IMAGE_CHARS;
		return total;
	}, 0);
}

/** Match Pi's system-message text projection without importing the Pi host. */
function systemTextChars(message: Record<string, unknown>): number {
	const parts: string[] = [];
	const content = message.content;
	if (typeof content === "string") {
		parts.push(content);
	} else if (Array.isArray(content)) {
		parts.push(content
			.filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text" && typeof part.text === "string")
			.map((part) => part.text as string)
			.join("\n"));
	}
	const sections = message.sections;
	if (isRecord(sections)) {
		for (const value of Object.values(sections)) {
			if (typeof value === "string") parts.push(value);
		}
	}
	return parts.filter((part) => part.length > 0).join("\n\n").length;
}

/** Match Pi's independent rounding for system tool additions/removals. */
function estimateToolsTokens(tools: unknown): number {
	if (!Array.isArray(tools) || tools.length === 0) return 0;
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
export function estimateMessageTokens(message: unknown): number {
	const candidate = estimatorMessage(message);
	if (!candidate) return 0;
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
					if (!isRecord(part)) continue;
					if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
						chars += part.text.length;
					} else if (part.type === "thinking" && typeof part.thinking === "string") {
						chars += part.thinking.length;
					} else if (part.type === "toolCall" || part.type === "tool-call") {
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
export function estimateTokens(texts: readonly string[]): number {
	return texts.reduce(
		(total, text) => total + estimateMessageTokens(fallbackEstimatorMessage("user", text)),
		0,
	);
}

function estimateRecordTokens(record: MirrorRecord, text: string, useSourceMessage = text === record.text): number {
	const source = useSourceMessage ? estimatorMessage(record.sourceMessage) : undefined;
	return estimateMessageTokens(source ?? fallbackEstimatorMessage(record.role, text, record.toolCallId));
}

/** Estimate mirror records while preserving their original structured messages. */
export function estimateMirrorTokens(
	records: readonly MirrorRecord[],
	textForRecord?: (record: MirrorRecord) => string,
): number {
	const useSourceMessage = textForRecord === undefined;
	const selectText = textForRecord ?? ((record: MirrorRecord) => record.text);
	return records.reduce(
		(total, record) => total + estimateRecordTokens(record, selectText(record), useSourceMessage),
		0,
	);
}

export function mirrorSignature(records: readonly MirrorRecord[]): string {
	return records
		.map((record) =>
			[
				record.id,
				record.role,
				record.protected ? "1" : "0",
				normalizeText(record.text),
				normalizeText(record.renderText ?? ""),
			].join("\u0000"),
		)
		.join("\u0001");
}

export function mirrorFingerprint(records: readonly MirrorRecord[]): string {
	return createHash("sha256").update(mirrorSignature(records)).digest("hex").slice(0, 16);
}

function contentReplacement(role: MirrorRole, text: string): unknown {
	if (role === "assistant" || role === "toolResult") return [{ type: "text", text }];
	return text;
}

interface DesiredAction {
	kind: "keep" | "replace" | "omit";
	body?: string;
	reason?: string;
}

/**
 * Turn a user/model-edited mirror into append-only Pi context edits. The
 * function deliberately cannot add arbitrary new entries: a summary replaces
 * an existing block, which keeps the session tree and role constraints valid.
 */
export function planContextEdits(
	records: readonly MirrorRecord[],
	parsed: ParsedMirror,
	options: EditPlanOptions = {},
): EditPlan {
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

	const warnings: string[] = [];
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
	const aliases = new Map<string, Set<string>>();
	for (const record of records) {
		const addAlias = (alias: string | undefined) => {
			if (!alias) return;
			const owners = aliases.get(alias) ?? new Set<string>();
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
	const blockForRecord = (record: MirrorRecord): ParsedMirrorBlock | undefined =>
		parsed.blocks.get(record.id) ?? parsed.blocks.get(displayIds.get(record.id) ?? "");
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
	if (unknownIds.length > 0) warnings.push(`Unknown CLM_ENTRY ignored: ${unknownIds.join(", ")}`);
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
			if (record.role !== "user" || options.allowUserReplacement) return false;
			const block = blockForRecord(record);
			if (!block) return false;
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

	const actions = new Map<string, DesiredAction>();
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
		} else if (renderedBaseline === body) {
			actions.set(record.id, { kind: "keep" });
		} else {
			actions.set(record.id, { kind: "replace", body, reason: "block edited" });
		}
	}

	const byToolCallId = new Map<string, MirrorRecord>();
	for (const record of records) {
		for (const id of record.toolCallIds) byToolCallId.set(id, record);
	}
	const byResultCallId = new Map<string, MirrorRecord>();
	for (const record of records) {
		if (record.role === "toolResult" && record.toolCallId) byResultCallId.set(record.toolCallId, record);
	}

	const omit = (record: MirrorRecord, reason: string): boolean => {
		if (record.protected) {
			warnings.push(`Could not remove protected entry ${record.id}; ${reason}.`);
			return false;
		}
		const current = actions.get(record.id);
		if (!current || current.kind !== "omit") actions.set(record.id, { kind: "omit", reason });
		return true;
	};

	// Replacing an assistant block removes Pi tool-call metadata. Remove the
	// paired tool results too, otherwise the provider would see orphan results.
	for (const record of records) {
		const action = actions.get(record.id);
		if (record.role === "assistant" && record.toolCallIds.length > 0 && action?.kind !== "keep") {
			for (const callId of record.toolCallIds) {
				const result = byResultCallId.get(callId);
				if (result) omit(result, `assistant tool call ${callId} was rewritten`);
			}
		}
	}

	// Removing a tool result also removes its owner assistant turn, preventing
	// an assistant tool call from surviving without a result.
	for (const record of records) {
		if (record.role !== "toolResult" || actions.get(record.id)?.kind !== "omit" || !record.toolCallId) continue;
		const owner = byToolCallId.get(record.toolCallId);
		const ownerAction = owner ? actions.get(owner.id) : undefined;
		if (owner && ownerAction?.kind === "keep") omit(owner, `tool result ${record.id} was removed`);
	}
	// The previous pass can newly omit an owner, so repeat the paired-result rule.
	for (const record of records) {
		const action = actions.get(record.id);
		if (record.role === "assistant" && record.toolCallIds.length > 0 && action?.kind === "omit") {
			for (const callId of record.toolCallIds) {
				const result = byResultCallId.get(callId);
				if (result) omit(result, `assistant tool call ${callId} was removed`);
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
		const action = actions.get(record.id) ?? { kind: "keep" as const };
		if (action.kind === "omit") return total;
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

	const edits: ContextEditDraft[] = [];
	for (const record of records) {
		const action = actions.get(record.id);
		if (!action || action.kind === "keep" || record.protected) continue;
		if (action.kind === "omit") {
			edits.push({ targetId: record.id, replacement: null, reason: "omit" });
		} else {
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
