import * as fs from "node:fs";
import {
	CLM_MIRROR_FILENAME,
	CLM_TEMP_ROOT,
	sessionMirrorPath,
} from "../src/lib/clm-paths.ts";
import { writePrivateText } from "../src/lib/clm-files.ts";
import {
	dshOpenTurnStep,
	executeDshCleanup,
	reconcileDshMirror,
	renderDshBlockIndex,
	type DshBridgeOptions,
	type DshBridgeState,
	type DshFileSystem,
	type DshSessionLike,
} from "../src/features/live-context/dsh-bridge.ts";
import {
	formatCleanupToolResult,
	parseCleanupArgs,
	parseCleanupResultCopy,
	type CleanupToolResult,
} from "../src/features/live-context/context-cleanup.ts";

export const name = "oh-my-clm";
const PROMPT_SECTION = "oh-my-clm:live-context";
const BLOCK_INDEX_CONTEXT = "oh-my-clm:block-index";
const DEFAULT_ORDER = 3240;
/** Runtime context sorts after the host's sandbox/approval facts. */
const BLOCK_INDEX_ORDER = 200;

interface DshLogger {
	info?(message: string): void;
	warn?(message: string): void;
	error?(message: string): void;
}

interface DshToolsRuntime {
	register(definition: unknown): () => unknown;
}

interface DshContext {
	readonly tools?: DshToolsRuntime;
	readonly systemPrompt?: {
		section(section: { name: string; order: number; text: string }): () => void;
		context?(context: {
			name: string;
			order: number;
			text: string | ((context: { agent?: DshAgent }) => string);
		}): () => void;
		getSectionOrder?(name: string): number;
	};
	readonly logger?: DshLogger;
	on(name: string, listener: (...args: any[]) => any): () => boolean | void;
	effect?(effect: (() => unknown) | (() => Generator<unknown, unknown, unknown>), label?: string): unknown;
}

interface DshAgent {
	readonly id: string;
	readonly session?: DshSessionLike;
	readonly ctx?: DshContext;
}

