import {
	cleanupMirrorForRecords,
	cleanupToolResult,
	describeCleanupList,
	planCleanup,
	type CleanupArgs,
	type CleanupResultCopy,
	type CleanupToolResult,
} from "./context-cleanup.ts";
import {
	buildMirrorRecords,
	calibrateWithHostUsage,
	DEFAULT_MAX_BLOCK_CHARS,
	DEFAULT_MAX_MIRROR_CHARS,
	estimateMessageTokens,
	estimateMirrorTokens,
	hostUsageOf,
	mirrorSignature,
	parseMirror,
	planContextEdits,
	renderBlockDigest,
	renderBlockIndex,
	renderMirror,
	type BlockClearMark,
	type BlockIndexOptions,
	type ContextEditDraft,
	type ContextEditProvenance,
	type EditPlan,
	type HostUsage,
	type MirrorRecord,
	type ProjectionEntryLike,
} from "./context-format.ts";
import {
	formatUsageLine,
	planCleanupTrigger,
	renderCleanupCandidates,
	type CleanupTriggerOptions,
} from "./context-trigger.ts";

/**
 * Closed source tags for DSH replacement nodes, derived from the planner-owned
 * `ContextEditDraft.provenance`. A model-driven edit must never be attributed to
 * a human user: these fields are written by the runtime and cannot be declared
 * from a mirror body (see RESERVED_PROVENANCE_PATTERN). DSH's
 * `MessageSourceMap` is a merge-extensible sum type — each producer declares its
 * own `kind` and consumers fall through unknown kinds (see `@deepseek-ai/dsh-llm`
 * `lib/types/message.d.ts`) — so the persisted event records which runtime
 * planner produced the edit instead of a single opaque label.
 */
const DSH_EDIT_SOURCES = {
	"model-mirror-edit": { kind: "oh-my-clm:model-mirror-edit" },
	"runtime-cleanup": { kind: "oh-my-clm:runtime-cleanup" },
} as const satisfies Record<ContextEditProvenance, { readonly kind: string }>;

function dshEditSource(provenance: ContextEditProvenance) {
	return DSH_EDIT_SOURCES[provenance];
}

export interface DshSessionEventLike {
	seq: number;
	type: string;
	data: unknown;
}

/**
 * The small runtime part of DSH's public Session append contract used here.
 * The real type is generic over the complete SessionEventMap; keeping this
 * structural avoids importing the optional DSH package into the host bundle.
 */
export interface DshSurfaceReplacementLike {
	surfaceOp: { op: "replace"; startSeq: number; endSeq: number };
	sourceEventSeqs?: readonly number[];
}

export type DshMutationEventType = "assistant/message" | "tool/result" | "developer/message";

export interface DshSessionLike {
	readonly id: string;
	readonly seq?: number;
	readonly header?: { readonly cwd?: string };
	readonly surface: { readonly nodes: readonly number[] };
	snapshotEvents(): readonly DshSessionEventLike[];
	/** DSH's public append + surfaceOp replacement seam. */
	append(
		type: DshMutationEventType,
		data: unknown,
		options: DshSurfaceReplacementLike,
	): DshSessionEventLike;
}

export interface DshFileSystem {
	readText(filePath: string): string | undefined;
	writeText(filePath: string, content: string): void;
}

export interface DshBridgeOptions {
	mirrorPath: string;
	/** Path wording shown to the model for self-reference detection. */
	mirrorDisplayPath?: string;
	maxBlockChars?: number;
	maxMirrorChars?: number;
	/** Approximate fixed request tokens used by the shrink-only gate. */
	fixedTokens?: number;
	/** Host-reported exact usage for estimate + host-cap double checking (P1-2). */
	hostUsage?: HostUsage;
	/** Window fallback when the host projection service is unavailable. */
	contextWindow?: number;
	/** Turn-boundary cleanup trigger; every threshold defaults to off. */
	trigger?: CleanupTriggerOptions;
	/** How much of the cleanup tool result is copied into model context. */
	cleanupResult?: CleanupResultCopy;
	/** Preview/head/tail budget for the model-facing block index. */
	blockIndex?: BlockIndexOptions;
	/** Re-render the index at most once per this many completed steps. */
	refreshSteps?: number;
	/** Tell the index that clearing runs automatically (header wording). */
	autoClear?: boolean;
	/**
	 * Model-facing index shape. `blocks` lists individual editable blocks;
	 * `digest` lists one line per closed turn (ID range, size) and is stable
	 * within a turn, so DSH appends it once per turn instead of once per step.
	 */
	indexMode?: "blocks" | "digest";
}

