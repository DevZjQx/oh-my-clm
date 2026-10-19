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
	CLEANUP_DISCIPLINE,
	DEFAULT_MAX_BLOCK_CHARS,
	DEFAULT_MAX_MIRROR_CHARS,
	estimateMessageTokens,
	estimateMirrorTokens,
	messageText,
	mirrorSignature,
	parseMirror,
	planContextEdits,
	renderMirror,
	type EditPlanOptions,
	type MirrorRecord,
	type ProjectionEntryLike,
} from "../src/features/live-context/context-format.ts";
import { writePrivateText } from "../src/lib/clm-files.ts";
import {
	cleanupToolResult,
	describeCleanupList,
	formatCleanupToolResult,
	parseCleanupArgs,
	parseCleanupMirror,
	planCleanup,
	removeMirrorBlocks,
	type CleanupToolResult,
} from "../src/features/live-context/context-cleanup.ts";
import { sessionMirrorPath } from "../src/lib/clm-paths.ts";
const STATUS_KEY = "oh-my-clm";
const PROMPT_MARKER = "<pi-clm-live-context>";
const CONTEXT_NUDGE_MARKER = "<pi-clm-budget-nudge>";
const CONTEXT_RESERVE_TOKENS = 2_048;
const CONTEXT_NUDGE_FRACTION = 0.75;

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

function editPlanOptions(ctx: ExtensionContext): EditPlanOptions {
	return { allowGrowth: false, fixedTokens: fixedRequestTokens(ctx) };
}

function updateStatus(ctx: ExtensionContext, records: readonly MirrorRecord[], filePath: string, note?: string): void {
	if (!ctx.hasUI) return;
	const settings = config();
	const estimated = fixedRequestTokens(ctx) + estimateMirrorTokens(records);
	const usage = ctx.getContextUsage();
	const current = usage?.tokens ?? estimated;
	const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const budget = settings.budgetTokens > 0
		? ` · target ${settings.budgetTokens} ${current > settings.budgetTokens ? "OVER" : "FIT"}`
		: "";
	const context = window > 0 ? `ctx ~${current}/${window}` : `ctx ~${current}`;
	const suffix = note ? ` · ${note}` : "";
	ctx.ui.setStatus(
		STATUS_KEY,
		ctx.ui.theme.fg("accent", `CLM ${context}${budget} · ${records.length} blocks · ${filePath}${suffix}`),
	);
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

function projectionSignature(records: readonly MirrorRecord[]): string {
	return mirrorSignature(records);
}

function syncMirror(ctx: ExtensionContext, force = false): MirrorSnapshot {
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
		// turn_end, where Pi accepts context_edit entries.
		const parsed = parseMirror(current);
		const pending = planContextEdits(previous.records, parsed, editPlanOptions(ctx));
		if (pending.status !== "noop") {
			writePrivateText(filePath, rendered);
			state.lastNotice = "mirror edit restored; edit it during an agent turn";
		} else {
			writePrivateText(filePath, rendered);
		}
	}

	const snapshot = { filePath, records, rendered, signature };
	state.snapshot = snapshot;
	updateStatus(ctx, records, filePath, state.lastNotice);
	state.lastNotice = undefined;
	return snapshot;
}