function positiveEnv(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readText(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}

const fileSystem: DshFileSystem = { readText, writeText: writePrivateText };

function promptText(): string {
	const mirrorTemplate = `${CLM_TEMP_ROOT}/clm-<session-id>/${CLM_MIRROR_FILENAME}`;
	return `<oh-my-clm-dsh-live-context>
The DSH bridge mirrors the current session surface to \`${mirrorTemplate}\`.
- The live runtime context includes an \`<oh-my-clm-block-index>\` with 1-based IDs, roles, and short previews for the first and last 40 editable blocks; when the list is longer, the middle ID range is summarized. Choose cleanup IDs from that index; you do not need to read LIVE_CTX_MAIN.md just to discover IDs or identify a block.
- Use the registered \`cleanup({ blockIds: [...] })\` tool for stale, redundant, or self-referential blocks; it works by ID, preserves load-bearing block 1, and does not read truncated bodies. By default the result is a one-line confirmation; the refreshed block index already appears in each step's runtime context. Set CLM_CLEANUP_RESULT=full to append the refreshed index, or =none to suppress the result text.
- Read LIVE_CTX_MAIN.md only when you need the full, untruncated body for a rewrite. Edit only the bodies of existing CLM_ENTRY blocks; keep the protocol header, CLM_SNAPSHOT, IDs, roles, and closing markers unchanged.
- Shorten an existing block or delete it to request omitting stale history. Keep CLM_EMPTY when deleting every editable block.
- The initial user task is protected. User-authored blocks may be omitted but cannot be rewritten.
- Keep assistant tool-call/result pairs structurally safe; the bridge rejects orphan pairs.
- For a broader context rewrite, use one ordinary host-side script that completes its read and write before returning. Use a local edit only when the complete old body is available; do not print the whole mirror.
- The bridge observes a changed file after the enclosing DSH session event settles, then serializes the native mutation before the next model step. Do not keep rewriting the mirror in the background.
- DSH file tools edit the host-side \`/tmp\`; sandboxed bash may have a different \`/tmp\` unless the host explicitly shares the session directory, so prefer the file tools for this mirror.
- Legal edits are applied through DSH's public Session.append() surface-replacement seam: the bridge appends tool/result content replacements and developer/message replacements (empty for omission, text-bearing for rewritten assistant blocks) with surfaceOp replace metadata and the required sourceEventSeqs. DSH forbids assistant/message from carrying sourceEventSeqs, so an assistant block is never replaced in place by another assistant message.
- Rewritten assistant content is intentionally not attributed back to the model; it becomes a model-visible developer message. Tool-result replacements preserve their original envelope and change only content.
- The original events remain in DSH's append-only log, while the current surface and derived model history change immediately. This is DSH surface replacement, not Pi's branch-local context_edit; do not describe it as Pi branch semantics.
- The bridge writes no proposal or receipt file and does not register a custom session event. If the host does not expose the verified append seam, the edit is rejected and the mirror is restored to the canonical projection.
</oh-my-clm-dsh-live-context>`;
}

function optionsFor(session: DshSessionLike): DshBridgeOptions {
	const sessionId = String(session.id);
	const mirrorPath = sessionMirrorPath(sessionId);
	return {
		mirrorPath,
		mirrorDisplayPath: mirrorPath,
		maxBlockChars: positiveEnv("CLM_MAX_BLOCK_CHARS", 12_000),
		maxMirrorChars: positiveEnv("CLM_MAX_MIRROR_CHARS", 96_000),
		fixedTokens: positiveEnv("CLM_CONTEXT_FIXED_TOKENS", 0),
		cleanupResult: parseCleanupResultCopy(process.env.CLM_CLEANUP_RESULT),
	};
}

/**
 * Render the current editable block index into DSH's dynamic runtime context.
 * DSH appends this snapshot as a sourced user message, so the same 1-based IDs
 * that `cleanup` accepts are visible in chat context without a mirror read. A
 * failure returns empty text rather than breaking prompt assembly.
 */
function blockIndexContextText(context: { agent?: DshAgent }): string {
	const session = context.agent?.session;
	if (!session) return "";
	try {
		return renderDshBlockIndex(session, optionsFor(session));
	} catch {
		return "";
	}
}

// DSH host packages are peer dependencies, never bundled runtime dependencies.
// Importing `defineTool` from `@deepseek-ai/dsh-tools` would make pnpm install a
// second copy of that host package into the profile, and DSH's in-process tool
// scheduler is identified by a Symbol defined per module copy. With two copies,
// `ctx.tools[TOOL_RUNTIME_SCHEDULER]` is undefined and every model tool call
// fails after `tool/call` is recorded. The registry only needs the plain tool
// definition below, so this plugin keeps no runtime import of DSH packages.
const cleanupParameters = {
	type: "object",
	properties: {
		blockIds: {
			type: "array",
			items: { type: "integer" },
			description: "1-based editable block IDs from the live block index; pass every target in one call (IDs renumber after each removal); IDs must be positive and unique; block 1 is always preserved.",
		},
	},
	required: ["blockIds"],
} as const;

const cleanupOutputSchema = {
	type: "object",
	properties: {
		status: { type: "string", enum: ["applied", "rejected"] },
		requestedBlockIds: { type: "array", items: { type: "integer" } },
		removedBlockIds: { type: "array", items: { type: "integer" } },
		reason: { type: "string" },
		blockIndex: { type: "string" },
	},
	required: ["status", "requestedBlockIds", "removedBlockIds", "reason"],
	additionalProperties: false,
} as const;

function createDshCleanupTool(getState: (sessionId: string) => DshBridgeState | undefined) {
	return {
		name: "cleanup",
		description: "Remove stale CLM context blocks by ID from the live block index without reading or reconstructing their bodies.",
		parameters: cleanupParameters,
		output: {
			schema: cleanupOutputSchema,
			render: (_args: unknown, value: unknown) => [
				{ type: "text", text: formatCleanupToolResult(value as CleanupToolResult) },
			],
		},
		isConcurrencySafe: () => false,
		async execute(args: unknown, exec: { agent?: DshAgent }) {
			const parsed = parseCleanupArgs(args);
			if (!parsed.ok) throw new Error(parsed.reason);
			// The shared bridge intentionally models only the public append/surface
			// subset; DSH's concrete Session carries branded sequence types that are
			// erased at this host boundary.
			const session = exec.agent?.session as unknown as DshSessionLike | undefined;
			if (!session) throw new Error("cleanup requires an active DSH agent session.");
			return executeDshCleanup(
				session,
				parsed.args.blockIds,
				optionsFor(session),
				fileSystem,
				getState(String(session.id)),
			);
		},
	};
}

function logResult(ctx: DshContext, result: ReturnType<typeof reconcileDshMirror>): void {
	if (result.status === "applied") {
		const tokenNote = result.beforeTokens !== undefined && result.afterTokens !== undefined
			? ` (~${result.beforeTokens} -> ~${result.afterTokens} estimated mirror tokens)`
			: "";
		ctx.logger?.info?.(`oh-my-clm: DSH mirror edit applied through Session.append surface replacement${tokenNote}`);
	} else if (result.status === "rejected") {
		ctx.logger?.warn?.(`oh-my-clm: DSH mirror edit rejected: ${result.reason ?? "invalid edit"}`);
	}
}

function reconcile(ctx: DshContext, session: DshSessionLike, state: DshBridgeState): void {
	try {
		logResult(ctx, reconcileDshMirror(state, session, fileSystem, optionsFor(session)));
	} catch (error) {
		ctx.logger?.warn?.(`oh-my-clm: mirror bridge unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * DSH publishes `session/event` observers synchronously from Session.append()
 * while the append is still marked as active. Queue the bridge pass so a
 * native replacement never attempts to re-enter the append that announced the
 * event. `step/start` is the first point in a new step at which DSH accepts a
 * step-scoped developer/message replacement, so the queue is drained there
 * rather than from `agent/pre-step`, which still runs before `step/start`.
 */
function enqueueReconcile(
	ctx: DshContext,
	session: DshSessionLike,
	state: DshBridgeState,
	queues: WeakMap<DshBridgeState, Promise<void>>,
	isActive: () => boolean,
): Promise<void> {
	const previous = queues.get(state) ?? Promise.resolve();
	const run = () => new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => {
		if (isActive()) reconcile(ctx, session, state);
	});
	const next = previous.then(run, run);
	queues.set(state, next);
	void next.then(
		() => {
			if (queues.get(state) === next) queues.delete(state);
		},
		() => {
			if (queues.get(state) === next) queues.delete(state);
		},
	);
	return next;
}

/**
 * DSH host entry. The bridge deliberately uses only public Cordis lifecycle
 * surfaces, the dedicated cleanup tool seam, and ordinary filesystem I/O; it
 * does not duplicate the DSH tool matrix or write unknown session events.
 */
export function apply(ctx: DshContext): void {
	const states = new Map<string, DshBridgeState>();
	const queues = new WeakMap<DshBridgeState, Promise<void>>();
	ctx.effect?.(() => () => states.clear(), "oh-my-clm.state");
	ctx.systemPrompt?.section({
		name: PROMPT_SECTION,
		order: ctx.systemPrompt.getSectionOrder?.("TOOL_EDIT") ?? DEFAULT_ORDER,
		text: promptText(),
	});
	if (ctx.systemPrompt?.context) {
		ctx.systemPrompt.context({
			name: BLOCK_INDEX_CONTEXT,
			order: BLOCK_INDEX_ORDER,
			text: blockIndexContextText,
		});
	} else {
		ctx.logger?.warn?.("oh-my-clm: DSH systemPrompt.context unavailable; block IDs will not be shown in chat context");
	}

	if (ctx.tools) {
		// The official DSH tools registry owns this registration as a Cordis
		// effect; it is removed with the plugin fiber.
		ctx.tools.register(createDshCleanupTool((sessionId) => states.get(sessionId)));
	} else {
		ctx.logger?.warn?.("oh-my-clm: DSH tools runtime unavailable; cleanup tool was not registered");
	}

	ctx.on("agent/created", ({ agent }: { agent: DshAgent }) => {
		const session = agent.session;
		if (!session) {
			ctx.logger?.warn?.("oh-my-clm: agent has no session; DSH bridge is inactive for it");
			return;
		}
		const state: DshBridgeState = {};
		const key = String(agent.id);
		states.set(key, state);
		const agentContext = agent.ctx ?? ctx;
		const disposePreStep = agentContext.on("agent/pre-step", async (_payload: unknown, next: () => Promise<unknown>) => {
			// agent/pre-step runs before step/start, so DSH is not accepting a
			// step-scoped developer/message replacement yet. A mutation there
			// would fail validation or, worse, commit an event whose turn/step
			// does not match the log's open step. Leave pending mirror edits
			// to the step/start observer below, which runs with the new step
			// open, and keep this hook for convergence only.
			if (dshOpenTurnStep(session))
				await enqueueReconcile(ctx, session, state, queues, () => states.get(key) === state);
			return next();
		});
		// The agent context owns the listener, while this effect also makes the
		// plugin's disposer explicit when a profile unloads first.
		ctx.effect?.(() => disposePreStep, `oh-my-clm.agent(${key})`);
	});

	ctx.on("session/event", (session: DshSessionLike, event: { type?: string }) => {
		// Wait for a completed tool result (or a new user message) so a model
		// edit made by a tool is checked against the pre-step snapshot rather
		// than a half-settled assistant tool-call node. step/start also flushes
		// an edit that agent/pre-step had to defer because no step was open.
		if (event?.type !== "tool/result" && event?.type !== "user/message" && event?.type !== "step/start") return;
		const key = String(session.id);
		const state = states.get(key);
		if (state) void enqueueReconcile(ctx, session, state, queues, () => states.get(key) === state);
	});

	ctx.on("agent/disposed", ({ agent }: { agent: DshAgent }) => {
		states.delete(String(agent.id));
	});
}

export const inject = ["systemPrompt", "tools"] as const;
