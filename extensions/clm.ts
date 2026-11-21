import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type {
	ContextEditEntryDraft,
	ContextEditableContent,
	ContextEvent,
	ContextEventResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBoundaryDraft,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
	buildMirrorRecords,
	estimateMessageTokens,
	estimateMirrorTokens,
	hostUsageOf,
	messageText,
	mirrorSignature,
	parseMirror,
	planContextEdits,
	renderBlockIndex,
	renderMirror,
	rewriteMirrorBlocks,
	type EditPlanOptions,
	type HostUsage,
	type MirrorRecord,
	type ProjectionEntryLike,
} from "../src/features/live-context/context-format.ts";
import {
	cleanupToolResult,
	describeCleanupList,
	formatCleanupToolResult,
	parseCleanupArgs,
	parseCleanupMirror,
	parseCleanupResultCopy,
	planCleanup,
	type CleanupPlan,
	type CleanupResultCopy,
	type CleanupToolResult,
} from "../src/features/live-context/context-cleanup.ts";
import {
	assembleCleanupCandidates,
	formatPercent,
	formatUsageLine,
	planCleanupTrigger,
	renderCleanupCandidates,
	type CleanupTriggerPlan,
} from "../src/features/live-context/context-trigger.ts";
import {
	REFETCH_TOOL_NAMES,
	SupersessionTracker,
	batchNetTokens,
	batchPassesGate,
	candidateRefused,
	createRereadPolicy,
	noteKeyReread,
	parseToolArguments,
	targetKeyOf,
	type BatchGate,
	type CanaryBatch,
	type CanaryRecord,
	type ClearCandidate,
	type RereadPolicy,
} from "../src/features/live-context/auto-clear.ts";
import { clearPlaceholder } from "../src/features/live-context/clear-projection.ts";
import { loadClmConfig, projectConfigPath, userConfigPath, type ClmAutoClearConfig } from "../src/lib/clm-config.ts";
import { appendPrivateLine, writePrivateText } from "../src/lib/clm-files.ts";
import { sessionCanaryPath, sessionMirrorPath } from "../src/lib/clm-paths.ts";
const PROMPT_MARKER = "<pi-clm-live-context>";
const CONTEXT_NUDGE_MARKER = "<pi-clm-budget-nudge>";
const CONTEXT_RESERVE_TOKENS = 2_048;
const CONTEXT_NUDGE_FRACTION = 0.75;
/**
 * Stop condition for the synthetic, non-history budget nudge (plan I-2).
 * Two consecutive rounds without a real shrink stop the loop; real progress
 * resets the counter, so a long session can be nudged again in a later episode.
 */
const MAX_NUDGE_ROUNDS = 2;

interface Config {
	budgetTokens: number;
	/** Window fallback when the host usage carries no window; 0 = unknown. */
	windowTokens: number;
	maxBlockChars: number;
	maxMirrorChars: number;
	/** How much of the cleanup result the model reads. */
	resultMode: CleanupResultCopy;
	/** `r` in `r·L + (1−r)·B`, as a fraction: the cached-read price ratio. */
	cacheDiscount: number;
	/** Future requests (steps) the one-time prefix-break cost is amortised over. */
	paybackTurns: number;
	/** Explicit request horizon overriding `paybackTurns`; 0 = not set. */
	paybackSteps: number;
	/** Steps since the last applied cleanup that trigger a nudge. 0 disables. */
	triggerSince: number;
	/** toolResult share (0..1) of editable tokens that triggers a nudge. 0 disables. */
	triggerToolShare: number;
	/** Usage percentage that fires the nudge; 0 keeps the built-in default. */
	triggerUsagePercent: number;
	/** Maximum candidate ranges offered in one nudge payload. */
	triggerMaxCandidates: number;
	/** Candidates below this estimated token size are never offered. */
	triggerMinSavingsTokens: number;
	/** The whole `autoClear` block; the Pi settlement reads every key but one. */
	autoClear: ClmAutoClearConfig;
}

interface MirrorSnapshot {
	filePath: string;
	records: MirrorRecord[];
	rendered: string;
	signature: string;
}

/**
 * Read the session's effective config.
 *
 * The project file is keyed by the session's working directory, so two repos
 * can carry different budgets without restarting Pi. The user file underneath
 * holds endpoint calibration shared by every project.
 */
function config(ctx: ExtensionContext): Config {
	const loaded = loadClmConfig(ctx.cwd);
	return {
		budgetTokens: loaded.config.context.budgetTokens,
		windowTokens: loaded.config.context.windowTokens,
		maxBlockChars: loaded.config.context.maxBlockChars,
		maxMirrorChars: loaded.config.context.maxMirrorChars,
		resultMode: parseCleanupResultCopy(loaded.config.cleanup.resultMode),
		// A percentage in the file, a fraction in the cleanup math. Measured on
		// deepseek-flash through Pi's own cost table (2026-11-09): input $0.30/M
		// vs cacheRead $0.006/M. Lower is the fail-safe direction.
		cacheDiscount: loaded.config.cleanup.cacheDiscountPercent / 100,
		paybackTurns: loaded.config.cleanup.paybackTurns,
		paybackSteps: loaded.config.cleanup.paybackSteps,
		// Host-independent triggers. Both default off. Pi counts requests (one per
		// step), so the step clock is the one it can actually observe; the turn
		// clock stays available for configs shared with a turn-aware host.
		triggerSince: loaded.config.cleanup.trigger.stepsSinceCleanup
			|| loaded.config.cleanup.trigger.turnsSinceCleanup,
		triggerToolShare: loaded.config.cleanup.trigger.toolResultSharePercent / 100,
		triggerUsagePercent: loaded.config.cleanup.trigger.usagePercent,
		triggerMaxCandidates: loaded.config.cleanup.trigger.maxCandidates,
		triggerMinSavingsTokens: loaded.config.cleanup.trigger.minSavingsTokens,
		autoClear: loaded.config.autoClear,
	};
}

/**
 * Keys the shared loader parses but this adapter never reads. The loader treats
 * them as valid, so its own warning channel stays quiet. `autoClear.*` is read
 * here since the Pi settlement landed; only the mid-turn tail budget stays on
 * the list, because a Pi step has no settlement point inside it.
 */
const PI_IGNORED_CONFIG_KEYS: readonly string[] = [
	"index.mode",
	"index.previewChars",
	"index.headBlocks",
	"index.tailBlocks",
	"index.maxLines",
	"index.refreshSteps",
	"context.fixedTokens",
	"cleanup.trigger.completedTurns",
	"cleanup.trigger.completedSteps",
	"autoClear.midTurnSuffixTokens",
	"host.pluginRecordModule",
];

function readConfigDocument(filePath: string): Record<string, unknown> | undefined {
	const text = readText(filePath);
	if (text === undefined) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		// Invalid JSON is the loader's warning to give; this walk only reports
		// keys that are both present and parsed.
		return undefined;
	}
}

function hasKeyPath(document: Record<string, unknown> | undefined, parts: readonly string[]): boolean {
	let node: unknown = document;
	for (const part of parts) {
		if (!isRecord(node) || !(part in node)) return false;
		node = node[part];
	}
	return true;
}

