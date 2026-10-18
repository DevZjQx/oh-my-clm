import {
	MIRROR_HEADER,
	MIRROR_VERSION,
	mirrorFingerprint,
	estimateMirrorTokens,
	type ContextEditDraft,
	type EditPlan,
	type MirrorRecord,
} from "./context-format.ts";

const SNAPSHOT_PATTERN = /^<!-- CLM_SNAPSHOT ([a-f0-9]{16}) -->$/;
const BLOCK_START_PATTERN = /^\[\[CLM_ENTRY\s+id=([^\s\]]+)\s+role=([^\s\]]+)\]\]$/;
const EMPTY_MARKER = "<!-- CLM_EMPTY -->";

/**
 * Cleanup only needs mirror structure. In particular, values in `blocks` do
 * not contain body text, so ID validation cannot accidentally depend on a
 * truncated preview or reconstruct a body for an old_string edit.
 */
export interface CleanupParsedMirror {
	recognized: boolean;
	version?: string;
	snapshot?: string;
	empty: boolean;
	malformed: boolean;
	blocks: ReadonlyMap<string, { role: string }>;
	duplicateIds: string[];
	missingEndIds: string[];
}

export interface CleanupArgs {
	blockIds: number[];
}

/**
 * How much of a cleanup result survives into the model-visible tool result.
 * `compact` is the default because the live block index is re-rendered in
 * every step's runtime context; repeating it in the result only spends tokens.
 */
export type CleanupResultCopy = "compact" | "full" | "none";

export interface CleanupToolResult {
	status: "applied" | "rejected";
	requestedBlockIds: number[];
	removedBlockIds: number[];
	reason: string;
	/** Fresh block index after the mutation (or the current one on rejection). */
	blockIndex?: string;
	/** Copy mode; absent results keep the legacy `full` formatter behavior. */
	copy?: CleanupResultCopy;
}

export interface CleanupPlan extends EditPlan {
	requestedBlockIds: number[];
	removedBlockIds: number[];
}

export interface CleanupPlanOptions {
	/** Approximate fixed request tokens outside the editable mirror. */
	fixedTokens?: number;
	/** Keep the first visible editable block as a load-bearing anchor. */
	preserveFirstBlock?: boolean;
}

interface DisplayRecord {
	blockId: number;
	record: MirrorRecord;
}

interface CleanupAction {
	record: MirrorRecord;
	reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function decodeId(id: string): string {
	try {
		return decodeURIComponent(id);
	} catch {
		return id;
	}
}

function fixedTokens(options: CleanupPlanOptions): number {
	return nonNegativeSafeInteger(options.fixedTokens) ? options.fixedTokens : 0;
}

function displayRecords(records: readonly MirrorRecord[]): DisplayRecord[] {
	let blockId = 0;
	return records.flatMap((record) => {
		if (record.protected) return [];
		blockId += 1;
		return [{ blockId, record }];
	});
}

function rejectPlan(
	requestedBlockIds: readonly number[],
	reason: string,
	beforeTokens = 0,
): CleanupPlan {
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
	};
}

/**
 * Validate the model-facing cleanup argument in both host adapters. Host
 * schemas catch basic JSON types; this check owns cross-host constraints such
 * as non-empty, unique, positive safe integer IDs.
 */
export function parseCleanupArgs(value: unknown):
	| { ok: true; args: CleanupArgs }
	| { ok: false; reason: string } {
	if (!isRecord(value) || !Array.isArray(value.blockIds)) {
		return { ok: false, reason: "cleanup requires { blockIds: number[] }." };
	}
	const unknownKeys = Object.keys(value).filter((key) => key !== "blockIds");
	if (unknownKeys.length > 0) {
		return { ok: false, reason: `cleanup does not accept unknown field(s): ${unknownKeys.join(", ")}.` };
	}
	if (value.blockIds.length === 0) {
		return { ok: false, reason: "cleanup requires at least one block ID." };
	}
	const blockIds: number[] = [];
	const seen = new Set<number>();
	for (const valueId of value.blockIds) {
		if (!positiveSafeInteger(valueId)) {
			return { ok: false, reason: "cleanup block IDs must be positive safe integers." };
		}
		if (seen.has(valueId)) {
			return { ok: false, reason: `cleanup block ID ${valueId} was supplied more than once.` };
		}
		seen.add(valueId);
		blockIds.push(valueId);
	}
	return { ok: true, args: { blockIds } };
}