function promptAppendix(ctx: ExtensionContext): string {
	const filePath = mirrorPath(ctx);
	return `${PROMPT_MARKER}
When old conversation turns become noise, manage your own Pi context through \`${filePath}\`.
- The file uses blocks like \`[[CLM_ENTRY id=1 role=assistant]]\` followed by a matching \`[[/CLM_ENTRY id=1]]\`; the id is an editable ordinal. Keep both markers exactly as written and do not reorder blocks.
- Keep the \`CLM_SNAPSHOT\` line and protocol comments intact. It prevents stale edits from changing a newer projection.
- Use the registered \`cleanup({ blockIds: [...] })\` tool for stale, redundant, or self-referential blocks; it works by ID, preserves load-bearing block 1, and does not read truncated bodies. \`cleanup({ list: \"A-B\" })\` is read-only: it returns the rows of a range (role and short preview) so you can inspect before deleting.
- ${CLEANUP_DISCIPLINE}
- For a \`rewrite\`, use one host-side script that completes its read and write before returning; preserve the protocol header, \`CLM_SNAPSHOT\`, and block 1.
- For an \`edit\`, change the smallest necessary existing block body to a short, faithful summary only when the complete old body is available; never use a truncated preview as \`old_string\`.
- Delete an editable block to omit stale history. To delete the last editable block, leave the \`<!-- CLM_EMPTY -->\` marker.
- The initial task is protected and is intentionally not shown in the file.
- User-authored blocks may be omitted when stale, but cannot be rewritten.
- For a broader context change, use one ordinary host-side bash/edit/write operation during an agent turn. Do not read or cat the mirror as a separate step, and print no mirror contents. The extension persists an accepted edit as a branch-local context edit after the turn.
- Tool-call assistant turns are kept structurally safe: rewriting or deleting one also removes its paired tool results.
- A tool result that reads this live mirror is automatically replaced in future context with a short pointer; avoid reading it unless absolutely necessary.
- When a ${CONTEXT_NUDGE_MARKER} appears, this is a context-only turn: edit the mirror now, do no task work, and stop after the one edit operation.
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

const state: {
	snapshot?: MirrorSnapshot;
	lastNotice?: string;
} = {};

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
	list: Type.Optional(Type.String({
		pattern: "^\\d+(\\s*-\\s*\\d+)?$",
		description: "Read-only: return the rows of this inclusive ID range (\"3-16\" or \"42\") without removing anything. Use it to inspect a range before deleting it. Cannot be combined with blockIds, ranges, or skipRoles.",
	})),
}, { additionalProperties: false });

const cleanupOutputSchema = Type.Object({
	status: Type.Union([Type.Literal("applied"), Type.Literal("rejected"), Type.Literal("listed")]),
	requestedBlockIds: Type.Array(Type.Integer({ minimum: 1 })),
	removedBlockIds: Type.Array(Type.Integer({ minimum: 1 })),
	pairedRemovalIds: Type.Array(Type.Integer({ minimum: 1 })),
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
	const parsedArgs = parseCleanupArgs(params);
	if (!parsedArgs.ok) return rejectedCleanupResult([], parsedArgs.reason);

	const filePath = mirrorPath(ctx);
	const settings = config();
	const records = buildMirrorRecords(getProjection(ctx).entries, {
		mirrorPath: filePath,
		maxBlockChars: settings.maxBlockChars,
		maxMirrorChars: settings.maxMirrorChars,
	});
	// A listing is answered from the projection and never touches the mirror, so
	// it works even while the mirror file is missing or stale.
	if (parsedArgs.args.list) return describeCleanupList(records, parsedArgs.args.list);

	const text = readText(filePath);
	if (text === undefined) return rejectedCleanupResult(parsedArgs.args.blockIds, `The live mirror is unavailable at ${filePath}.`);

	const plan = planCleanup(
		records,
		parseCleanupMirror(text),
		parsedArgs.args,
		{ fixedTokens: fixedRequestTokens(ctx) },
	);
	if (plan.status !== "applied") return cleanupToolResult(plan);

	try {
		// All filesystem work is synchronous and completes before this tool
		// returns. The bridge therefore cannot observe a half-finished cleanup.
		const cleaned = removeMirrorBlocks(text, plan.removedBlockIds);
		writePrivateText(filePath, cleaned);
	} catch (error) {
		return rejectedCleanupResult(
			plan.requestedBlockIds,
			`Cleanup could not write the live mirror: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return cleanupToolResult(plan);
}

