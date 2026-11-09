import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type {
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
	DEFAULT_MAX_BLOCK_CHARS,
	DEFAULT_MAX_MIRROR_CHARS,
	estimateMessageTokens,
	estimateMirrorTokens,
	hostUsageOf,
	messageText,
	mirrorSignature,
	parseMirror,
	planContextEdits,
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
	planCleanup,
	type CleanupToolResult,
} from "../src/features/live-context/context-cleanup.ts";
import {
	assembleCleanupCandidates,
	formatPercent,
	formatUsageLine,
	renderCleanupCandidates,
} from "../src/features/live-context/context-trigger.ts";
import { writePrivateText } from "../src/lib/clm-files.ts";
import { sessionMirrorPath } from "../src/lib/clm-paths.ts";
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
	maxBlockChars: number;
	maxMirrorChars: number;
}

interface MirrorSnapshot {
	filePath: string;
	records: MirrorRecord[];
	rendered: string;
	signature: string;
}

function positiveEnv(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function config(): Config {
	return {
		budgetTokens: positiveEnv("CLM_CONTEXT_BUDGET", 0),
		maxBlockChars: DEFAULT_MAX_BLOCK_CHARS,
		maxMirrorChars: DEFAULT_MAX_MIRROR_CHARS,
	};
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
 * the editable mirror; fall back to the model's window when the host omits it.
 */
function hostUsageOfContext(ctx: ExtensionContext): HostUsage | undefined {
	const usage = ctx.getContextUsage?.();
	if (!usage) return undefined;
	return hostUsageOf({ tokens: usage.tokens, contextWindow: usage.contextWindow ?? ctx.model?.contextWindow });
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
	const settings = config();
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
 * (`cleanupParameters` owns that), no protocol internals, no env switches, and
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
	const settings = config();
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

function mirrorReadContextEdits(event: TurnEndEvent, ctx: ExtensionContext, filePath: string): SessionBoundaryDraft[] {
	const callIds = mirrorReadToolCallIds(event.message, ctx.cwd, filePath);
	if (callIds.size === 0) return [];
	const entries: SessionBoundaryDraft[] = [];
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

function executePiCleanup(params: unknown, ctx: ExtensionContext): CleanupToolResult {
	const state = sessionState(ctx);
	const parsedArgs = parseCleanupArgs(params);
	if (!parsedArgs.ok) return rejectedCleanupResult([], parsedArgs.reason);

	const filePath = mirrorPath(ctx);
	const settings = config();
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
	if (plan.status !== "applied") {
		if (changedThisStep && /snapshot is stale/.test(plan.reason ?? "")) {
			return rejectedCleanupResult(
				plan.requestedBlockIds,
				"The mirror was already changed earlier in this step, so it no longer matches the live projection. Do at most one cleanup per step, and run it before any mirror edit.",
			);
		}
		return cleanupToolResult(plan);
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
	return cleanupToolResult(plan);
}

/**
 * Budget pressure as one system line inside the request that is already going
 * out (docs/plan.md §5.3). The old shape claimed a whole "context-only" turn
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
	const settings = config();
	const hostUsage = hostUsageOfContext(ctx);
	const hostWindow = hostUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	// Without CLM_CONTEXT_BUDGET the host window is the budget: a switch must
	// not be required before the plugin can react to real pressure.
	const budget = settings.budgetTokens > 0 ? settings.budgetTokens : hostWindow;
	if (budget <= 0) return undefined;
	if (messages.some((message) => messageText(message).includes(CONTEXT_NUDGE_MARKER))) return undefined;
	const target = Math.max(1, budget - CONTEXT_RESERVE_TOKENS);
	const estimated = fixedRequestTokens(ctx) + messages.reduce<number>((total, message) => total + estimateMessageTokens(message), 0);
	// Host-exact usage wins over the 3.5 chars/token estimate (P1-2), so the
	// decision and the rendered line agree.
	const tokens = hostUsage?.tokens ?? estimated;
	if (tokens < Math.floor(target * CONTEXT_NUDGE_FRACTION)) {
		// Budget pressure is gone: a later episode must get a fresh loop budget.
		state.nudgeRounds = 0;
		state.lastNudgeTokens = undefined;
		return undefined;
	}
	if (state.nudgeRounds >= MAX_NUDGE_ROUNDS) return undefined;

	const editable = records.filter((record) => !record.protected);
	// The budget is the operative target, so it is the basis of *both* halves of
	// the payload. Measuring the line against the host window while the decision
	// uses a smaller explicit budget produced self-contradictory copy
	// ("Suggested cleanup (usage 15% ≥ 75%)"); the window still guards whether the
	// nudge itself fits, nothing more.
	const usageLine = formatUsageLine({
		tokens,
		contextWindow: budget,
		exact: hostUsage !== undefined,
		editableBlocks: editable.length,
		...(state.lastCleanupStep !== undefined ? { lastCleanupTurn: state.lastCleanupStep } : {}),
		turnWord: "step",
	});
	// Same assembly and rendering as §5.2; only the threshold decision differs.
	const signals = [
		`${hostUsage ? "" : "~"}usage ${formatPercent((tokens / budget) * 100)} ≥ ${formatPercent(CONTEXT_NUDGE_FRACTION * 100)}`,
	];
	const candidates = renderCleanupCandidates({ triggered: true, signals, ...assembleCleanupCandidates(records) });
	const action = candidates
		? `${candidates}\nConfirm it in this same request, then continue the task.`
		: "Use one `cleanup` call or one mirror edit to free enough context, then continue the task.";
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

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		const current = event.systemPromptOptions.appendSystemPrompt ?? "";
		if (!current.includes(PROMPT_MARKER)) {
			event.systemPromptOptions.appendSystemPrompt = `${current}${current ? "\n\n" : ""}${promptAppendix(ctx)}`;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		states.set(sessionKey(ctx), freshState());
		// A session switch (including `/resume`) does not necessarily trigger a
		// model request immediately. Rebuild the external mirror here, after Pi
		// has bound the new SessionManager, so it cannot retain the previous
		// session's projection while the user is idle.
		syncMirror(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		states.set(sessionKey(ctx), freshState());
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
		const edited = readText(snapshot.filePath);
		if (edited === undefined) return;
		const parsed = parseMirror(edited);
		const plan = planContextEdits(snapshot.records, parsed, editPlanOptions(ctx));
		if (plan.status === "noop" && selfReadEntries.length === 0) return;

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
				const result = rejectedCleanupResult([], "cleanup was cancelled before the mirror was changed.");
				return {
					content: [{ type: "text", text: formatCleanupToolResult(result) }],
					details: result,
					structuredContent: {
						status: result.status,
						requestedBlockIds: result.requestedBlockIds,
						removedBlockIds: result.removedBlockIds,
						pairedRemovalIds: result.pairedRemovalIds,
						reason: result.reason,
					},
					isError: true,
				};
			}
			const result = executePiCleanup(params, ctx);
			return {
				content: [{ type: "text", text: formatCleanupToolResult(result) }],
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