/**
 * Ignored keys actually set in a config file, in list order. The project file
 * wins for values, so it is consulted first; either file counts as "set".
 */
function ignoredConfigKeys(cwd: string): string[] {
	const files = [projectConfigPath(cwd), userConfigPath()];
	return PI_IGNORED_CONFIG_KEYS.filter((key) => {
		const parts = key.split(".");
		return files.some((file) => hasKeyPath(readConfigDocument(file), parts));
	});
}

function mirrorPath(ctx: ExtensionContext): string {
	return sessionMirrorPath(ctx.sessionManager.getSessionId());
}

function readText(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}


function getProjection(ctx: ExtensionContext): { entries: ProjectionEntryLike[] } {
	const projection = ctx.sessionManager.buildSessionProjection();
	return { entries: projection.entries as unknown as ProjectionEntryLike[] };
}

function fixedRequestTokens(ctx: ExtensionContext): number {
	if (typeof ctx.getSystemPrompt !== "function") return 0;
	const systemPrompt = ctx.getSystemPrompt();
	return systemPrompt ? estimateMessageTokens({ role: "system", content: systemPrompt }) : 0;
}

/**
 * Exact usage from the Pi host for the estimate + host-cap double check (P1-2).
 * `getContextUsage().tokens` is the whole current request, not an estimate of
 * the editable mirror; the window falls back to the configured
 * `context.windowTokens` and then the model's window when the host omits it.
 */
function hostUsageOfContext(ctx: ExtensionContext): HostUsage | undefined {
	const usage = ctx.getContextUsage?.();
	if (!usage) return undefined;
	const configuredWindow = config(ctx).windowTokens;
	const contextWindow = usage.contextWindow
		?? (configuredWindow > 0 ? configuredWindow : undefined)
		?? ctx.model?.contextWindow;
	return hostUsageOf({ tokens: usage.tokens, contextWindow });
}

function editPlanOptions(ctx: ExtensionContext): EditPlanOptions {
	return {
		allowGrowth: false,
		fixedTokens: fixedRequestTokens(ctx),
		hostUsage: hostUsageOfContext(ctx),
	};
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

function projectionSignature(records: readonly MirrorRecord[]): string {
	return mirrorSignature(records);
}

function syncMirror(ctx: ExtensionContext, force = false): MirrorSnapshot {
	const state = sessionState(ctx);
	const filePath = mirrorPath(ctx);
	const projection = getProjection(ctx);
	const settings = config(ctx);
	const records = buildMirrorRecords(projection.entries, {
		mirrorPath: filePath,
		maxBlockChars: settings.maxBlockChars,
		maxMirrorChars: settings.maxMirrorChars,
	});
	const rendered = renderMirror(records);
	const signature = projectionSignature(records);
	const current = readText(filePath);
	const previous = state.snapshot;

	if (force || !previous || previous.filePath !== filePath || current === undefined || previous.signature !== signature) {
		writePrivateText(filePath, rendered);
	} else if (current !== rendered) {
		// A direct edit outside a model turn has no safe append-only boundary. Do
		// not silently apply it or leave the model looking at stale, untracked data.
		// Restore the canonical projection; model-issued edits are reconciled in
		// turn_end, where Pi accepts context_edit entries. The reason still reaches
		// the model on the next request, because a reverted edit that nobody
		// mentions looks like the write succeeded.
		state.pendingNotice ??= discardedEditNotice(ctx, previous, current);
		writePrivateText(filePath, rendered);
	}

	const snapshot = { filePath, records, rendered, signature };
	state.snapshot = snapshot;
	return snapshot;
}

/**
 * One notice sentence for a rejected edit. Plan reasons arrive with mixed
 * punctuation (some end in a period, most do not), so normalize here rather
 * than at each call site: drop one trailing period, then add exactly one.
 */
function rejectedEditNotice(reason: string | undefined): string {
	const detail = (reason ?? "invalid edit").replace(/\.\s*$/, "");
	return `Your last mirror edit was rejected: ${detail}. The mirror was restored to the canonical projection; fix that block in the mirror during a turn, or use cleanup.`;
}

/** Why an edit that was already on disk will not reach the session tree. */
function discardedEditNotice(ctx: ExtensionContext, previous: MirrorSnapshot, current: string): string {
	const plan = planContextEdits(previous.records, parseMirror(current), editPlanOptions(ctx));
	if (plan.status === "rejected") {
		return rejectedEditNotice(plan.reason);
	}
	return "A mirror edit arrived outside a turn boundary, so it was not applied and the mirror was restored. Make the edit during a turn (the edit is committed at that turn's end).";
}

/**
 * Pi's live-context contract.
 *
 * Pi's interface is the mirror file itself, so the path and block markers are
 * model-actionable and stay. Everything else follows the DSH standard: this
 * text rides in every request, so it carries no API restatement
 * (`cleanupParameters` owns that), no protocol internals, no config switches, and
 * no instruction repeated elsewhere. The budget nudge adds the only
 * turn-scoped line at runtime.
 *
 * `test/adapters/extension.test.ts` caps the length so a helpful-sounding
 * addition cannot silently tax every request.
 */
function promptAppendix(ctx: ExtensionContext): string {
	const filePath = mirrorPath(ctx);
	return `${PROMPT_MARKER}
Your Pi context is mirrored to \`${filePath}\`. To free context, shorten stale \`[[CLM_ENTRY id=N role=...]]\` bodies with one edit/write: keep the protocol header, the \`CLM_SNAPSHOT\` line, the markers and their order, and block 1 intact; keep a body line's leading backslash when it looks like a marker or comment; rewrite only from a block's complete current body. The initial task is protected and not shown; user blocks may be omitted, never rewritten. To delete blocks use the \`cleanup\` tool (batch every target into one call); \`cleanup({ list: "A-B" })\` inspects a range first. Rewriting a tool-call block also omits its tool result: put the fact in that block's body. Do not rewrite a block from the step you are still producing. At a subtask boundary, use one \`cleanup\` to drop settled tool noise, then continue.
When a ${CONTEXT_NUDGE_MARKER} appears, confirm its cleanup candidate or make one edit, then continue the task.
${PROMPT_MARKER}`;
}

function statusText(ctx: ExtensionContext, snapshot: MirrorSnapshot | undefined): string {
	const current = snapshot ?? syncMirror(ctx);
	const settings = config(ctx);
	const usage = ctx.getContextUsage();
	const estimatedRequest = fixedRequestTokens(ctx) + estimateMirrorTokens(current.records);
	const currentTokens = usage?.tokens ?? estimatedRequest;
	const editableRecords = current.records.filter((record) => !record.protected);
	const canonicalEstimate = estimateMirrorTokens(editableRecords);
	const mirrorEstimate = estimateMirrorTokens(editableRecords, (record) => record.renderText ?? record.text);
	const branch = ctx.sessionManager.getBranch();
	const edits = branch.filter((entry) => entry.type === "context_edit").length;
	return [
		"oh-my-clm status",
		`mirror: ${current.filePath}`,
		`mirror bytes: ${Buffer.byteLength(current.rendered, "utf8")}`,
		`editable blocks: ${editableRecords.length}`,
		`protected blocks: ${current.records.filter((record) => record.protected).length}`,
		`mirror preview: ~${mirrorEstimate} tokens; canonical editable: ~${canonicalEstimate} tokens`,
		`Pi context usage: ${usage?.tokens ?? `~${estimatedRequest}`}${usage?.contextWindow ? `/${usage.contextWindow}` : ""} tokens`,
		`CLM target: ${settings.budgetTokens > 0 ? `${settings.budgetTokens} (${currentTokens > settings.budgetTokens ? "OVER" : "FIT"})` : "native Pi auto-compaction"}`,
		`edit policy: shrink-only`,
		`mirror limits: ${settings.maxBlockChars} chars/block, ${settings.maxMirrorChars} chars total`,
		`persisted context edits on branch: ${edits}`,
		autoClearStatusLine(ctx),
	].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function mirrorReadToolCallIds(message: unknown, cwd: string, filePath: string): Set<string> {
	const ids = new Set<string>();
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return ids;
	for (const part of message.content) {
		if (!isRecord(part) || part.type !== "toolCall" || part.name !== "read" || typeof part.id !== "string") continue;
		const args = isRecord(part.arguments) ? part.arguments : undefined;
		const requested = args && typeof args.path === "string" ? args.path : undefined;
		if (!requested) continue;
		try {
			if (path.resolve(cwd, requested) === filePath) ids.add(part.id);
		} catch {
			// Invalid paths are handled by the normal read tool result.
		}
	}
	return ids;
}

function mirrorReadContextEdits(event: TurnEndEvent, ctx: ExtensionContext, filePath: string): ContextEditEntryDraft[] {
	const callIds = mirrorReadToolCallIds(event.message, ctx.cwd, filePath);
	if (callIds.size === 0) return [];
	const entries: ContextEditEntryDraft[] = [];
	for (let index = 0; index < event.toolResults.length; index += 1) {
		const result = event.toolResults[index];
		const targetId = event.toolResultEntryIds[index];
		if (!result || result.isError || !targetId || !callIds.has(result.toolCallId)) continue;
		entries.push({
			type: "context_edit",
			targetId,
			replacement: {
				content: [{
					type: "text",
					text: "[oh-my-clm] Live mirror read omitted from future context; the mirror is already available at " + filePath + ".",
				}],
			},
		});
	}
	return entries;
}

interface SessionState {
	snapshot?: MirrorSnapshot;
	/** One-shot rejection note delivered with the next request. */
	pendingNotice?: string;
	/** A synthetic nudge never enters history, so its dedup guard needs state. */
	nudgeRounds: number;
	lastNudgeTokens?: number;
	/** Completed steps. Pi commits per step, so "turn" wording would mislead. */
	completedSteps: number;
	/** Step in which a cleanup last applied; rendered as "last cleanup at step K". */
	lastCleanupStep?: number;
	/** Automatic clearing; created at `session_start` from that session's config. */
	auto?: AutoClearState;
}

/** State is keyed by session id: interleaved sessions must not share a mirror snapshot or notice. */
const states = new Map<string, SessionState>();

function freshState(): SessionState {
	return { nudgeRounds: 0, completedSteps: 0 };
}

function sessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId() || "default";
}

function sessionState(ctx: ExtensionContext): SessionState {
	const key = sessionKey(ctx);
	let state = states.get(key);
	if (!state) {
		state = freshState();
		states.set(key, state);
	}
	return state;
}

const cleanupParameters = Type.Object({
	blockIds: Type.Optional(Type.Array(
		Type.Integer({ minimum: 1 }),
		{ uniqueItems: true, description: "1-based editable block IDs. Use this for individual blocks; IDs renumber after each removal, so batch every target into one call." },
	)),
	ranges: Type.Optional(Type.Array(
		Type.String({ pattern: "^\\d+(\\s*-\\s*\\d+)?$" }),
		{ description: "Inclusive ID ranges such as \"3-16\" or \"42\". Prefer one range for a whole turn; the range clamps to the current surface and block 1 is preserved." },
	)),
	skipRoles: Type.Optional(Type.Array(
		Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("toolResult"), Type.Literal("custom")]),
		{ uniqueItems: true, description: "Roles to keep even when a requested range covers them; use [\"user\"] to drop a turn's tool noise but keep the human message." },
	)),
	offload: Type.Optional(Type.Array(
		Type.Object({
			blockId: Type.Integer({ minimum: 1 }),
			note: Type.String({ minLength: 1, maxLength: 240, description: "One short fact that must survive; it becomes the block's new body." }),
		}, { additionalProperties: false }),
		{ description: "Keep a block in place and replace its body with `[offloaded: <note>]`, a shorter line you write. Use it when the block's fact still matters; the placeholder must shrink the block. assistant and toolResult blocks only; block 1 and user blocks cannot be offloaded." },
	)),
	list: Type.Optional(Type.String({
		pattern: "^\\d+(\\s*-\\s*\\d+)?$",
		description: "Read-only: return the rows of this inclusive ID range (\"3-16\" or \"42\") without removing anything. Use it to inspect a range before deleting it. Cannot be combined with blockIds, ranges, skipRoles, or offload.",
	})),
}, { additionalProperties: false });