export interface DshMirrorSnapshot {
	filePath: string;
	records: MirrorRecord[];
	rendered: string;
	signature: string;
}

export interface DshBridgeState {
	snapshot?: DshMirrorSnapshot;
	/** Avoid revalidating the same rejected/validated file on every pre-step. */
	lastProcessedMirror?: string;
	/**
	 * Last block index rendered for the model, keyed by the open turn and the
	 * completed-step count. Reusing it keeps the runtime-context snapshot text
	 * stable, so DSH does not append a duplicate snapshot on every step.
	 */
	blockIndex?: DshBlockIndexCache;
	/**
	 * Turn in which a cleanup or mirror edit was last applied. The trigger's
	 * "turns since cleanup" signal and its "last cleanup at turn K" line read it.
	 */
	lastCleanupTurn?: number;
	/**
	 * Step (request) in which a cleanup or mirror edit was last applied. A turn is
	 * 11–39 steps wide, so the turn stamp alone cannot say how stale the last pass
	 * is; the step clock is the one the trigger thresholds should use.
	 */
	lastCleanupStep?: number;
	/**
	 * Usage line plus candidate text, frozen at the turn boundary. Host usage
	 * grows on every step, so recomputing per render would append a fresh
	 * runtime-context snapshot on each step and tax the prefix cache instead of
	 * saving it.
	 */
	trigger?: DshTriggerCache;
}

export interface DshTriggerCache {
	/** Completed turns when the payload was rendered; the turn-boundary key. */
	closedTurns: number;
	/** Serialized trigger options, so a live config change re-renders. */
	signature: string;
	usageLine: string;
	candidateText: string;
}

export interface DshBlockIndexCache {
	/** Turn that was open when this text was rendered; a new turn always re-renders. */
	turn?: number;
	/** Cleared records visible when this text was rendered; a new record re-renders. */
	clearedCount?: number;
	/**
	 * Completed `step/end` events when this text was rendered. DSH renders the
	 * runtime context before it appends the upcoming `step/start`, so the open
	 * step is never available here; a completed-step counter is the only
	 * monotone coordinate the bridge can actually observe at that moment.
	 */
	closedSteps: number;
	text: string;
}

export interface DshReconcileResult {
	status: "synced" | "noop" | "applied" | "rejected";
	snapshot: DshMirrorSnapshot;
	reason?: string;
	beforeTokens?: number;
	afterTokens?: number;
}

