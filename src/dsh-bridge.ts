import {
	buildMirrorRecords,
	DEFAULT_MAX_BLOCK_CHARS,
	DEFAULT_MAX_MIRROR_CHARS,
	mirrorFingerprint,
	mirrorSignature,
	parseMirror,
	planContextEdits,
	renderMirror,
	type EditPlan,
	type MirrorRecord,
	type ProjectionEntryLike,
} from "./context-format.ts";

/** The DSH-facing mirror location deliberately matches the Pi adapter. */
export const DSH_MIRROR_RELATIVE_PATH = ".pi/clm/LIVE_CTX_MAIN.md";
/** A proposal file; DSH does not have Pi's branch-local `context_edit`. */
export const DSH_PATCH_RELATIVE_PATH = ".pi/clm/LIVE_CTX_MAIN.patch.json";
export const DSH_PATCH_VERSION = "oh-my-clm-dsh-patch-v1";

export interface DshSessionEventLike {
	seq: number;
	type: string;
	data: unknown;
}

export interface DshSessionLike {
	readonly id: string;
	readonly header?: { readonly cwd?: string };
	readonly surface: { readonly nodes: readonly number[] };
	snapshotEvents(): readonly DshSessionEventLike[];
}

export interface DshFileSystem {
	readText(filePath: string): string | undefined;
	writeText(filePath: string, content: string): void;
}

export interface DshBridgeOptions {
	mirrorPath: string;
	/** Path wording shown to the model for self-reference detection. */
	mirrorDisplayPath?: string;
	patchPath: string;
	sessionId: string;
	maxBlockChars?: number;
	maxMirrorChars?: number;
	/** DSH has no Pi context-edit boundary; proposals are always shrink-only. */
	fixedTokens?: number;
	now?: () => number;
}

export interface DshMirrorSnapshot {
	filePath: string;
	records: MirrorRecord[];
	rendered: string;
	signature: string;
}

export interface DshBridgeState {
	snapshot?: DshMirrorSnapshot;
	/** Avoid rewriting the same rejected/applied file on every pre-step. */
	lastProcessedMirror?: string;
}

export interface DshPatchEdit {
	targetId: string;
	role: MirrorRecord["role"];
	action: "replace" | "omit";
	body?: string;
	replacement: { content: unknown } | null;
	reason: "replace" | "omit";
}

export interface DshContextPatch {
	protocol: typeof DSH_PATCH_VERSION;
	host: "dsh";
	sessionId: string;
	mirrorPath: string;
	baseSnapshot: string;
	generatedAt: number;
	status: EditPlan["status"];
	beforeTokens: number;
	afterTokens: number;
	changedIds: string[];
	omittedIds: string[];
	warnings: string[];
	reason?: string;
	edits: DshPatchEdit[];
}

export interface DshReconcileResult {
	status: "synced" | "noop" | "patch-written" | "rejected";
	snapshot: DshMirrorSnapshot;
	patch?: DshContextPatch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function messageForEvent(event: DshSessionEventLike): Record<string, unknown> | undefined {
	if (event.type === "user/message") return isRecord(event.data) ? event.data : undefined;
	if (!isRecord(event.data)) return undefined;
	const message = event.data.message;
	return isRecord(message) ? message : undefined;
}

function isSurfaceMessageEvent(type: string): boolean {
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
export function buildDshProjectionEntries(session: DshSessionLike): ProjectionEntryLike[] {
	const events = new Map(session.snapshotEvents().map((event) => [event.seq, event]));
	const entries: ProjectionEntryLike[] = [];
	for (const seq of session.surface.nodes) {
		const event = events.get(seq);
		if (!event || !isSurfaceMessageEvent(event.type)) continue;
		const message = messageForEvent(event);
		if (!message) continue;
		entries.push({
			sourceEntry: { id: `dsh:${String(seq)}`, type: "message" },
			messages: [message],
		});
	}
	return entries;
}

function patchFromPlan(
	plan: EditPlan,
	records: readonly MirrorRecord[],
	options: DshBridgeOptions,
): DshContextPatch {
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

function writePatch(io: DshFileSystem, patchPath: string, patch: DshContextPatch): void {
	io.writeText(patchPath, JSON.stringify(patch, null, 2) + "\n");
}

/**
 * Synchronize one DSH session mirror and, when the file changed, emit an
 * explicit auditable patch proposal. This function never mutates the DSH
 * session: applying a proposal requires a host policy or a future native DSH
 * context-edit contract.
 */
export function reconcileDshMirror(
	state: DshBridgeState,
	session: DshSessionLike,
	io: DshFileSystem,
	options: DshBridgeOptions,
): DshReconcileResult {
	const current = io.readText(options.mirrorPath);
	const previous = state.snapshot;
	let candidatePlan: EditPlan | undefined;
	let patch: DshContextPatch | undefined;

	// Validate a model edit against the snapshot that was actually rendered
	// before refreshing for new session events. This preserves an edit made in
	// the same step that appended a tool/result pair.
	if (
		previous
		&& current !== undefined
		&& current !== previous.rendered
		&& current !== state.lastProcessedMirror
	) {
		candidatePlan = planContextEdits(previous.records, parseMirror(current), {
			allowGrowth: false,
			fixedTokens: options.fixedTokens,
		});
		patch = patchFromPlan(candidatePlan, previous.records, options);
		if (candidatePlan.status !== "noop") writePatch(io, options.patchPath, patch);
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
	const snapshot: DshMirrorSnapshot = {
		filePath: options.mirrorPath,
		records,
		rendered,
		signature,
	};
	const projectionChanged = !previous || previous.signature !== signature || previous.filePath !== options.mirrorPath;

	if (current === undefined || projectionChanged) {
		io.writeText(options.mirrorPath, rendered);
		state.lastProcessedMirror = undefined;
	} else if (candidatePlan?.status === "noop") {
		// Formatting-only changes do not become a patch proposal.
		io.writeText(options.mirrorPath, rendered);
		state.lastProcessedMirror = undefined;
	}
	state.snapshot = snapshot;

	if (patch?.status === "rejected") return { status: "rejected", snapshot, patch };
	if (patch?.status === "applied") return { status: "patch-written", snapshot, patch };
	if (candidatePlan?.status === "noop") return { status: "noop", snapshot };
	return { status: projectionChanged || current === undefined ? "synced" : "noop", snapshot };
}
