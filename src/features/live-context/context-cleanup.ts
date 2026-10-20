import {
	MIRROR_HEADER,
	MIRROR_VERSION,
	mirrorFingerprint,
	estimateMirrorTokens,
	renderBlockList,
	scanMirrorBlocks,
	type ContextEditDraft,
	type EditPlan,
	type MirrorRecord,
	type MirrorRole,
} from "./context-format.ts";

const SNAPSHOT_PATTERN = /^<!-- CLM_SNAPSHOT ([a-f0-9]{16}) -->$/;
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
	/** Expanded 1-based block IDs, sorted and unique. */
	blockIds: number[];
	/** IDs named one at a time in `blockIds` (strict: an unknown ID rejects). */
	explicitIds: number[];
	/** IDs produced by an inclusive `ranges` entry (lenient: out-of-range IDs clamp). */
	rangedIds: number[];
	/** Roles to leave in place even when a requested range covers them. */
	skipRoles: MirrorRole[];
	/**
	 * Read-only drill-down target. `cleanup({ list: "A-B" })` returns the rows of
	 * that range instead of removing anything, so a model can inspect a gap the
	 * index only named without opening the full mirror.
	 */
	list?: CleanupListTarget;
}

export interface CleanupListTarget {
	start: number;
	end: number;
}

/** Widest inclusive range a single cleanup call may expand to. */
const MAX_RANGE_SPAN = 10_000;
const RANGE_PATTERN = /^(\d+)(?:\s*-\s*(\d+))?$/;
const CLEANUP_ROLES: readonly MirrorRole[] = ["user", "assistant", "toolResult", "custom"];

/**
 * How much of a cleanup result survives into the model-visible tool result.
 * `compact` is the default because the live block index is re-rendered in
 * every step's runtime context; repeating it in the result only spends tokens.
 */
export type CleanupResultCopy = "compact" | "full" | "none";

export interface CleanupToolResult {
	status: "applied" | "rejected" | "listed";
	requestedBlockIds: number[];
	removedBlockIds: number[];
	/** Removed only to keep a tool call/result pair structurally valid. */
	pairedRemovalIds: number[];
	reason: string;
	/** Fresh block index after the mutation (or the current one on rejection). */
	blockIndex?: string;
	/** Read-only rows returned by `cleanup({ list: "A-B" })`; never set on a mutation. */
	rows?: string;
	/** Copy mode; absent results keep the legacy `full` formatter behavior. */
	copy?: CleanupResultCopy;
}

export interface CleanupPlan extends EditPlan {
	requestedBlockIds: number[];
	removedBlockIds: number[];
	/**
	 * Removed because they are paired with a requested block (an assistant
	 * tool call with its result, or a result with its owner). Reported
	 * separately so an omitted ID is never mistaken for a wrong index.
	 */
	pairedRemovalIds: number[];
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

/** The expanded ID list of either accepted target form. */
function requestedIdList(value: CleanupArgs | readonly number[]): number[] {
	if (Array.isArray(value)) return [...value];
	return [...(value as CleanupArgs).blockIds];
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
 *
 * A third form, `list: "A-B"`, is read-only. It exists because the index names
 * gaps by range but cannot show what is inside them, and the model must be able
 * to inspect a range before deleting it without paying for the whole mirror.
 */
export function parseCleanupArgs(value: unknown):
	| { ok: true; args: CleanupArgs }
	| { ok: false; reason: string } {
	if (!isRecord(value)) {
		return { ok: false, reason: "cleanup requires { blockIds: number[] } and/or { ranges: string[] }." };
	}
	const unknownKeys = Object.keys(value).filter((key) =>
		key !== "blockIds" && key !== "ranges" && key !== "skipRoles" && key !== "list",
	);
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

	const rawList = value.list;
	let list: CleanupListTarget | undefined;
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
		if (rawBlockIds.length > 0 || rawRanges.length > 0 || rawSkipRoles.length > 0) {
			return {
				ok: false,
				reason: "cleanup list is read-only; call it with only `list`, then call cleanup again with the targets you verified.",
			};
		}
		list = { start, end };
	}

	const explicitIds: number[] = [];
	const seen = new Set<number>();
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

	const ranged = new Set<number>();
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
		for (let blockId = start; blockId <= end; blockId += 1) ranged.add(blockId);
	}