function contextBudgetNudge(ctx: ExtensionContext, messages: readonly unknown[]): string | undefined {
	const budget = config().budgetTokens;
	if (budget <= 0) return undefined;
	if (messages.some((message) => messageText(message).includes(CONTEXT_NUDGE_MARKER))) return undefined;
	const target = Math.max(1, budget - CONTEXT_RESERVE_TOKENS);
	const tokens = fixedRequestTokens(ctx) + messages.reduce<number>((total, message) => total + estimateMessageTokens(message), 0);
	if (tokens < Math.floor(target * CONTEXT_NUDGE_FRACTION)) return undefined;

	const filePath = mirrorPath(ctx);
	const nudge = `${CONTEXT_NUDGE_MARKER}
You are at approximately ${tokens}/${budget} context tokens. This is a context-only turn.
Use \`cleanup({ ranges: [\"A-B\"] })\` or \`cleanup({ blockIds: [...] })\` to remove stale blocks; it completes the host-side mutation without a separate mirror read. For a broader change, use exactly one host-side rewrite/edit operation to shorten ${filePath}; do not read or print the mirror, do no task work, and stop after that operation.
Preserve the CLM protocol and keep the facts needed for the current task.
${CONTEXT_NUDGE_MARKER}`;
	const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const nudgeTokens = estimateMessageTokens({ role: "user", content: nudge });
	if (contextWindow > 0 && tokens + nudgeTokens + CONTEXT_RESERVE_TOKENS > contextWindow) return undefined;
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
		state.snapshot = undefined;
		state.lastNotice = undefined;
		// A session switch (including `/resume`) does not necessarily trigger a
		// model request immediately. Rebuild the external mirror here, after Pi
		// has bound the new SessionManager, so it cannot retain the previous
		// session's projection while the user is idle.
		syncMirror(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		state.snapshot = undefined;
		state.lastNotice = "branch changed";
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "CLM branch changed; mirror will refresh"));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		state.snapshot = undefined;
	});

	pi.on("context", async (event: ContextEvent, ctx): Promise<ContextEventResult | void> => {
		const snapshot = syncMirror(ctx);
		if (!snapshot.records.some((record) => !record.protected)) return;
		const nudge = contextBudgetNudge(ctx, Array.isArray(event.messages) ? event.messages : []);
		if (!nudge) return;
		return {
			messages: [...event.messages, { role: "user" as const, content: nudge, timestamp: Date.now() }],
		};
	});

	pi.on("turn_end", async (event: TurnEndEvent, ctx) => {
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
			notify(ctx, "CLM edit rejected: " + (plan.reason ?? "invalid edit"), "warning");
		}
		if (selfReadEntries.length > 0) newEntries.push(...selfReadEntries);
		if (plan.warnings.length > 0 && ctx.hasUI) ctx.ui.notify(plan.warnings.join("; "), "warning");
		state.lastNotice = selfReadEntries.length > 0
			? "self-referential mirror read omitted"
			: plan.status === "applied"
				? "edit persisted"
				: "edit rejected";
		if (newEntries.length === 0) return;
		return { entries: [...event.entries, ...newEntries] };
	});

	pi.registerTool({
		name: "cleanup",
		label: "Cleanup context",
		description: "Remove stale CLM context blocks by ID without reading or reconstructing their bodies, or list the rows of an ID range (read-only) to identify targets.",
		promptSnippet: "Remove stale context blocks by ID",
		promptGuidelines: [
			"Use cleanup({ ranges: [\"A-B\"] }) for a whole turn, or cleanup({ blockIds: [...] }) for individual blocks.",
			"Use cleanup({ list: \"A-B\" }) to read the rows of a range without removing anything; it cannot be combined with removal targets.",
			"Block 1 is load-bearing and is always preserved.",
			"Pass every target in one call; cleanup renumbers IDs after each removal. Paired tool results are reported separately.",
			"Cleanup is sequential and completes its host-side mirror write before returning.",
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
			notify(ctx, statusText(ctx, state.snapshot), "info");
		},
	});
}
