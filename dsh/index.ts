import * as fs from "node:fs";
import {
	CLM_MIRROR_FILENAME,
	CLM_TEMP_ROOT,
	sessionMirrorPath,
} from "../src/lib/clm-paths.ts";
import { writePrivateText } from "../src/lib/clm-files.ts";
import {
	buildDshMirrorRecords,
	dshBlockIndexText,
	dshOpenTurnStep,
	executeDshCleanup,
	reconcileDshMirror,
	type DshBridgeOptions,
	type DshBridgeState,
	type DshFileSystem,
	type DshSessionLike,
} from "../src/features/live-context/dsh-bridge.ts";
import {
	DEFAULT_BLOCK_INDEX_HEAD,
	DEFAULT_BLOCK_INDEX_PREVIEW_CHARS,
	DEFAULT_BLOCK_INDEX_TAIL,
	DEFAULT_DIGEST_MAX_LINES,
	estimateMirrorTokens,
	renderMirror,
} from "../src/features/live-context/context-format.ts";
import {
	formatCleanupToolResult,
	parseCleanupArgs,
	parseCleanupResultCopy,
	type CleanupResultCopy,
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

interface DshCommandResult {
	readonly kind: "success" | "error";
	readonly text: string;
}

interface DshCommandInvocation {
	readonly agent: DshAgent;
	/** Exact text following `/clm`, including separator whitespace. */
	readonly rawInput: string;
}

interface DshCommandDefinition {
	readonly name: string;
	readonly description: string;
	readonly input?: { readonly hint: string };
	readonly handler: (invocation: DshCommandInvocation) => DshCommandResult | Promise<DshCommandResult>;
}

interface DshCommandsRuntime {
	register(definition: DshCommandDefinition): () => unknown;
}

interface DshContext {
	readonly tools?: DshToolsRuntime;
	readonly commands?: DshCommandsRuntime;
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

/**
 * Live mode override set by `/clm mode`. The DSH process reads its environment
 * once at launch, so an environment-only switch cannot be A/B tested inside a
 * running session; this field keeps that experiment possible without a restart.
 */
const indexModeOverride: { value?: "blocks" | "digest" } = {};

/**
 * `digest` lists one line per closed turn and is the default; `blocks` lists
 * individual blocks. `CLM_INDEX_MODE` selects the process default, and
 * `/clm mode` selects it for the lifetime of the running process.
 */
function indexMode(): "blocks" | "digest" {
	if (indexModeOverride.value) return indexModeOverride.value;
	return process.env.CLM_INDEX_MODE === "blocks" ? "blocks" : "digest";
}

/**
 * The model-visible contract for the live-context index.
 *
 * This section is injected into every request of every session, so each line
 * here is a standing tax on the model's attention. It carries only facts the
 * model cannot get anywhere else: what the index is, that `cleanup` is the
 * preferred way to free window, that the mirror is editable for compression,
 * and what is protected.
 *
 * The mirror path and its editability are in scope because the mirror is the
 * compression interface. Everything else stays out, however useful it sounds:
 * - the `cleanup` API itself (parameters, `ranges`, `skipRoles`, `list`, result
 *   copy). `cleanupParameters` below is the single source of truth; repeating
 *   it here is what previously pushed this section to ~4 KB and made a rare
 *   maintenance tool compete with the user's actual task;
 * - the mirror file format, edit validation, refresh cadence, host-vs-sandbox
 *   `/tmp` differences, and session event ordering: the model has no action for
 *   any of them;
 * - environment variables or operational switches.
 *
 * `test/features/live-context/dsh-bridge.test.ts` caps the rendered length, so
 * growth fails the suite instead of silently taxing every request.
 */
function promptText(): string {
	const mirrorTemplate = `${CLM_TEMP_ROOT}/clm-<session-id>/${CLM_MIRROR_FILENAME}`;
	return `<oh-my-clm-dsh-live-context>
\`<oh-my-clm-block-index>\` lists compacted-away history as 1-based IDs; a turn's range is inclusive.
Prefer \`cleanup\` to free window: whole-turn ranges (e.g. \`["3-16"]\`) remove in one call, and \`cleanup({ list: "A-B" })\` inspects a range without removing anything.
To compress instead, edit the session mirror at \`${mirrorTemplate}\` (the exact path is above the block index): shorten the block body, and keep the protocol header, the \`CLM_SNAPSHOT\` line, IDs, roles, and markers unchanged. Rewriting a tool-call block also omits its tool result: put the fact in that body.
Block 1 and the initial task are protected. Nothing else is required of you.
</oh-my-clm-dsh-live-context>`;
}

/**
 * Copy mode for the model-visible cleanup result. The bridge stamps it into its
 * transient result, but the tool strips that host-only field before DSH
 * validates the output; the renderer parses the same environment switch
 * independently, so both sides stay in sync.
 */
function cleanupResultCopy(): CleanupResultCopy {
	return parseCleanupResultCopy(process.env.CLM_CLEANUP_RESULT);
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
		cleanupResult: cleanupResultCopy(),
		indexMode: indexMode(),
		blockIndex: {
			maxPreviewChars: positiveEnv("CLM_INDEX_PREVIEW", DEFAULT_BLOCK_INDEX_PREVIEW_CHARS),
			headBlocks: positiveEnv("CLM_INDEX_HEAD", DEFAULT_BLOCK_INDEX_HEAD),
			// `CLM_INDEX_MIDDLE` is the pre-rename knob; it is honoured as a
			// fallback so an existing profile keeps its override.
			tailBlocks: positiveEnv("CLM_INDEX_TAIL", positiveEnv("CLM_INDEX_MIDDLE", DEFAULT_BLOCK_INDEX_TAIL)),
			maxLines: positiveEnv("CLM_INDEX_LINES", DEFAULT_DIGEST_MAX_LINES),
		},
	};
}

/**
 * Render the current editable block index into DSH's dynamic runtime context.
 * DSH appends this snapshot as a sourced user message, so the same 1-based IDs
 * that `cleanup` accepts are visible in chat context without a mirror read. A
 * failure returns empty text rather than breaking prompt assembly.
 *
 * The concrete mirror path belongs here rather than in the static section: the
 * section is registered once per process and could only show the
 * `<session-id>` template, which the model cannot resolve. Keep this prefix to
 * the path alone, so the snapshot stays a stable, cache-friendly header.
 */
function blockIndexContextText(
	context: { agent?: DshAgent },
	states: ReadonlyMap<string, DshBridgeState>,
): string {
	const session = context.agent?.session;
	if (!session) return "";
	try {
		const options = optionsFor(session);
		const index = dshBlockIndexText(
			session,
			options,
			states.get(String(session.id)),
			positiveEnv("CLM_INDEX_REFRESH_STEPS", 4),
		);
		if (!index) return "";
		return `Mirror: ${options.mirrorPath}\n${index}`;
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
			description: "1-based editable block IDs from the live block index. Use this for individual blocks; IDs renumber after each removal, so pass every target in one call.",
		},
		ranges: {
			type: "array",
			items: { type: "string" },
			description: "Inclusive ID ranges such as \"3-16\" or \"42\". Prefer one range for a whole turn. A range that runs past the current surface clamps, and block 1 is preserved.",
		},
		skipRoles: {
			type: "array",
			items: { type: "string", enum: ["user", "assistant", "toolResult", "custom"] },
			description: "Roles to keep even when a requested range covers them; use [\"user\"] to drop a turn's tool noise but keep the human message.",
		},
		list: {
			type: "string",
			description: "Read-only: return the rows of this inclusive ID range (\"3-16\" or \"42\") without removing anything. Use it to inspect a range the index named but did not list. Cannot be combined with blockIds, ranges, or skipRoles.",
		},
	},
	additionalProperties: false,
} as const;