interface DshMutationResult {
	status: "applied" | "rejected";
	reason?: string;
	beforeTokens?: number;
	afterTokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * `snapshotEvents()` are the host-owned log and projection views.
 *
 * DSH projects its own dynamic runtime-context facts (sandbox/approval policy,
 * this bridge's block index, and any other contributor) as sourced user
 * messages. They are neither user-authored conversation nor cleanup targets, so
 * they are omitted here. Keeping them out also prevents the block index from
 * listing itself and growing on every step.
 */
function buildDshProjectionEntries(session: DshSessionLike): ProjectionEntryLike[] {
	const events = new Map(session.snapshotEvents().map((event) => [event.seq, event]));
	const entries: ProjectionEntryLike[] = [];
	for (const seq of session.surface.nodes) {
		const event = events.get(seq);
		if (!event || !isSurfaceMessageEvent(event.type)) continue;
		const message = messageForEvent(event);
		if (!message) continue;
		const source = message.source;
		if (isRecord(source) && source.kind === "runtime-context") continue;
		entries.push({
			sourceEntry: { id: `dsh:${String(seq)}`, type: "message" },
			messages: [message],
		});
	}
	return entries;
}

/** Build the canonical mirror records for one DSH surface. */
export function buildDshMirrorRecords(
	session: DshSessionLike,
	options: DshBridgeOptions,
): MirrorRecord[] {
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
export function renderDshBlockIndex(
	session: DshSessionLike,
	options: DshBridgeOptions,
	cleared?: ReadonlyMap<string, BlockClearMark>,
): string {
	const records = buildDshMirrorRecords(session, options);
	const indexOptions = {
		...options.blockIndex,
		...(cleared === undefined ? {} : { cleared }),
		...(options.autoClear === true ? { autoClear: true } : {}),
	};
	if (options.indexMode === "digest") {
		return renderBlockDigest(records, indexOptions);
	}
	return renderBlockIndex(records, indexOptions);
}

/**
 * Render the block index at most once per `refreshSteps` inside one turn.
 *
 * DSH assembles the runtime context at `agent/pre-step`, which runs *before*
 * the upcoming `step/start` is appended (and after the previous `step/end`).
 * A cache keyed by the open turn/step therefore never matched: it was only
 * written when a step happened to be open, which is never true at that
 * moment, so the throttle silently rendered on every step. The key here is
 * the count of completed steps plus the open turn, both observable at
 * pre-step time.
 *
 * A cached index stays correct for the blocks it lists: appending new records
 * never renumbers the earlier editable ordinals. Only removal renumbers, and
 * every applied cleanup or mirror edit clears the cache, so a stale entry can
 * omit newer blocks but cannot point a listed ID at the wrong block.
 * `refreshSteps = 1` reproduces the per-step rendering.
 */
export function dshBlockIndexText(
	session: DshSessionLike,
	options: DshBridgeOptions,
	state: DshBridgeState | undefined,
	refreshSteps = 4,
	cleared?: ReadonlyMap<string, BlockClearMark>,
): string {
	const epoch = dshBlockIndexEpoch(session);
	const cached = state?.blockIndex;
	const window = Math.max(1, Math.floor(refreshSteps));
	const clearedCount = cleared?.size ?? 0;
	if (
		cached
		&& cached.turn === epoch.turn
		&& (cached.clearedCount ?? 0) === clearedCount
		&& epoch.closedSteps >= cached.closedSteps
		&& epoch.closedSteps - cached.closedSteps < window
	) {
		return cached.text;
	}
	const text = renderDshBlockIndex(session, options, cleared);
	if (state) state.blockIndex = { turn: epoch.turn, closedSteps: epoch.closedSteps, clearedCount, text };
	return text;
}

/**
 * Fold the coordinates the index cache can observe at pre-step time: the open
 * turn (set by `turn/start`, cleared by `turn/end`) and the number of steps
 * that have already completed. The upcoming step is deliberately not part of
 * the key because it does not exist yet when the runtime context is rendered.
 */
function dshBlockIndexEpoch(
	session: Pick<DshSessionLike, "snapshotEvents"> | undefined,
): { turn?: number; closedSteps: number; closedTurns: number } {
	if (!session || typeof session.snapshotEvents !== "function") return { closedSteps: 0, closedTurns: 0 };
	let turn: number | undefined;
	let closedSteps = 0;
	let closedTurns = 0;
	for (const event of session.snapshotEvents()) {
		if (!isRecord(event) || typeof event.type !== "string") continue;
		const data = isRecord(event.data) ? event.data : undefined;
		if (event.type === "turn/start") {
			turn = positiveSafeInteger(data?.turn) ? data.turn : turn;
		} else if (event.type === "turn/end") {
			turn = undefined;
			closedTurns += 1;
		} else if (event.type === "step/end") {
			closedSteps += 1;
		}
	}
	return { turn, closedSteps, closedTurns };
}

/**
 * Turn number a cleanup applied right now is reported under. Between turns the
 * upcoming turn is `closedTurns + 1`, which keeps "turns since cleanup"
 * monotone instead of resetting on `turn/end`.
 */
function currentTurnNumber(session: Pick<DshSessionLike, "snapshotEvents"> | undefined): number {
	const epoch = dshBlockIndexEpoch(session);
	return epoch.turn ?? epoch.closedTurns + 1;
}

/**
 * Step (request) a cleanup applied right now is reported under. Same monotonicity
 * argument as {@link currentTurnNumber}: between steps the upcoming step is
 * `closedSteps + 1`, so "steps since cleanup" never resets.
 */
function currentStepNumber(session: Pick<DshSessionLike, "snapshotEvents"> | undefined): number {
	const epoch = dshBlockIndexEpoch(session);
	return epoch.closedSteps + 1;
}

/**
 * Estimated model-visible tokens that sit *after* one surface node.
 *
 * This is the one-time cost of clearing that node outside a turn boundary: the
 * prefix stays cached up to it, and everything behind it is re-read at full
 * price on the next request. Zero means the node is the tail, so clearing it
 * breaks nothing — the only mid-turn clear that needs no assumption about how
 * long the turn will run.
 *
 * The estimate follows the projection: runtime-context snapshots are skipped, so
 * a snapshot's own tokens are not counted as a tail the model cannot read.
 */
export function dshSurfaceTokensAfter(session: DshSessionLike, seq: number): number {
	return dshSurfaceTokensAfterEach(session, [seq]).get(seq) ?? 0;
}

/**
 * {@link dshSurfaceTokensAfter} for several targets in one pass.
 *
 * A mid-turn check prices every candidate in the pool, so the surface is walked
 * once and the per-node costs are turned into suffix sums; querying each target
 * separately would re-estimate the whole tail for each one.
 */
export function dshSurfaceTokensAfterEach(
	session: DshSessionLike,
	seqs: readonly number[],
): Map<number, number> {
	const tails = new Map<number, number>();
	const nodes = session.surface?.nodes;
	if (!Array.isArray(nodes)) {
		for (const seq of seqs) tails.set(seq, 0);
		return tails;
	}
	const events = new Map(session.snapshotEvents().map((event) => [event.seq, event]));
	const ordered: { node: number; tokens: number }[] = [];
	for (const node of nodes) {
		const event = events.get(node);
		if (!event || !isSurfaceMessageEvent(event.type)) continue;
		const message = messageForEvent(event);
		if (!message) continue;
		const source = message.source;
		if (isRecord(source) && source.kind === "runtime-context") continue;
		ordered.push({ node, tokens: estimateMessageTokens(message) });
	}
	// Suffix sums from the end: `after[i]` is everything strictly after entry i.
	const after = new Array<number>(ordered.length + 1).fill(0);
	for (let index = ordered.length - 1; index >= 0; index -= 1) {
		after[index] = (after[index + 1] ?? 0) + (ordered[index]?.tokens ?? 0);
	}
	for (const seq of seqs) {
		// First entry whose node is greater than the target; nodes ascend in surface order.
		let low = 0;
		let high = ordered.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if ((ordered[mid]?.node ?? 0) <= seq) low = mid + 1;
			else high = mid;
		}
		tails.set(seq, after[low] ?? 0);
	}
	return tails;
}

/** One candidate as the cost side of the ledger sees it. */
export interface PricedBlock {
	/** Session seq of the `tool/result` surface node. */
	readonly seq: number;
	/** Model-visible tokens the clear removes from that node. */
	readonly tokens: number;
}

/**
 * One-time cost of a batch: the model-visible tokens behind its earliest
 * cleared block, minus the bodies the same batch also removes from that tail.
 *
 * A clear breaks the prefix cache at the cleared block, so everything after it
 * is re-prefilled at full price on the next request while the prefix before it
 * stays cached. Clearing several blocks in one pass pays that break once, which
 * is why the batch is priced from its earliest target rather than per block.
 *
 * Pure form of {@link dshBatchSuffixTokens} for a caller that already priced the
 * tails. `undefined` means the cost is unknown, never that it is free.
 */
export function batchSuffixTokens(
	candidates: readonly PricedBlock[],
	tails: ReadonlyMap<number, number>,
): number | undefined {
	if (candidates.length === 0) return undefined;
	const earliest = Math.min(...candidates.map((candidate) => candidate.seq));
	const behind = tails.get(earliest);
	if (behind === undefined) return undefined;
	const removedBehind = candidates
		.filter((candidate) => candidate.seq > earliest)
		.reduce((total, candidate) => total + Math.max(0, candidate.tokens), 0);
	return Math.max(0, behind - removedBehind);
}

/**
 * {@link batchSuffixTokens} for a batch whose tails have not been priced yet.
 * Returns `undefined` when no candidate has a targetable node.
 */
export function dshBatchSuffixTokens(
	session: DshSessionLike,
	candidates: readonly PricedBlock[],
): number | undefined {
	const usable = candidates.filter((candidate) => Number.isSafeInteger(candidate.seq) && candidate.seq >= 0);
	if (usable.length === 0) return undefined;
	return batchSuffixTokens(usable, dshSurfaceTokensAfterEach(session, usable.map((candidate) => candidate.seq)));
}

/** Render the trigger options deterministically for the per-turn cache key. */
function triggerSignature(options: DshBridgeOptions): string {
	const trigger = options.trigger ?? {};
	return JSON.stringify([
		trigger.usagePercent ?? 0,
		trigger.completedTurns ?? 0,
		trigger.completedSteps ?? 0,
		trigger.toolResultShare ?? 0,
		trigger.turnsSinceCleanup ?? 0,
		trigger.stepsSinceCleanup ?? 0,
		trigger.maxCandidates ?? 0,
		trigger.minSavingsTokens ?? 0,
		trigger.cacheDiscount ?? 0,
		trigger.paybackTurns ?? 0,
		trigger.paybackSteps ?? 0,
	]);
}

export interface DshTriggerView {
	usageLine: string;
	candidateText: string;
}

/**
 * Build the usage line and cleanup candidates for one turn boundary.
 *
 * The payload is cached per (completed turns, trigger config): within a turn it
 * is byte-identical even as the host reports more usage, so DSH's runtime
 * context dedupe still appends one snapshot per turn rather than one per step.
 * The step clocks are therefore sampled at the boundary — that is a sampling
 * cadence, not a unit: a step threshold still compares real steps, while a turn
 * threshold compares a number that is 11–39 steps wide (measured). Any applied
 * edit clears the cache because removal renumbers the IDs; a compaction is
 * cleared by the host adapter.
 */
export function dshTriggerView(
	session: DshSessionLike,
	options: DshBridgeOptions,
	state: DshBridgeState | undefined,
	cleared?: ReadonlyMap<string, BlockClearMark>,
): DshTriggerView {
	const epoch = dshBlockIndexEpoch(session);
	const signature = triggerSignature(options);
	const cached = state?.trigger;
	if (cached && cached.closedTurns === epoch.closedTurns && cached.signature === signature) {
		return { usageLine: cached.usageLine, candidateText: cached.candidateText };
	}
	const records = buildDshMirrorRecords(session, options);
	const hostUsage = hostUsageOf(options.hostUsage);
	const fallbackWindow = typeof options.contextWindow === "number"
		&& Number.isFinite(options.contextWindow)
		&& options.contextWindow > 0
		? Math.ceil(options.contextWindow)
		: undefined;
	const clearedTokens = cleared === undefined
		? 0
		: [...cleared.values()].reduce((sum, mark) => sum + Math.max(0, mark.tokens), 0);
	const usageTokens = hostUsage?.tokens ?? Math.max(0, fixedTokens(options) + estimateMirrorTokens(records) - clearedTokens);
	const contextWindow = hostUsage?.contextWindow ?? fallbackWindow;
	const usageLine = formatUsageLine({
		tokens: usageTokens,
		...(contextWindow !== undefined ? { contextWindow } : {}),
		exact: hostUsage !== undefined,
		editableBlocks: records.filter((record) => !record.protected).length,
		...(state?.lastCleanupTurn !== undefined ? { lastCleanupTurn: state.lastCleanupTurn } : {}),
		...(state?.lastCleanupStep !== undefined ? { lastCleanupStep: state.lastCleanupStep } : {}),
	});
	const plan = planCleanupTrigger(records, {
		usageTokens,
		...(contextWindow !== undefined ? { contextWindow } : {}),
		exactUsage: hostUsage !== undefined,
		completedTurns: epoch.closedTurns,
		completedSteps: epoch.closedSteps,
		...(state?.lastCleanupTurn !== undefined ? { lastCleanupTurn: state.lastCleanupTurn } : {}),
		...(state?.lastCleanupStep !== undefined ? { lastCleanupStep: state.lastCleanupStep } : {}),
		currentTurn: epoch.turn ?? epoch.closedTurns + 1,
		currentStep: epoch.closedSteps + 1,
	}, options.trigger ?? {});
	const candidateText = renderCleanupCandidates(plan);
	if (state) state.trigger = { closedTurns: epoch.closedTurns, signature, usageLine, candidateText };
	return { usageLine, candidateText };
}

function sequenceFromRecordId(id: string): number | undefined {
	if (!id.startsWith("dsh:")) return undefined;
	const value = Number(id.slice(4));
	return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nextSessionSequence(session: DshSessionLike): number {
	if (typeof session.seq === "number" && Number.isSafeInteger(session.seq) && session.seq >= 0) {
		return session.seq;
	}
	const events = session.snapshotEvents();
	return events.reduce((next, event) => Math.max(next, event.seq + 1), 0);
}

function mutationMessageId(session: DshSessionLike, targetSeq: number, role: string): string {
	return `oh-my-clm:${session.id}:context-edit:${nextSessionSequence(session)}:${role}:${targetSeq}`;
}

function replacementContent(edit: ContextEditDraft): unknown[] | undefined {
	const content = edit.replacement?.content;
	return Array.isArray(content) ? content : undefined;
}

function fixedTokens(options: DshBridgeOptions): number {
	return typeof options.fixedTokens === "number"
		&& Number.isFinite(options.fixedTokens)
		&& options.fixedTokens >= 0
		? Math.ceil(options.fixedTokens)
		: 0;
}

function actionMessage(record: MirrorRecord, action: ContextEditDraft): Record<string, unknown> | undefined {
	if (action.replacement === null) return undefined;
	const content = replacementContent(action);
	if (!content) return undefined;
	const source = record.sourceMessage;
	if (!isRecord(source)) return undefined;
	return { ...source, content };
}

function estimateAfterMutation(
	records: readonly MirrorRecord[],
	actions: ReadonlyMap<string, ContextEditDraft>,
): number {
	return records.reduce((total, record) => {
		const action = actions.get(record.id);
		if (action?.replacement === null) return total;
		if (!action) return total + estimateMirrorTokens([record]);
		const message = actionMessage(record, action);
		return total + (message ? estimateMessageTokens(message) : estimateMirrorTokens([record]));
	}, 0);
}

function rejectMutation(reason: string, beforeTokens?: number, afterTokens?: number): DshMutationResult {
	return { status: "rejected", reason, beforeTokens, afterTokens };
}

function positiveSafeInteger(value: unknown): value is number {
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
function openTurnStepFromEvents(
	events: readonly DshSessionEventLike[],
): { turn: number; step: number } | undefined {
	let turn: number | undefined;
	let step: number | undefined;
	for (const event of events) {
		if (!isRecord(event) || typeof event.type !== "string") continue;
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
export function dshOpenTurnStep(
	session: Pick<DshSessionLike, "snapshotEvents"> | undefined,
): { turn: number; step: number } | undefined {
	if (!session || typeof session.snapshotEvents !== "function") return undefined;
	return openTurnStepFromEvents(session.snapshotEvents());
}

/**
 * Append an empty developer node that replaces one current surface node.
 * DSH deliberately keeps the replacement node in the append-only surface, but
 * empty developer messages derive to no LLM message, which gives omission the
 * same active-history effect as Pi's `context_edit: replacement=null`.
 */
function appendOmission(
	session: DshSessionLike,
	targetSeq: number,
	coordinates: { turn: number; step: number },
	provenance: ContextEditProvenance,
): void {
	session.append("developer/message", {
		turn: coordinates.turn,
		step: coordinates.step,
		message: {
			id: mutationMessageId(session, targetSeq, "omit"),
			role: "developer",
			content: [],
			source: dshEditSource(provenance),
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
function appendContentReplacement(
	session: DshSessionLike,
	record: MirrorRecord,
	event: DshSessionEventLike,
	action: ContextEditDraft,
	targetSeq: number,
	coordinates: { turn: number; step: number },
): void {
	const content = replacementContent(action);
	if (!content) throw new Error(`edit ${record.id} has no structured replacement content`);
	const data = isRecord(event.data) ? event.data : undefined;
	const message = messageForEvent(event);
	if (!data || !message) throw new Error(`current DSH event ${targetSeq} has no message payload`);

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
				source: dshEditSource(action.provenance),
			},
		}, {
			surfaceOp: { op: "replace", startSeq: targetSeq, endSeq: targetSeq },
			sourceEventSeqs: [targetSeq],
		});
		return;
	}

	if (record.role === "toolResult") {
		if (event.type !== "tool/result") throw new Error(`tool result record ${record.id} is not a tool/result event`);
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
function applyDshContextEdits(
	session: DshSessionLike,
	plan: EditPlan,
	records: readonly MirrorRecord[],
	options: DshBridgeOptions,
): DshMutationResult {
	if (plan.status !== "applied") return rejectMutation("Only an applied edit plan can mutate a DSH session.");
	if (typeof session.append !== "function") {
		return rejectMutation("The active DSH session does not expose Session.append; refusing a mirror-only fallback.");
	}

	const snapshotEvents = session.snapshotEvents();
	const events = new Map(snapshotEvents.map((event) => [event.seq, event]));
	const currentSurface = new Set(session.surface.nodes);
	const coordinates = openTurnStepFromEvents(snapshotEvents);
	if (!coordinates) {
		return rejectMutation(
			"The DSH session has no open step; developer/message replacements require an open turn/step and must be retried after step/start.",
		);
	}
	const recordsById = new Map(records.map((record) => [record.id, record]));
	const actions = new Map<string, ContextEditDraft>();

	for (const edit of plan.edits) {
		const record = recordsById.get(edit.targetId);
		if (!record) return rejectMutation(`The DSH surface changed before edit ${edit.targetId} could be applied.`);
		if (record.protected) return rejectMutation(`Protected DSH record ${edit.targetId} cannot be mutated.`);
		if (edit.replacement !== null && !replacementContent(edit)) {
			return rejectMutation(`DSH edit ${edit.targetId} does not contain structured message content.`);
		}
		actions.set(edit.targetId, edit);
	}

	const byToolCallId = new Map<string, MirrorRecord>();
	const byResultCallId = new Map<string, MirrorRecord>();
	for (const record of records) {
		for (const callId of record.toolCallIds) byToolCallId.set(callId, record);
		if (record.role === "toolResult" && record.toolCallId) byResultCallId.set(record.toolCallId, record);
	}

	const omit = (record: MirrorRecord, reason: string, provenance: ContextEditProvenance): DshMutationResult | undefined => {
		if (record.protected) return rejectMutation(`Protected DSH record ${record.id} cannot be omitted: ${reason}`);
		const existing = actions.get(record.id);
		if (existing?.replacement === null) return undefined;
		// A paired omission inherits the triggering planner's provenance, so a
		// cleanup cascade is not mislabelled as a model mirror edit.
		actions.set(record.id, { targetId: record.id, replacement: null, reason: "omit", provenance });
		return undefined;
	};

	// Match the shared Pi policy: no edited assistant tool call may leave a
	// current result behind, and no omitted result may leave its owner behind.
	for (const record of records) {
		const action = actions.get(record.id);
		if (record.role !== "assistant" || !action) continue;
		for (const callId of record.toolCallIds) {
			const result = byResultCallId.get(callId);
			if (!result) {
				return rejectMutation(
					`Cannot mutate assistant ${record.id} while tool call ${callId} has no current result; retry after the tool step settles.`,
				);
			}
			const failure = omit(result, `assistant tool call ${callId} was rewritten`, action.provenance);
			if (failure) return failure;
		}
	}
	for (const record of records) {
		const action = actions.get(record.id);
		if (record.role !== "toolResult" || !action || action.replacement !== null || !record.toolCallId) continue;
		const owner = byToolCallId.get(record.toolCallId);
		if (!owner || actions.has(owner.id)) continue;
		const failure = omit(owner, `tool result ${record.id} was omitted`, action.provenance);
		if (failure) return failure;
	}
	for (const record of records) {
		const action = actions.get(record.id);
		if (record.role !== "assistant" || !action || action.replacement !== null) continue;
		for (const callId of record.toolCallIds) {
			const result = byResultCallId.get(callId);
			if (result) {
				const failure = omit(result, `assistant ${record.id} was omitted`, action.provenance);
				if (failure) return failure;
			}
		}
	}

	const estimatedBefore = fixedTokens(options) + estimateMirrorTokens(records);
	const estimatedAfter = fixedTokens(options) + estimateAfterMutation(records, actions);
	let before = estimatedBefore;
	let after = estimatedAfter;
	const hostUsage = hostUsageOf(options.hostUsage);
	if (hostUsage) {
		const calibrated = calibrateWithHostUsage(estimatedBefore, estimatedAfter, hostUsage);
		before = calibrated.beforeTokens;
		after = calibrated.afterTokens;
		if (calibrated.reason) return rejectMutation(calibrated.reason, before, after);
	}
	if (after >= before) {
		return rejectMutation(
			"A DSH surface mutation must SHRINK context; replace stale text with a shorter summary instead.",
			before,
			after,
		);
	}

	// Resolve every target before the first append. Cleanup is intentionally a
	// preflighted batch so a stale surface cannot cause a partial omission.
	const targets = new Map<string, { targetSeq: number; event: DshSessionEventLike }>();
	for (const record of records) {
		const action = actions.get(record.id);
		if (!action) continue;
		const targetSeq = sequenceFromRecordId(record.id);
		if (targetSeq === undefined || !currentSurface.has(targetSeq)) {
			return rejectMutation(`DSH surface no longer contains edit target ${record.id}.`);
		}
		const event = events.get(targetSeq);
		if (!event) return rejectMutation(`DSH event ${targetSeq} for ${record.id} is unavailable.`);
		targets.set(record.id, { targetSeq, event });
	}

	for (const record of records) {
		const action = actions.get(record.id);
		const target = targets.get(record.id);
		if (!action || !target) continue;
		if (action.replacement === null) {
			appendOmission(session, target.targetSeq, coordinates, action.provenance);
		} else {
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
export function executeDshCleanup(
	session: DshSessionLike,
	targets: CleanupArgs | readonly number[],
	options: DshBridgeOptions,
	io?: DshFileSystem,
	state?: DshBridgeState,
): CleanupToolResult {
	const copy: CleanupResultCopy = options.cleanupResult ?? "compact";
	const records = buildDshMirrorRecords(session, options);
	// The index is re-rendered in every step's runtime context, so a tool result
	// carries it only on explicit opt-in.
	const copiedIndex = (): string | undefined =>
		copy === "full" ? renderDshBlockIndex(session, options) : undefined;
	const listTarget = Array.isArray(targets) ? undefined : (targets as CleanupArgs).list;
	if (listTarget) {
		// Read-only drill-down: the rows of a range the index only named. It does
		// not touch the surface, the mirror, or the cached index text.
		return describeCleanupList(records, listTarget, {
			maxPreviewChars: options.blockIndex?.maxPreviewChars,
		});
	}
	const plan = planCleanup(records, cleanupMirrorForRecords(records), targets, {
		fixedTokens: options.fixedTokens,
		hostUsage: options.hostUsage,
	});
	if (plan.status !== "applied") {
		return cleanupToolResult(plan, copiedIndex(), copy);
	}

	try {
		const mutation = applyDshContextEdits(session, plan, records, options);
		if (mutation.status !== "applied") {
			return cleanupToolResult({
				status: "rejected",
				requestedBlockIds: [...plan.requestedBlockIds],
				removedBlockIds: [],
				pairedRemovalIds: [],
				reason: mutation.reason ?? "The DSH session rejected the cleanup mutation.",
			}, copiedIndex(), copy);
		}
		// Removal renumbers the editable IDs, so the next render must not reuse
		// the cached index even when this call did not write the mirror. The
		// trigger payload carries both IDs and "last cleanup at turn K".
		if (state) {
			state.blockIndex = undefined;
			state.trigger = undefined;
			state.lastCleanupTurn = currentTurnNumber(session);
			state.lastCleanupStep = currentStepNumber(session);
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
		return cleanupToolResult(plan, copiedIndex(), copy);
	} catch (error) {
		return cleanupToolResult({
			status: "rejected",
			requestedBlockIds: [...plan.requestedBlockIds],
			removedBlockIds: [],
			pairedRemovalIds: [],
			reason: `DSH cleanup mutation failed: ${error instanceof Error ? error.message : String(error)}`,
		}, copiedIndex(), copy);
	}
}

/**
 * Synchronize one DSH session mirror and apply legal edits through the
 * host-owned Session append/surface replacement seam. The canonical mirror is
 * always rewritten after processing so the file remains a projection rather
 * than an independent source of truth.
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

	// Validate a model edit against the snapshot that was actually rendered
	// before refreshing for new session events. The mutation preflight below
	// rechecks targets and tool pairing against the current surface.
	if (
		previous
		&& current !== undefined
		&& current !== previous.rendered
		&& current !== state.lastProcessedMirror
	) {
		candidatePlan = planContextEdits(previous.records, parseMirror(current), {
			allowGrowth: false,
			fixedTokens: options.fixedTokens,
			hostUsage: options.hostUsage,
		});
		state.lastProcessedMirror = current;
	}

	let records = buildDshMirrorRecords(session, options);

	let mutation: DshMutationResult | undefined;
	if (candidatePlan?.status === "applied") {
		try {
			mutation = applyDshContextEdits(session, candidatePlan, records, options);
		} catch (error) {
			mutation = rejectMutation(`DSH session mutation failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		// Session.append() synchronously changes the host projection. Rebuild
		// from the session log instead of deriving a mirror from the plan.
		records = buildDshMirrorRecords(session, options);
		if (mutation?.status === "applied") {
			state.blockIndex = undefined;
			state.trigger = undefined;
			state.lastCleanupTurn = currentTurnNumber(session);
			state.lastCleanupStep = currentStepNumber(session);
		}
	}

	const rendered = renderMirror(records);
	const signature = mirrorSignature(records);
	const snapshot: DshMirrorSnapshot = {
		filePath: options.mirrorPath,
		records,
		rendered,
		signature,
	};
	const projectionChanged = !previous || previous.signature !== signature || previous.filePath !== options.mirrorPath;

	// A model edit (applied, rejected or noop) and any projection change converge
	// the external artifact back to the host-owned projection.
	if (current === undefined || projectionChanged || candidatePlan !== undefined) {
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
	if (candidatePlan?.status === "noop") return { status: "noop", snapshot };
	return { status: projectionChanged || current === undefined ? "synced" : "noop", snapshot };
}