	const skipRoles: MirrorRole[] = [];
	for (const role of rawSkipRoles) {
		if (typeof role !== "string" || !CLEANUP_ROLES.includes(role as MirrorRole)) {
			return { ok: false, reason: `cleanup skipRoles must use one of: ${CLEANUP_ROLES.join(", ")}.` };
		}
		if (!skipRoles.includes(role as MirrorRole)) skipRoles.push(role as MirrorRole);
	}

	if (list) {
		return { ok: true, args: { blockIds: [], explicitIds: [], rangedIds: [], skipRoles, list } };
	}
	const rangedIds = [...ranged].filter((blockId) => !seen.has(blockId)).sort((a, b) => a - b);
	const blockIds = [...explicitIds, ...rangedIds].sort((a, b) => a - b);
	if (blockIds.length === 0) {
		return { ok: false, reason: "cleanup requires at least one block ID or range." };
	}
	return { ok: true, args: { blockIds, explicitIds, rangedIds, skipRoles } };
}

/** Normalize either target form so every planner entry point stays compatible. */
export function normalizeCleanupArgs(value: CleanupArgs | readonly number[]):
	| { ok: true; args: CleanupArgs }
	| { ok: false; reason: string } {
	if (Array.isArray(value)) {
		return parseCleanupArgs({ blockIds: [...value] });
	}
	return { ok: true, args: value as CleanupArgs };
}