const cleanupOutputSchema = Type.Object({
	status: Type.Union([Type.Literal("applied"), Type.Literal("rejected"), Type.Literal("listed")]),
	requestedBlockIds: Type.Array(Type.Integer({ minimum: 1 })),
	removedBlockIds: Type.Array(Type.Integer({ minimum: 1 })),
	pairedRemovalIds: Type.Array(Type.Integer({ minimum: 1 })),
	offloadedBlockIds: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
	reason: Type.String(),
	rows: Type.Optional(Type.String()),
}, { additionalProperties: false });

function rejectedCleanupResult(requestedBlockIds: readonly number[], reason: string): CleanupToolResult {
	return {
		status: "rejected",
		requestedBlockIds: [...requestedBlockIds],
		removedBlockIds: [],
		pairedRemovalIds: [],
		reason,
	};
}

/**
 * The block index the model should see after this cleanup: removed records are
 * gone and offloaded bodies are swapped, so the 1-based IDs renumber exactly as
 * the next canonical render will show them. Pi has no runtime block index, so
 * a `full` result copy is the only place the model sees the new numbering
 * without opening the mirror.
 */
function refreshedBlockIndex(records: readonly MirrorRecord[], plan: CleanupPlan): string | undefined {
	if (plan.status !== "applied") return undefined;
	const omitted = new Set(plan.omittedIds);
	const bodies = new Map(plan.offloads.map((offload) => [offload.recordId, offload.body] as const));
	const next = records
		.filter((record) => !omitted.has(record.id))
		.map((record) => {
			const body = bodies.get(record.id);
			return body === undefined ? record : { ...record, text: body };
		});
	return renderBlockIndex(next);
}

/**
 * The declared output is the tool's model-visible contract, so `details` carries
 * the full result while `structuredContent` carries only declared fields.
 */