/**
 * The declared output is the tool's model-visible contract: DSH validates the
 * returned body value against it and rejects any undeclared property because
 * of `additionalProperties: false`, so host-only rendering state (the cleanup
 * copy mode) must not ride along in the returned object.
 */
const cleanupOutputSchema = {
	type: "object",
	properties: {
		status: { type: "string", enum: ["applied", "rejected", "listed"] },
		requestedBlockIds: { type: "array", items: { type: "integer" } },
		removedBlockIds: { type: "array", items: { type: "integer" } },
		pairedRemovalIds: { type: "array", items: { type: "integer" } },
		reason: { type: "string" },
		blockIndex: { type: "string" },
		rows: { type: "string" },
	},
	required: ["status", "requestedBlockIds", "removedBlockIds", "pairedRemovalIds", "reason"],
	additionalProperties: false,
} as const;

function createDshCleanupTool(getState: (sessionId: string) => DshBridgeState | undefined) {
	return {
		name: "cleanup",
		description: "Remove stale CLM context blocks by ID range or by individual ID from the live block index without reading or reconstructing their bodies, or list the rows of a range (read-only) to identify targets the index only named.",
		parameters: cleanupParameters,
		output: {
			schema: cleanupOutputSchema,
			render: (_args: unknown, value: unknown) => [
				{
					type: "text",
					text: formatCleanupToolResult(value as CleanupToolResult, cleanupResultCopy()),
				},
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
			const result = await executeDshCleanup(
				session,
				parsed.args,
				optionsFor(session),
				fileSystem,
				getState(String(session.id)),
			);
			// `copy` steers how much text output.render emits. It is host-side
			// rendering state, not tool-output data, so keep it out of the value
			// DSH snapshots and validates against cleanupOutputSchema.
			const { copy: _copy, ...output } = result;
			return output;
		},
	};
}

const CLM_COMMAND_USAGE = "Usage: /clm [status | mode [blocks|digest|auto]]";

/** Compare the on-disk mirror with the projection the bridge would write now. */
function mirrorStateText(current: string | undefined, canonical: string): string {
	if (current === undefined) return "missing (written on the next bridge pass)";
	if (current === canonical) return "in sync";
	return "differs from the current projection (pending edit or stale)";
}

/**
 * Human-readable status for the active DSH session. Everything is derived from
 * the session surface and the canonical mirror projection; no state is cached,
 * so `/clm status` is accurate even before the first bridge pass.
 */
function dshStatusText(session: DshSessionLike, options: DshBridgeOptions): string {
	const records = buildDshMirrorRecords(session, options);
	const editable = records.filter((record) => !record.protected);
	const canonicalText = renderMirror(records);
	const fixedTokens = options.fixedTokens ?? 0;
	const canonicalTokens = estimateMirrorTokens(editable);
	const previewTokens = estimateMirrorTokens(editable, (record) => record.renderText ?? record.text);
	return [
		"oh-my-clm status (DSH)",
		`session: ${String(session.id)}`,
		`mirror: ${options.mirrorPath}`,
		`mirror state: ${mirrorStateText(readText(options.mirrorPath), canonicalText)}`,
		`mirror bytes: ${Buffer.byteLength(canonicalText, "utf8")}`,
		`editable blocks: ${editable.length}`,
		`protected blocks: ${records.length - editable.length}`,
		`mirror preview: ~${previewTokens} tokens; canonical editable: ~${canonicalTokens} tokens`,
		`estimated request: ~${fixedTokens + canonicalTokens} tokens (fixed request ~${fixedTokens} + editable mirror ~${canonicalTokens})`,
		`DSH surface nodes: ${session.surface.nodes.length}`,
		`block index: ${options.indexMode ?? "blocks"}`,
		"edit policy: shrink-only",
		`mirror limits: ${options.maxBlockChars ?? 12_000} chars/block, ${options.maxMirrorChars ?? 96_000} chars total`,
	].join("\n");
}

function createDshClmCommand(onModeChange: (mode: "blocks" | "digest") => void): DshCommandDefinition {
	return {
		name: "clm",
		description: "Show the oh-my-clm live context status or switch the index mode",
		input: { hint: "status | mode [blocks|digest|auto]" },
		handler: (invocation) => {
			const input = invocation.rawInput.trim();
			if (input.startsWith("mode")) {
				const requested = input.slice(4).trim();
				if (requested === "") {
					const current = indexMode();
					const source = indexModeOverride.value ? "process override" : `CLM_INDEX_MODE=${process.env.CLM_INDEX_MODE ?? "unset"}`;
					return { kind: "success", text: `oh-my-clm index mode: ${current} (${source})` };
				}
				if (requested !== "blocks" && requested !== "digest" && requested !== "auto") {
					return { kind: "error", text: CLM_COMMAND_USAGE };
				}
				indexModeOverride.value = requested === "auto" ? undefined : requested;
				onModeChange(indexMode());
				return {
					kind: "success",
					text: requested === "auto"
						? `oh-my-clm index mode: ${indexMode()} (auto; follows CLM_INDEX_MODE, default digest).`
						: `oh-my-clm index mode: ${requested}. The next step re-renders the block index; this override lasts until the process restarts (set CLM_INDEX_MODE to persist it, or /clm mode auto to drop it).`,
				};
			}
			if (input.length > 0 && input !== "status") {
				return { kind: "error", text: CLM_COMMAND_USAGE };
			}
			const session = invocation.agent?.session;
			if (!session) {
				return { kind: "error", text: "oh-my-clm: the active DSH agent has no session." };
			}
			try {
				return { kind: "success", text: dshStatusText(session, optionsFor(session)) };
			} catch (error) {
				return {
					kind: "error",
					text: `oh-my-clm: could not render status: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
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
			text: (context) => blockIndexContextText(context, states),
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

	if (ctx.commands) {
		// `/clm` mirrors the Pi extension's status command. The command registry
		// owns the definition as a Cordis effect, so it is removed with the plugin.
		ctx.commands.register(createDshClmCommand(() => {
			// Mode changes the rendered index; every cached preview is now wrong.
			for (const state of states.values()) state.blockIndex = undefined;
		}));
	} else {
		ctx.logger?.warn?.("oh-my-clm: DSH commands runtime unavailable; /clm was not registered");
	}

	ctx.on("agent/created", ({ agent }: { agent: DshAgent }) => {
		const session = agent.session;
		if (!session) {
			ctx.logger?.warn?.("oh-my-clm: agent has no session; DSH bridge is inactive for it");
			return;
		}
		const state: DshBridgeState = {};
		// State is session-scoped: the cleanup tool and the block-index context
		// both look it up by session id, and a subagent's agent id need not match.
		const key = String(session.id);
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
		const key = String(session.id);
		const state = states.get(key);
		if (!state) return;
		// Wait for a completed tool result (or a new user message) so a model
		// edit made by a tool is checked against the pre-step snapshot rather
		// than a half-settled assistant tool-call node. step/start also flushes
		// an edit that agent/pre-step had to defer because no step was open.
		if (event?.type === "tool/result" || event?.type === "user/message" || event?.type === "step/start") {
			void enqueueReconcile(ctx, session, state, queues, () => states.get(key) === state);
			return;
		}
		// Compaction rewrites the surface and can renumber editable IDs without
		// going through cleanup or a mirror edit.
		if (typeof event?.type === "string" && event.type.includes("compaction")) {
			state.blockIndex = undefined;
		}
	});

	ctx.on("agent/disposed", ({ agent }: { agent: DshAgent }) => {
		states.delete(String(agent.session?.id ?? agent.id));
	});
}

export const inject = ["systemPrompt", "tools", "commands"] as const;