export function parseCleanupMirror(text: string): CleanupParsedMirror {
	const normalized = String(text ?? "").replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	const version = lines.some((line) => line.trim() === MIRROR_HEADER) ? MIRROR_VERSION : undefined;
	const snapshot = lines.map((line) => line.trim().match(SNAPSHOT_PATTERN)?.[1]).find(Boolean);
	const scan = scanMirrorBlocks(normalized);
	const blocks = new Map<string, { role: string }>();
	for (const span of scan.blocks) {
		if (!blocks.has(span.id)) blocks.set(span.id, { role: span.role });
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
	args: CleanupArgs,
	options: CleanupPlanOptions,
): CleanupPlan | undefined {
	const requestedBlockIds = args.blockIds;
	const beforeTokens = fixedTokens(options) + estimateMirrorTokens(records);
	if (!parsed.recognized) {
		return rejectPlan(
			requestedBlockIds,
			parsed.malformed
				? `Malformed ${MIRROR_VERSION} mirror; refusing to clean a partial document` +
					(parsed.missingEndIds.length > 0
						? ` (unclosed CLM_ENTRY id(s): ${parsed.missingEndIds.join(", ")}).`
						: ".")
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
			`Duplicate CLM_ENTRY ids are not allowed: ${[...new Set(parsed.duplicateIds)].join(", ")}.` +
				" A marker line inside a body needs one leading backslash.",
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
export function planCleanup(
	records: readonly MirrorRecord[],
	parsed: CleanupParsedMirror,
	requested: CleanupArgs | readonly number[],
	options: CleanupPlanOptions = {},
): CleanupPlan {
	const args = normalizeCleanupArgs(requested);
	const requestedBlockIds = requestedIdList(requested);
	if (!args.ok) return rejectPlan(requestedBlockIds, args.reason);
	if (args.args.list) {
		// A listing never reaches the mutation planner. Both hosts branch before
		// this point; this guard keeps a future caller from treating rows as
		// targets.
		return rejectPlan(
			[],
			"cleanup list is read-only; it does not remove blocks.",
			fixedTokens(options) + estimateMirrorTokens(records),
		);
	}

	const validation = validateMirrorForCleanup(records, parsed, args.args, options);
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
	const rangedIds = new Set(args.args.rangedIds);
	const preserveFirst = options.preserveFirstBlock ?? true;
	const ownerBlockId = (record: MirrorRecord): number | undefined => {
		if (!record.toolCallId) return undefined;
		const owner = byToolCallId.get(record.toolCallId);
		return owner ? displayed.find((entry) => entry.record.id === owner.id)?.blockId : undefined;
	};
	for (const blockId of args.args.blockIds) {
		const record = byBlockId.get(blockId);
		if (!record) continue;
		// Block 1 is the load-bearing anchor: a range that covers it keeps it.
		if (preserveFirst && blockId === 1 && rangedIds.has(blockId)) continue;
		// Keeping block 1 means keeping its paired result too; otherwise the
		// batch would be rejected for an owner the model never asked to remove.
		if (preserveFirst && record.role === "toolResult" && ownerBlockId(record) === 1) continue;
		if (args.args.skipRoles.includes(record.role)) continue;
		pending.push({ record, reason: `requested block ${blockId}` });
	}
	if (pending.length === 0) {
		return rejectPlan(
			args.args.blockIds,
			"Nothing in the requested targets is removable: block 1, its paired result, and every skipRoles match are preserved.",
			fixedTokens(options) + estimateMirrorTokens(records),
		);
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
	const requestedSet = new Set(args.args.blockIds);
	const pairedRemovalIds = removedBlockIds.filter((blockId) => !requestedSet.has(blockId));
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
		pairedRemovalIds,
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
export function describeCleanupList(
	records: readonly MirrorRecord[],
	list: CleanupListTarget,
	options: { maxPreviewChars?: number; maxChars?: number } = {},
): CleanupToolResult {
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
export function removeMirrorBlocks(
	text: string,
	blockIds: readonly number[],
): { ok: true; text: string } | { ok: false; reason: string } {
	const normalized = String(text ?? "").replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	const scan = scanMirrorBlocks(normalized);
	if (scan.malformed) {
		const missing = scan.missingEndIds.length > 0
			? `unclosed CLM_ENTRY id(s): ${scan.missingEndIds.join(", ")}`
			: "the empty marker coexists with blocks";
		return { ok: false, reason: `the live mirror is malformed (${missing})` };
	}
	if (scan.duplicateIds.length > 0) {
		return { ok: false, reason: `duplicate CLM_ENTRY id(s): ${[...new Set(scan.duplicateIds)].join(", ")}` };
	}

	const targets = new Set(blockIds.map((blockId) => String(blockId)));
	const spans = new Map<string, { startLine: number; endLine: number }>();
	for (const span of scan.blocks) spans.set(span.id, { startLine: span.startLine, endLine: span.endLine });
	const missingTargets = [...targets].filter((target) => !spans.has(target));
	if (missingTargets.length > 0) {
		return { ok: false, reason: `CLM_ENTRY id(s) not found in the live mirror: ${missingTargets.join(", ")}` };
	}

	const dropped = new Set<number>();
	for (const target of targets) {
		const span = spans.get(target);
		if (!span) continue;
		for (let index = span.startLine; index <= span.endLine; index += 1) dropped.add(index);
		// The renderer separates entries with one blank line; dropping the span
		// plus its trailing separator keeps the remaining document canonical.
		if ((lines[span.endLine + 1] ?? "").trim() === "") dropped.add(span.endLine + 1);
	}

	const kept: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (!dropped.has(index)) kept.push(lines[index] ?? "");
	}
	const retainedBlocks = scan.blocks.length - targets.size;

	let result = kept.join("\n");
	if (!result.endsWith("\n")) result += "\n";
	const hasEmptyMarker = kept.some((line) => line.trim() === EMPTY_MARKER);
	if (retainedBlocks === 0 && !hasEmptyMarker) {
		result = result.trimEnd() + `\n\n${EMPTY_MARKER}\n`;
	}
	return { ok: true, text: result };
}

export function cleanupToolResult(
	plan: Pick<CleanupPlan, "status" | "requestedBlockIds" | "removedBlockIds" | "reason">
		& { pairedRemovalIds?: number[] },
	blockIndex?: string,
	copy: CleanupResultCopy = "compact",
): CleanupToolResult {
	const result: CleanupToolResult = {
		status: plan.status === "applied" ? "applied" : "rejected",
		requestedBlockIds: [...plan.requestedBlockIds],
		removedBlockIds: [...plan.removedBlockIds],
		pairedRemovalIds: [...(plan.pairedRemovalIds ?? [])],
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

/** Compress sorted IDs into inclusive runs: [3,4,5,7] -> "3-5, 7". */
export function formatBlockIdRuns(blockIds: readonly number[]): string {
	const sorted = [...new Set(blockIds)].sort((a, b) => a - b);
	const runs: string[] = [];
	let index = 0;
	while (index < sorted.length) {
		const start = sorted[index]!;
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
export function formatCleanupToolResult(
	result: CleanupToolResult,
	copy: CleanupResultCopy = result.copy ?? "full",
): string {
	if (result.status === "listed") {
		// A listing is the content the caller asked for, so the copy mode must not
		// suppress it; only the one-line mutation confirmation is optional.
		return result.rows ?? "";
	}
	if (copy === "none") return "";
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