function cleanupToolResponse(result: CleanupToolResult) {
	return {
		content: [{ type: "text" as const, text: formatCleanupToolResult(result) }],
		details: result,
		structuredContent: {
			status: result.status,
			requestedBlockIds: result.requestedBlockIds,
			removedBlockIds: result.removedBlockIds,
			pairedRemovalIds: result.pairedRemovalIds,
			...(result.offloadedBlockIds === undefined ? {} : { offloadedBlockIds: result.offloadedBlockIds }),
			reason: result.reason,
			...(result.rows === undefined ? {} : { rows: result.rows }),
		},
		isError: result.status === "rejected",
	};
}

function executePiCleanup(params: unknown, ctx: ExtensionContext): CleanupToolResult {
	const state = sessionState(ctx);
	const parsedArgs = parseCleanupArgs(params);
	if (!parsedArgs.ok) return rejectedCleanupResult([], parsedArgs.reason);

	const filePath = mirrorPath(ctx);
	const settings = config(ctx);
	const buildRecords = () => buildMirrorRecords(getProjection(ctx).entries, {
		mirrorPath: filePath,
		maxBlockChars: settings.maxBlockChars,
		maxMirrorChars: settings.maxMirrorChars,
	});
	// A listing is answered from the projection and never touches the mirror, so
	// it works even while the mirror file is missing or stale.
	if (parsedArgs.args.list) return describeCleanupList(buildRecords(), parsedArgs.args.list);

	// Pi appends the assistant message carrying this very tool call after the
	// request-time mirror write, so an in-turn cleanup usually finds the file one
	// message behind the projection and would always fail the snapshot check.
	// Re-render the canonical projection when the file still holds exactly the
	// text this extension last wrote. A file changed outside the mirror flow is
	// left alone, so the staleness rejection still protects uncommitted edits.
	const previous = state.snapshot;
	const onDisk = readText(filePath);
	// A change already made in this step (a mirror edit, or an earlier cleanup)
	// leaves the file's snapshot behind the live projection, because Pi appends the
	// assistant message carrying this very tool call after the request-time write.
	// Re-rendering would discard that change, so it is kept and reported instead.
	// The constraint is per step: `turn_end` fires at the end of each step and
	// refreshes the baseline, so a later step can cleanup again.
	const changedThisStep = previous !== undefined && onDisk !== undefined && onDisk !== previous.rendered;
	if (!previous || onDisk === undefined || onDisk === previous.rendered) syncMirror(ctx);

	const records = buildRecords();
	const text = readText(filePath);
	if (text === undefined) return rejectedCleanupResult(parsedArgs.args.blockIds, `The live mirror is unavailable at ${filePath}.`);

	const plan = planCleanup(
		records,
		parseCleanupMirror(text),
		parsedArgs.args,
		{ fixedTokens: fixedRequestTokens(ctx), hostUsage: hostUsageOfContext(ctx) },
	);
	// `full` copies the index into the result; `compact`/`none` rely on the next
	// request's mirror render. The copy mode only shapes the model-visible text,
	// never the structured record.
	const copy = settings.resultMode;
	const indexCopy = (current: readonly MirrorRecord[]): string | undefined =>
		copy === "full" ? renderBlockIndex(current) : undefined;
	if (plan.status !== "applied") {
		if (changedThisStep && /snapshot is stale/.test(plan.reason ?? "")) {
			return rejectedCleanupResult(
				plan.requestedBlockIds,
				"The mirror was already changed earlier in this step, so it no longer matches the live projection. Do at most one cleanup per step, and run it before any mirror edit.",
			);
		}
		return cleanupToolResult(plan, indexCopy(records), copy);
	}

	try {
		// All filesystem work is synchronous and completes before this tool
		// returns. The bridge therefore cannot observe a half-finished cleanup.
		// Omission drops the spans; an offload keeps the span and swaps only its
		// body, so both actions share one validated top-level scan.
		const removal = rewriteMirrorBlocks(text, {
			remove: plan.removedBlockIds,
			replace: plan.offloads,
		});
		if (!removal.ok) {
			return rejectedCleanupResult(
				plan.requestedBlockIds,
				`Cleanup could not rewrite the live mirror: ${removal.reason}.`,
			);
		}
		writePrivateText(filePath, removal.text);
		// Report the placeholder in the usage line as "last cleanup at step K":
		// the current step is the one after the last committed step.
		state.lastCleanupStep = state.completedSteps + 1;
	} catch (error) {
		return rejectedCleanupResult(
			plan.requestedBlockIds,
			`Cleanup could not write the live mirror: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return cleanupToolResult(
		plan,
		copy === "full" ? refreshedBlockIndex(records, plan) : undefined,
		copy,
	);
}

/**
 * Budget pressure as one system line inside the request that is already going
 * out. The old shape claimed a whole "context-only" turn
 * and told the model to stop task work; this one hands it the same usage line
 * and candidate payload as the DSH turn-boundary trigger, so the answer is a
 * confirmation rather than an interruption.
 *
 * The I-2 stop condition is unchanged: the nudge never enters history, so its
 * own marker guard can never see a previous nudge. Two consecutive rounds
 * without a real shrink stop the loop, and a real shrink or a low-pressure
 * round resets the budget.
 */
function contextBudgetNudge(
	ctx: ExtensionContext,
	messages: readonly unknown[],
	records: readonly MirrorRecord[],
	state: SessionState,
): string | undefined {
	const settings = config(ctx);
	const hostUsage = hostUsageOfContext(ctx);
	const configuredWindow = settings.windowTokens;
	const hostWindow = hostUsage?.contextWindow
		?? (configuredWindow > 0 ? configuredWindow : undefined)
		?? ctx.model?.contextWindow
		?? 0;
	if (messages.some((message) => messageText(message).includes(CONTEXT_NUDGE_MARKER))) return undefined;
	const estimated = fixedRequestTokens(ctx) + messages.reduce<number>((total, message) => total + estimateMessageTokens(message), 0);
	// Host-exact usage wins over the 3.5 chars/token estimate (P1-2), so the
	// decision and the rendered line agree.
	const tokens = hostUsage?.tokens ?? estimated;
	// The host window is **not** a trigger by default. Measured on deepseek-flash
	// (2026-11-09): a 1,000,000-token window means "75% of the window" is
	// unreachable — the session sat at 12% after 84 requests — and a break that
	// late has already lost the cache game. Pressure is priced only against an
	// explicit budget; otherwise the trigger is a candidate that pays for its
	// own prefix break, the host-independent step/tool-share thresholds, or an
	// explicit `cleanup.trigger.usagePercent`.
	const budget = settings.budgetTokens;
	const plan = planCleanupTrigger(records, {
		usageTokens: tokens,
		...(budget > 0 ? { contextWindow: budget } : hostWindow > 0 ? { contextWindow: hostWindow } : {}),
		exactUsage: hostUsage !== undefined,
		// Pi commits one request per step, so it reports the step clock and leaves
		// the turn clock to a host that actually counts turns. Passing steps as
		// "turns" used to make a `completedTurns` threshold silently 17x stricter.
		completedTurns: 0,
		completedSteps: state.completedSteps,
		...(state.lastCleanupStep !== undefined ? { lastCleanupStep: state.lastCleanupStep } : {}),
		currentStep: state.completedSteps + 1,
	}, {
		// An explicit config percentage replaces the built-in 75%-of-budget
		// default; against no budget it prices the host window like DSH does.
		...(settings.triggerUsagePercent > 0
			? { usagePercent: settings.triggerUsagePercent }
			: budget > 0 ? { usagePercent: CONTEXT_NUDGE_FRACTION * 100 } : {}),
		stepsSinceCleanup: settings.triggerSince,
		toolResultShare: settings.triggerToolShare,
		maxCandidates: settings.triggerMaxCandidates,
		minSavingsTokens: settings.triggerMinSavingsTokens,
		cacheDiscount: settings.cacheDiscount,
		paybackTurns: settings.paybackTurns,
		paybackSteps: settings.paybackSteps,
	});
	let payload: CleanupTriggerPlan | undefined = plan.triggered ? plan : undefined;
	if (!payload) {
		// No threshold fired, but the candidate half is a trigger of its own: if a
		// range can pay for the prefix break it causes, that is worth one line.
		const assembled = assembleCleanupCandidates(records, {
			maxCandidates: settings.triggerMaxCandidates,
			minSavingsTokens: settings.triggerMinSavingsTokens,
			cacheDiscount: settings.cacheDiscount,
			paybackTurns: settings.paybackTurns,
			paybackSteps: settings.paybackSteps,
		});
		const best = assembled.candidates[0];
		if (best) {
			payload = {
				triggered: true,
				signals: [`best range pays back: net ~${best.netTokens} tok at r = ${formatPercent(settings.cacheDiscount * 100)}`],
				...assembled,
			};
		}
	}
	if (!payload) {
		// Nothing to confirm: stay silent rather than nag the model into an edit
		// that costs more than it saves. A later episode starts with a fresh loop
		// budget.
		state.nudgeRounds = 0;
		state.lastNudgeTokens = undefined;
		return undefined;
	}
	if (state.nudgeRounds >= MAX_NUDGE_ROUNDS) return undefined;

	const editable = records.filter((record) => !record.protected);
	// An explicit budget is the operative target, so it is the basis of both
	// halves of the payload; without one the window is only context for the
	// reader. Measuring the line against the window while the decision uses a
	// smaller budget produced self-contradictory copy ("usage 15% ≥ 75%").
	const usageLine = formatUsageLine({
		tokens,
		...(budget > 0 ? { contextWindow: budget } : hostWindow > 0 ? { contextWindow: hostWindow } : {}),
		exact: hostUsage !== undefined,
		editableBlocks: editable.length,
		...(state.lastCleanupStep !== undefined ? { lastCleanupStep: state.lastCleanupStep } : {}),
		turnWord: "step",
	});
	const candidates = renderCleanupCandidates(payload);
	const action = candidates
		? `${candidates}\nConfirm it in this same request, then continue the task.`
		: "No settled range pays for the prefix break it would cause; trim the tail (the step in progress) instead of rewriting older turns.";
	const nudge = `${CONTEXT_NUDGE_MARKER}\n${usageLine}\n${action}\n${CONTEXT_NUDGE_MARKER}`;
	const nudgeTokens = estimateMessageTokens({ role: "system", content: nudge });
	if (hostWindow > 0 && tokens + nudgeTokens + CONTEXT_RESERVE_TOKENS > hostWindow) return undefined;

	const previous = state.lastNudgeTokens;
	if (previous !== undefined && tokens < previous) {
		// Real progress (a cleanup shrank the request) earns a fresh budget.
		state.nudgeRounds = 0;
	}
	state.nudgeRounds += 1;
	state.lastNudgeTokens = tokens;
	return nudge;
}

/** Tool results a cleared target may come back within and still count as a miss. */
const BREAKER_WINDOW_RESULTS = 3;
/**
 * Distinct targets a session must have had to refuse before the channel stops.
 *
 * A key is refused only after the model came back to it twice, and the first
 * re-read is the one the placeholder ordered before an edit. So this counts
 * targets the clear genuinely mis-priced, not clears the model followed the
 * pointer on — the rate this divides is the one the instruction cannot inflate.
 */
const BREAKER_MIN_REFUSED = 3;

/** What one settlement decided, as `/clm status` and the ledger report it. */
interface AutoClearReport {
	readonly candidates: number;
	readonly tokens: number;
	readonly outcome: string;
}

/** Per-session clearing state: the selector, the breaker and the ledger counters. */
interface AutoClearState {
	readonly tracker: SupersessionTracker;
	readonly reread: RereadPolicy;
	/** Call id → target key, so an error result can be attributed to a cleared key. */
	readonly callKeys: Map<string, string>;
	/** Blocks already written to the ledger, so a skipped pass cannot repeat them. */
	readonly reported: Set<string>;
	/** Keys of cleared targets still inside the breaker window. */
	recent: { readonly key: string; readonly at: number }[];
	clearedTotal: number;
	clearedTokens: number;
	passes: number;
	rereads: number;
	errors: number;
	errorRereads: number;
	turnRereads: number;
	turnErrors: number;
	turnErrorRereads: number;
	qualityDirty: boolean;
	/** Monotonic feed counter; the seq the ledger names for calls and results. */
	seq: number;
	/** Agent loops started in this session; the turn clock behind the stale rule. */
	turn: number;
	/** Set once this session stops clearing; latched until the plugin reloads. */
	stop?: "breaker";
	last?: AutoClearReport;
}

function freshAutoState(settings: Config): AutoClearState {
	return {
		tracker: new SupersessionTracker({
			staleTurns: settings.autoClear.staleTurns,
			staleSteps: settings.autoClear.staleSteps,
			minAgeSteps: settings.autoClear.minAgeSteps,
			maxAgeSteps: settings.autoClear.maxAgeSteps,
		}),
		reread: createRereadPolicy(),
		callKeys: new Map(),
		reported: new Set(),
		recent: [],
		clearedTotal: 0,
		clearedTokens: 0,
		passes: 0,
		rereads: 0,
		errors: 0,
		errorRereads: 0,
		turnRereads: 0,
		turnErrors: 0,
		turnErrorRereads: 0,
		qualityDirty: false,
		seq: 0,
		turn: 0,
	};
}

function autoState(state: SessionState, settings: Config): AutoClearState {
	if (state.auto === undefined) state.auto = freshAutoState(settings);
	return state.auto;
}

function isRefetchTool(name: string): boolean {
	return (REFETCH_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Feed one boundary's tool traffic to the selector.
 *
 * Calls are noted before their results: a call ages by the results that had
 * already landed when it happened, so one boundary's calls must not see the
 * boundary's own results as older than they are.
 */
function feedAutoClear(ac: AutoClearState, event: TurnEndEvent): void {
	const results = Array.isArray(event.toolResults) ? event.toolResults : [];
	const resultEntryIds = Array.isArray(event.toolResultEntryIds) ? event.toolResultEntryIds : [];
	const entryByCallId = new Map<string, string>();
	for (let index = 0; index < results.length; index += 1) {
		const result = results[index] as unknown;
		const entryId = resultEntryIds[index];
		if (!isRecord(result) || typeof result.toolCallId !== "string" || typeof entryId !== "string") continue;
		entryByCallId.set(result.toolCallId, entryId);
	}
	const callSeqs = new Map<string, number>();
	const message = event.message as unknown;
	if (isRecord(message) && Array.isArray(message.content)) {
		for (const part of message.content) {
			if (!isRecord(part) || (part.type !== "toolCall" && part.type !== "tool-call")) continue;
			if (typeof part.id !== "string" || typeof part.name !== "string") continue;
			const entryId = entryByCallId.get(part.id);
			if (entryId === undefined || !isRefetchTool(part.name)) continue;
			const args = parseToolArguments(part.arguments);
			const key = targetKeyOf(part.name, args);
			if (key !== undefined) ac.callKeys.set(part.id, key);
			noteRefetch(ac, part.name, args);
			const seq = ++ac.seq;
			callSeqs.set(part.id, seq);
			ac.tracker.noteCall({ name: part.name, args, blockId: entryId, seq, blockAge: ac.tracker.resultsSeen });
		}
	}
	for (let index = 0; index < results.length; index += 1) {
		const result = results[index] as unknown;
		const entryId = resultEntryIds[index];
		if (!isRecord(result) || typeof entryId !== "string") continue;
		ac.tracker.noteBlockLanding();
		const tokens = estimateMessageTokens(result);
		ac.tracker.noteBlockTokens(entryId, tokens, ++ac.seq, ac.turn);
		const callSeq = typeof result.toolCallId === "string" ? callSeqs.get(result.toolCallId) : undefined;
		if (callSeq !== undefined) ac.tracker.noteOutput(callSeq, tokens);
		noteToolOutcome(ac, typeof result.toolCallId === "string" ? result.toolCallId : undefined, result.isError === true);
	}
}

/** Drop breaker evidence older than its window so the list cannot grow with the session. */
function pruneRecent(ac: AutoClearState): void {
	const now = ac.tracker.resultsSeen;
	ac.recent = ac.recent.filter((entry) => now - entry.at <= BREAKER_WINDOW_RESULTS);
}

/** Put one cleared target into the breaker window, keeping one entry per key. */
function rememberClearedKey(ac: AutoClearState, key: string, at: number): void {
	const index = ac.recent.findIndex((entry) => entry.key === key);
	if (index < 0) {
		ac.recent.push({ key, at });
		return;
	}
	const existing = ac.recent[index];
	if (existing !== undefined && existing.at < at) ac.recent[index] = { key, at };
}

/**
 * Count a cleared target the model asked for again, and trip the breaker.
 *
 * A re-read is not by itself a mistake: the placeholder orders one before an
 * edit, so a plain re-read only moves the ledger. What the breaker watches is
 * refused targets — a key the model came back to a second time — and their rate
 * against everything this session cleared.
 */
function noteRefetch(ac: AutoClearState, name: string, args: unknown): void {
	if (ac.stop !== undefined) return;
	pruneRecent(ac);
	if (ac.recent.length === 0) return;
	const key = targetKeyOf(name, args);
	if (key === undefined) return;
	for (const cleared of ac.recent) {
		if (cleared.key !== key) continue;
		ac.rereads += 1;
		ac.turnRereads += 1;
		ac.qualityDirty = true;
		if (noteKeyReread(ac.reread, key)) {
			ac.recent = ac.recent.filter((entry) => entry.key !== key);
			const total = Math.max(ac.clearedTotal, 1);
			const refused = ac.reread.refused.size;
			if (refused < BREAKER_MIN_REFUSED || refused * 2 < total) return;
			ac.stop = "breaker";
			return;
		}
	}
}

/**
 * Count one tool result's error outcome. An error on a target this session
 * cleared means the pointer sent the model back to something that no longer
 * works; a plain error count is the background rate that makes it readable.
 */
function noteToolOutcome(ac: AutoClearState, callId: string | undefined, isError: boolean): void {
	const key = callId === undefined ? undefined : ac.callKeys.get(callId);
	if (callId !== undefined) ac.callKeys.delete(callId);
	if (!isError) return;
	ac.errors += 1;
	ac.turnErrors += 1;
	if (key === undefined) return;
	if (!ac.recent.some((entry) => entry.key === key)) return;
	ac.errorRereads += 1;
	ac.turnErrorRereads += 1;
	ac.qualityDirty = true;
}

/** The part of a batch a settlement may still act on. */
function liveBatchOf(ac: AutoClearState, batch: CanaryBatch, selfReadIds: ReadonlySet<string>): CanaryBatch {
	const candidates = batch.candidates.filter((candidate) =>
		!ac.tracker.isRetired(candidate.blockId)
		&& !candidateRefused(ac.reread, candidate)
		&& !selfReadIds.has(candidate.blockId),
	);
	if (candidates.length === batch.candidates.length) return batch;
	return { candidates, tokens: candidates.reduce((total, candidate) => total + Math.max(0, candidate.tokens), 0) };
}

/**
 * Candidates whose body the pointer would actually shrink, measured on the
 * canonical text the draft replaces. The mirror preview is only the editing
 * view: a truncated preview blocks a model edit, not a runtime-authored clear,
 * because the canonical body stays in the session log either way.
 */
function usableCandidates(records: readonly MirrorRecord[], candidates: readonly ClearCandidate[]): ClearCandidate[] {
	const byId = new Map(records.map((record) => [record.id, record] as const));
	const usable: ClearCandidate[] = [];
	for (const candidate of candidates) {
		const record = byId.get(candidate.blockId);
		if (record === undefined || record.protected || record.role !== "toolResult") continue;
		if (clearPlaceholder(candidate.label, candidate.tokens).length >= record.text.length) continue;
		usable.push(candidate);
	}
	return usable;
}

/**
 * One-time re-prefill cost of a batch: the model-visible tokens behind its
 * earliest cleared block, minus the bodies the same batch removes. Priced from
 * the mirror records, which are the model-visible blocks in surface order.
 */
function mirrorSuffixTokens(records: readonly MirrorRecord[], candidates: readonly ClearCandidate[]): number | undefined {
	const editable = records.filter((record) => !record.protected);
	const positionOf = new Map(editable.map((record, index) => [record.id, index] as const));
	const priced = candidates
		.map((candidate) => ({ position: positionOf.get(candidate.blockId), tokens: Math.max(0, Math.round(candidate.tokens)) }))
		.filter((entry): entry is { position: number; tokens: number } => entry.position !== undefined);
	if (priced.length === 0) return undefined;
	const earliest = Math.min(...priced.map((entry) => entry.position));
	const tails = new Map<number, number>();
	let after = 0;
	for (let index = editable.length - 1; index >= 0; index -= 1) {
		tails.set(index, after);
		after += estimateMirrorTokens([editable[index] as MirrorRecord]);
	}
	const behind = tails.get(earliest) ?? 0;
	const removedBehind = priced
		.filter((entry) => entry.position > earliest)
		.reduce((total, entry) => total + entry.tokens, 0);
	return Math.max(0, behind - removedBehind);
}

/** The money channel's verdict on one priced batch; `rot` ignores both tests. */
function moneyVerdict(settings: Config, batch: CanaryBatch, suffixTokens: number | undefined): boolean {
	if (settings.autoClear.channel === "rot") return true;
	if (suffixTokens === undefined) return true;
	if (settings.autoClear.maxSuffixTokens > 0 && suffixTokens > settings.autoClear.maxSuffixTokens) return false;
	if (settings.autoClear.minNetTokens < 0) return true;
	const payback = settings.paybackSteps > 0 ? settings.paybackSteps : settings.paybackTurns;
	const net = batchNetTokens(batch.tokens, suffixTokens, settings.cacheDiscount, payback);
	return net >= settings.autoClear.minNetTokens;
}

/** One ledger line per boundary: the newly dead blocks plus what the last clear did. */
function writeAutoCanaryLine(
	ctx: ExtensionContext,
	ac: AutoClearState,
	settings: Config,
	settlement: {
		readonly batch: CanaryBatch;
		readonly gate: boolean;
		readonly outcome: string;
		readonly usage: HostUsage | undefined;
		readonly suffixTokens?: number;
	},
): void {
	if (!settings.autoClear.canary) return;
	const fresh = settlement.batch.candidates.filter((candidate) => !ac.reported.has(candidate.blockId));
	// An empty batch is written even without a fresh candidate or a new outcome:
	// the line is the only evidence that the selector ran and found nothing.
	if (fresh.length === 0 && settlement.batch.candidates.length > 0 && !ac.qualityDirty) return;
	const record: CanaryRecord = {
		at: Date.now(),
		turn: ac.turn,
		tokens: fresh.reduce((total, candidate) => total + Math.max(0, Math.round(candidate.tokens)), 0),
		...(settlement.suffixTokens === undefined ? {} : { suffixTokens: settlement.suffixTokens }),
		candidates: fresh,
		gate: settlement.gate,
		outcome: settlement.outcome,
		quality: {
			contextTokens: Math.max(0, Math.round(settlement.usage?.tokens ?? 0)),
			turn: {
				rereads: ac.turnRereads,
				errors: ac.turnErrors,
				errorRereads: ac.turnErrorRereads,
			},
			session: {
				results: ac.tracker.resultsSeen,
				clearedBlocks: ac.clearedTotal,
				clearedTokens: ac.clearedTokens,
				passes: ac.passes,
				rereads: ac.rereads,
				errors: ac.errors,
				errorRereads: ac.errorRereads,
			},
		},
	};
	try {
		appendPrivateLine(sessionCanaryPath(sessionKey(ctx)), JSON.stringify(record));
		for (const candidate of fresh) ac.reported.add(candidate.blockId);
	} catch {
		// A failed ledger write must never take the clear down with it.
	}
	ac.turnRereads = 0;
	ac.turnErrors = 0;
	ac.turnErrorRereads = 0;
	ac.qualityDirty = false;
}

/**
 * One turn-boundary settlement, and the drafts that commit it.
 *
 * The engine is the shared selector; the write is the draft list this adapter
 * already returns at `turn_end`. A cleared block becomes one `context_edit`
 * whose replacement is the shared placeholder: the session log keeps the
 * original event, the active projection shows the pointer, and the host replays
 * the edit deterministically on resume, fork and branch navigation. A draft the
 * pointer would not shrink is never proposed, so every committed clear strictly
 * shrinks the model-visible copy.
 */
function autoClearSettlement(
	ctx: ExtensionContext,
	state: SessionState,
	event: TurnEndEvent,
	snapshot: MirrorSnapshot,
	selfReadEntries: readonly ContextEditEntryDraft[],
): SessionBoundaryDraft[] {
	const settings = config(ctx);
	const auto = settings.autoClear;
	if (!auto.enabled && !auto.canary) return [];
	const ac = autoState(state, settings);
	const selfReadIds = new Set(selfReadEntries.map((entry) => entry.targetId));
	const stopBefore = ac.stop;
	feedAutoClear(ac, event);
	if (ac.stop !== undefined && stopBefore === undefined) {
		notify(ctx, "oh-my-clm auto-clear stopped for this session: most cleared targets had to be refused after re-reads", "warning");
	}
	const usage = hostUsageOfContext(ctx);
	const onDisk = readText(snapshot.filePath);
	// A model edit or a cleanup call already changed the mirror this step, or the
	// mirror is gone entirely; the pending diff owns this boundary, and piling a
	// clear on top would make one boundary's outcome depend on the other's. The
	// next boundary re-offers the candidates.
	const mirrorBusy = onDisk === undefined || onDisk !== snapshot.rendered;
	const batch = liveBatchOf(ac, ac.tracker.peekBatch(ac.turn), selfReadIds);
	const usable = usableCandidates(snapshot.records, batch.candidates);
	const usableBatch: CanaryBatch = {
		candidates: usable,
		tokens: usable.reduce((total, candidate) => total + Math.max(0, Math.round(candidate.tokens)), 0),
	};
	const gate: BatchGate = {
		minTokens: auto.minTokens,
		minBlocks: auto.minBlocks,
		minShare: auto.minSharePercent / 100,
		maxSuffixTokens: auto.maxSuffixTokens,
		minNetTokens: auto.minNetTokens,
	};
	const volume = batchPassesGate(usableBatch, gate, usage?.tokens ?? 0);
	const suffixTokens = mirrorSuffixTokens(snapshot.records, usable);
	const money = moneyVerdict(settings, usableBatch, suffixTokens);
	const gateOpen = auto.channel === "both" ? volume || money : volume && money;
	let outcome: string;
	if (usableBatch.candidates.length === 0) outcome = "no-candidate";
	else if (mirrorBusy) outcome = "dirty-mirror";
	else if (ac.stop !== undefined) outcome = ac.stop;
	else if (auto.enabled && gateOpen) {
		outcome = usage !== undefined && (usage.tokens / usage.contextWindow) * 100 >= auto.stopPercent
			? "occupancy"
			: "cleared";
	} else {
		outcome = gateOpen ? "canary" : "gate";
	}
	const cleared = outcome === "cleared" ? usable : [];
	const drafts: SessionBoundaryDraft[] = cleared.map((candidate) => ({
		type: "context_edit",
		targetId: candidate.blockId,
		replacement: { content: [{ type: "text", text: clearPlaceholder(candidate.label, candidate.tokens) }] },
	}));
	ac.last = { candidates: usableBatch.candidates.length, tokens: usableBatch.tokens, outcome };
	if (cleared.length > 0) {
		// The draft commits when the host appends this boundary's proposal, the
		// same way the self-read replacement already does; retiring here keeps the
		// selector from re-offering the block at the next boundary.
		ac.tracker.retire(cleared.map((candidate) => candidate.blockId));
		ac.passes += 1;
		ac.clearedTotal += cleared.length;
		ac.clearedTokens += usableBatch.tokens;
		const now = ac.tracker.resultsSeen;
		for (const candidate of cleared) {
			for (const key of candidate.keys) rememberClearedKey(ac, key, now);
		}
		pruneRecent(ac);
		notify(
			ctx,
			`oh-my-clm auto-clear: replaced ${cleared.length} tool result(s) with re-read pointers (~${usableBatch.tokens} tokens)`,
			"info",
		);
	}
	writeAutoCanaryLine(ctx, ac, settings, { batch: usableBatch, gate: gateOpen, outcome, usage, suffixTokens });
	return drafts;
}

/** The `/clm status` line for the clearing channel. */
function autoClearStatusLine(ctx: ExtensionContext): string {
	const settings = config(ctx);
	if (!settings.autoClear.enabled && !settings.autoClear.canary) return "auto-clear: off";
	const ac = sessionState(ctx).auto;
	const mode = [
		settings.autoClear.enabled ? "enabled" : undefined,
		settings.autoClear.canary ? "canary" : undefined,
	].filter(Boolean).join("+");
	const last = ac?.last === undefined ? "" : `; last: ${ac.last.outcome} (${ac.last.candidates} candidate(s))`;
	const stopped = ac?.stop === undefined ? "" : `; stopped (${ac.stop})`;
	return `auto-clear: ${mode}; ${ac?.passes ?? 0} pass(es), ${ac?.clearedTotal ?? 0} block(s) cleared${last}${stopped}`;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		const current = event.systemPromptOptions.appendSystemPrompt ?? "";
		if (!current.includes(PROMPT_MARKER)) {
			event.systemPromptOptions.appendSystemPrompt = `${current}${current ? "\n\n" : ""}${promptAppendix(ctx)}`;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const state = freshState();
		state.auto = freshAutoState(config(ctx));
		states.set(sessionKey(ctx), state);
		// A bad config key must not be silent: the plugin falls back to that key's
		// default, and the user needs to know which line was ignored.
		for (const warning of loadClmConfig(ctx.cwd).warnings) {
			notify(ctx, `oh-my-clm config: ${warning}`, "warning");
		}
		// The loader cannot warn about these: they are valid keys. Report the set
		// once per session so "configured on Pi, no effect" is never silent.
		const ignored = ignoredConfigKeys(ctx.cwd);
		if (ignored.length > 0) {
			notify(ctx, `oh-my-clm config: parsed but ignored on Pi (DSH-only): ${ignored.join(", ")}`, "warning");
		}
		// A session switch (including `/resume`) does not necessarily trigger a
		// model request immediately. Rebuild the external mirror here, after Pi
		// has bound the new SessionManager, so it cannot retain the previous
		// session's projection while the user is idle.
		syncMirror(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		states.set(sessionKey(ctx), freshState());
	});

	pi.on("agent_start", async (_event, ctx) => {
		// One agent loop = one user request = one turn for the stale rule's clock.
		// Sessions that never arm the channel keep no clearing state to age.
		const state = states.get(sessionKey(ctx));
		if (state?.auto !== undefined) state.auto.turn += 1;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		states.delete(sessionKey(ctx));
	});

	pi.on("context", async (event: ContextEvent, ctx): Promise<ContextEventResult | void> => {
		const state = sessionState(ctx);
		const snapshot = syncMirror(ctx);
		// Runtime notices are system-role messages, not synthetic human turns.
		// Pi supports mid-conversation system messages and restores the leading
		// prompt around any context-handler result. The handler runs as Pi's
		// request-scoped `transformContext`: the returned list is used for this
		// provider request and never appended to session history, so a one-shot
		// notice cannot become a persistent system instruction on later requests.
		const additions: { role: "system"; content: string; timestamp: number }[] = [];
		// A rejected or reverted mirror edit is reported once, on the request after
		// it happened. Without this the model sees a successful write that silently
		// disappeared from the next mirror render.
		if (state.pendingNotice) {
			additions.push({
				role: "system",
				content: `<pi-clm-edit-notice>\n${state.pendingNotice}\n</pi-clm-edit-notice>`,
				timestamp: Date.now(),
			});
			state.pendingNotice = undefined;
		}
		if (snapshot.records.some((record) => !record.protected)) {
			const nudge = contextBudgetNudge(ctx, Array.isArray(event.messages) ? event.messages : [], snapshot.records, state);
			if (nudge) additions.push({ role: "system", content: nudge, timestamp: Date.now() });
		}
		if (additions.length === 0) return;
		return { messages: [...event.messages, ...additions] };
	});

	pi.on("turn_end", async (event: TurnEndEvent, ctx) => {
		const state = sessionState(ctx);
		// Pi commits at the end of every step; the usage line says "step" so a
		// cleanup position is not mislabelled as a whole user turn.
		state.completedSteps += 1;
		const snapshot = state.snapshot;
		if (!snapshot) return;
		const selfReadEntries = mirrorReadContextEdits(event, ctx, snapshot.filePath);
		// The settlement runs before the manual diff so its drafts ride the same
		// boundary proposal; the mirror itself is left to the next request's sync.
		const autoDrafts = autoClearSettlement(ctx, state, event, snapshot, selfReadEntries);
		const edited = readText(snapshot.filePath);
		if (edited === undefined) return;
		const parsed = parseMirror(edited);
		const plan = planContextEdits(snapshot.records, parsed, editPlanOptions(ctx));
		if (plan.status === "noop" && selfReadEntries.length === 0 && autoDrafts.length === 0) return;

		const newEntries: SessionBoundaryDraft[] = [];
		if (plan.status === "applied") {
			state.pendingNotice = undefined;
			for (const edit of plan.edits) {
				newEntries.push({
					type: "context_edit",
					targetId: edit.targetId,
					replacement: edit.replacement as { content: ContextEditableContent } | null,
				});
			}
			notify(
				ctx,
				"CLM edit applied: ~" + plan.beforeTokens + " -> ~" + plan.afterTokens + " estimated request tokens" +
					(plan.omittedIds.length ? "; omitted " + plan.omittedIds.length : ""),
				"info",
			);
		} else if (plan.status === "rejected") {
			state.pendingNotice = rejectedEditNotice(plan.reason);
			notify(ctx, "CLM edit rejected: " + (plan.reason ?? "invalid edit"), "warning");
		}
		if (selfReadEntries.length > 0) newEntries.push(...selfReadEntries);
		if (autoDrafts.length > 0) newEntries.push(...autoDrafts);
		if (plan.warnings.length > 0 && ctx.hasUI) ctx.ui.notify(plan.warnings.join("; "), "warning");
		if (newEntries.length === 0) return;
		return { entries: [...event.entries, ...newEntries] };
	});

	pi.registerTool({
		name: "cleanup",
		label: "Cleanup context",
		description: "Remove stale CLM context blocks by ID without reading or reconstructing their bodies, keep one with a shorter `[offloaded: <note>]` body, or list the rows of an ID range (read-only) to identify targets.",
		promptSnippet: "Remove or soft-unload stale context blocks by ID",
		promptGuidelines: [
			"Remove stale CLM context blocks by ID; batch every target into one call because IDs renumber after each removal.",
			"cleanup({ offload: [{ blockId, note }] }) keeps the block and its ID but replaces the body with your one-line note; use it when the fact still matters.",
			"cleanup({ list: \"A-B\" }) inspects a range without removing anything.",
		],
		parameters: cleanupParameters,
		outputSchema: cleanupOutputSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				return cleanupToolResponse(rejectedCleanupResult([], "cleanup was cancelled before the mirror was changed."));
			}
			return cleanupToolResponse(executePiCleanup(params, ctx));
		},
	});

	pi.registerCommand("clm", {
		description: "Show the oh-my-clm live context status",
		handler: async (args, ctx) => {
			if (args.trim() && args.trim() !== "status") {
				notify(ctx, "Usage: /clm status", "warning");
				return;
			}
			notify(ctx, statusText(ctx, sessionState(ctx).snapshot), "info");
		},
	});
}