export function parseCleanupMirror(text: string): CleanupParsedMirror {
	const normalized = String(text ?? "").replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	const version = lines.some((line) => line.trim() === MIRROR_HEADER) ? MIRROR_VERSION : undefined;
	const snapshot = lines.map((line) => line.trim().match(SNAPSHOT_PATTERN)?.[1]).find(Boolean);
	const blocks = new Map<string, { role: string }>();
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
		const endMarker = `[[/CLM_ENTRY id=${encodedId}]]`;
		let end = index + 1;
		while (end < lines.length && (lines[end]?.trim() ?? "") !== endMarker) end += 1;
		if (end >= lines.length) {
			missingEndIds.push(id);
			malformed = true;
			break;
		}
		if (blocks.has(id)) duplicateIds.push(id);
		else blocks.set(id, { role });
		index = end;
	}

	if (empty && blocks.size > 0) malformed = true;
	const recognized = Boolean(version && snapshot && !malformed && (empty || blocks.size > 0));
	return { recognized, version, snapshot, empty, malformed, blocks, duplicateIds, missingEndIds };
}

/** Build the structural mirror view for DSH cleanup without rendering bodies. */
export function cleanupMirrorForRecords(records: readonly MirrorRecord[]): CleanupParsedMirror {
	const blocks = new Map<string, { role: string }>();
	let blockId = 0;
	for (const record of records) {
		if (record.protected) continue;
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

function validateMirrorForCleanup(
	records: readonly MirrorRecord[],
	parsed: CleanupParsedMirror,
	requestedBlockIds: readonly number[],
	options: CleanupPlanOptions,
): CleanupPlan | undefined {
	const beforeTokens = fixedTokens(options) + estimateMirrorTokens(records);
	if (!parsed.recognized) {
		return rejectPlan(
			requestedBlockIds,
			parsed.malformed
				? `Malformed ${MIRROR_VERSION} mirror; refusing to clean a partial document.`
				: "No valid CLM mirror header was found; refusing to clean the file.",
			beforeTokens,
		);
	}
	if (parsed.snapshot !== mirrorFingerprint(records)) {
		return rejectPlan(requestedBlockIds, "The mirror snapshot is stale; refresh it before cleanup.", beforeTokens);
	}
	if (parsed.duplicateIds.length > 0) {
		return rejectPlan(
			requestedBlockIds,
			`Duplicate CLM_ENTRY ids are not allowed: ${parsed.duplicateIds.join(", ")}`,
			beforeTokens,
		);
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
		return rejectPlan(
			requestedBlockIds,
			`Unknown CLM_ENTRY ids are not allowed: ${unknownIds.join(", ")}`,
			beforeTokens,
		);
	}
	const missingIds = [...expectedIds].filter((id) => !actualIds.has(id));
	if (missingIds.length > 0) {
		return rejectPlan(
			requestedBlockIds,
			`The mirror is missing current CLM_ENTRY ids: ${missingIds.join(", ")}`,
			beforeTokens,
		);
	}
	for (const entry of displayed) {
		const block = parsed.blocks.get(String(entry.blockId));
		if (!block) continue;
		if (block.role !== entry.record.role) {
			return rejectPlan(
				requestedBlockIds,
				`CLM_ENTRY role changed for block ${entry.blockId}; refusing cleanup.`,
				beforeTokens,
			);
		}
	}

	for (const blockId of requestedBlockIds) {
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
export function planCleanup(
	records: readonly MirrorRecord[],
	parsed: CleanupParsedMirror,
	requestedBlockIds: readonly number[],
	options: CleanupPlanOptions = {},
): CleanupPlan {
	const args = parseCleanupArgs({ blockIds: [...requestedBlockIds] });
	if (!args.ok) return rejectPlan(requestedBlockIds, args.reason);

	const validation = validateMirrorForCleanup(records, parsed, args.args.blockIds, options);
	if (validation) return validation;

	const displayed = displayRecords(records);
	const byBlockId = new Map(displayed.map((entry) => [entry.blockId, entry.record]));
	const byToolCallId = new Map<string, MirrorRecord>();
	const byResultCallId = new Map<string, MirrorRecord>();
	for (const record of records) {
		for (const callId of record.toolCallIds) byToolCallId.set(callId, record);
		if (record.role === "toolResult" && record.toolCallId) byResultCallId.set(record.toolCallId, record);
	}

	const actions = new Map<string, CleanupAction>();
	const pending: CleanupAction[] = [];
	for (const blockId of args.args.blockIds) {
		const record = byBlockId.get(blockId);
		if (record) pending.push({ record, reason: `requested block ${blockId}` });
	}

	const addOmission = (record: MirrorRecord, reason: string): string | undefined => {
		if (record.protected) return `Protected block ${record.id} cannot be omitted.`;
		const displayId = displayed.find((entry) => entry.record.id === record.id)?.blockId;
		if ((options.preserveFirstBlock ?? true) && displayId === 1) {
			return "Cleanup preserves load-bearing block 1, including paired owners.";
		}
		if (!actions.has(record.id)) actions.set(record.id, { record, reason });
		return undefined;
	};

	while (pending.length > 0) {
		const action = pending.shift();
		if (!action || actions.has(action.record.id)) continue;
		const failure = addOmission(action.record, action.reason);
		if (failure) return rejectPlan(args.args.blockIds, failure, fixedTokens(options) + estimateMirrorTokens(records));

		if (action.record.role === "assistant") {
			for (const callId of action.record.toolCallIds) {
				const result = byResultCallId.get(callId);
				if (!result) {
					return rejectPlan(
						args.args.blockIds,
						`Cannot clean assistant block ${displayed.find((entry) => entry.record.id === action.record.id)?.blockId ?? action.record.id} while tool call ${callId} has no current result.`,
						fixedTokens(options) + estimateMirrorTokens(records),
					);
				}
				pending.push({ record: result, reason: `paired result for tool call ${callId}` });
			}
		}
		if (action.record.role === "toolResult" && action.record.toolCallId) {
			const owner = byToolCallId.get(action.record.toolCallId);
			if (owner) pending.push({ record: owner, reason: `owner of tool result ${action.record.id}` });
		}
	}

	const omitted = records.filter((record) => actions.has(record.id));
	const beforeTokens = fixedTokens(options) + estimateMirrorTokens(records);
	const afterTokens = fixedTokens(options) + records.reduce((total, record) => {
		return actions.has(record.id) ? total : total + estimateMirrorTokens([record]);
	}, 0);
	if (afterTokens >= beforeTokens) {
		return rejectPlan(
			args.args.blockIds,
			"Cleanup must strictly shrink the estimated context; no safe cleanup was applied.",
			beforeTokens,
		);
	}

	const removedBlockIds = omitted
		.map((record) => displayed.find((entry) => entry.record.id === record.id)?.blockId)
		.filter((blockId): blockId is number => blockId !== undefined);
	const edits: ContextEditDraft[] = omitted.map((record) => ({
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
	};
}

/**
 * Remove whole CLM_ENTRY spans from a mirror after planCleanup has validated
 * the protocol. This preserves all header comments and never reconstructs a
 * block body from the visible preview.
 */
export function removeMirrorBlocks(text: string, blockIds: readonly number[]): string {
	const normalized = String(text ?? "").replace(/\r\n?/g, "\n");
	const targets = new Set(blockIds.map((blockId) => String(blockId)));
	const lines = normalized.split("\n");
	const kept: string[] = [];
	let retainedBlocks = 0;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]?.trim() ?? "";
		const match = line.match(BLOCK_START_PATTERN);
		if (!match || !targets.has(decodeId(match[1] ?? ""))) {
			if (match) retainedBlocks += 1;
			kept.push(lines[index] ?? "");
			continue;
		}
		const encodedId = match[1] ?? "";
		const endMarker = `[[/CLM_ENTRY id=${encodedId}]]`;
		let end = index + 1;
		while (end < lines.length && (lines[end]?.trim() ?? "") !== endMarker) end += 1;
		if (end >= lines.length) throw new Error(`Cannot remove malformed CLM_ENTRY id=${encodedId}.`);
		index = end;
	}

	let result = kept.join("\n");
	if (!result.endsWith("\n")) result += "\n";
	const hasEmptyMarker = kept.some((line) => line.trim() === EMPTY_MARKER);
	if (retainedBlocks === 0 && !hasEmptyMarker) {
		result = result.trimEnd() + `\n\n${EMPTY_MARKER}\n`;
	}
	return result;
}

export function cleanupToolResult(
	plan: Pick<CleanupPlan, "status" | "requestedBlockIds" | "removedBlockIds" | "reason">,
	blockIndex?: string,
	copy: CleanupResultCopy = "compact",
): CleanupToolResult {
	const result: CleanupToolResult = {
		status: plan.status === "applied" ? "applied" : "rejected",
		requestedBlockIds: [...plan.requestedBlockIds],
		removedBlockIds: [...plan.removedBlockIds],
		reason: plan.status === "applied" ? "" : plan.reason ?? "Cleanup was rejected.",
		copy,
	};
	if (blockIndex) result.blockIndex = blockIndex;
	return result;
}

/**
 * Parse the `CLM_CLEANUP_RESULT` environment value. Unknown values fall back
 * to `compact` so a typo never silently restores the verbose result.
 */
export function parseCleanupResultCopy(value: string | undefined): CleanupResultCopy {
	return value === "full" || value === "none" ? value : "compact";
}

export function formatCleanupToolResult(result: CleanupToolResult): string {
	const copy = result.copy ?? "full";
	if (copy === "none") return "";
	const summary = result.status === "applied"
		? `cleanup applied; removed block(s): ${result.removedBlockIds.join(", ")}.`
		: `cleanup rejected; ${result.reason}`;
	return copy === "full" && result.blockIndex ? `${summary}\n\n${result.blockIndex}` : summary;
}

