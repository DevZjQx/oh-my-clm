import * as fs from "node:fs";
import * as path from "node:path";
import {
	DSH_MIRROR_RELATIVE_PATH,
	DSH_PATCH_RELATIVE_PATH,
	reconcileDshMirror,
	type DshBridgeOptions,
	type DshBridgeState,
	type DshFileSystem,
	type DshSessionLike,
} from "../src/dsh-bridge.ts";

export const name = "oh-my-clm";
const PROMPT_SECTION = "oh-my-clm:live-context";
const DEFAULT_ORDER = 3240;

interface DshLogger {
	info?(message: string): void;
	warn?(message: string): void;
	error?(message: string): void;
}

interface DshContext {
	readonly systemPrompt?: {
		section(section: { name: string; order: number; text: string }): () => void;
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

function workspaceFor(session: DshSessionLike): string {
	return session.header?.cwd ?? process.cwd();
}

function absolutePath(session: DshSessionLike, relativePath: string): string {
	return path.resolve(workspaceFor(session), relativePath);
}

function readText(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}

function writeText(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(temporaryPath, content, "utf8");
		fs.renameSync(temporaryPath, filePath);
	} finally {
		try {
			if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
		} catch {
			// The next lifecycle pass will replace the canonical mirror.
		}
	}
}

const fileSystem: DshFileSystem = { readText, writeText };

function promptText(): string {
	return `<oh-my-clm-dsh-live-context>
The DSH bridge mirrors the current session surface to \`${DSH_MIRROR_RELATIVE_PATH}\`.
- Edit only the bodies of existing CLM_ENTRY blocks; keep the protocol header, CLM_SNAPSHOT, IDs, roles, and closing markers unchanged.
- Shorten an existing block or delete it to propose omitting stale history. Keep CLM_EMPTY when deleting every editable block.
- The initial user task is protected. User-authored blocks may be omitted but cannot be rewritten.
- Keep assistant tool-call/result pairs structurally safe; the bridge rejects orphan pairs.
- Use one ordinary file edit/write operation during an agent step. Do not print the whole mirror.
- DSH has no verified branch-local context_edit API in this bridge. A legal edit is written as an explicit, auditable proposal at \`${DSH_PATCH_RELATIVE_PATH}\`; it is not silently applied to the session log.
- Do not claim that a DSH patch changed the active conversation unless a separate host policy explicitly consumes that proposal.
</oh-my-clm-dsh-live-context>`;
}

function optionsFor(session: DshSessionLike): DshBridgeOptions {
	return {
		mirrorPath: absolutePath(session, DSH_MIRROR_RELATIVE_PATH),
		mirrorDisplayPath: DSH_MIRROR_RELATIVE_PATH,
		patchPath: absolutePath(session, DSH_PATCH_RELATIVE_PATH),
		sessionId: String(session.id),
		maxBlockChars: positiveEnv("CLM_MAX_BLOCK_CHARS", 12_000),
		maxMirrorChars: positiveEnv("CLM_MAX_MIRROR_CHARS", 96_000),
		fixedTokens: positiveEnv("CLM_CONTEXT_FIXED_TOKENS", 0),
		// Keep this closure explicit so tests and future host receipts can make
		// generation deterministic without changing the format protocol.
		now: () => Date.now(),
	};
}

function logResult(ctx: DshContext, result: ReturnType<typeof reconcileDshMirror>): void {
	if (result.status === "patch-written") {
		ctx.logger?.info?.(`oh-my-clm: DSH context patch written for ${result.patch?.changedIds.length ?? 0} changed block(s)`);
	} else if (result.status === "rejected") {
		ctx.logger?.warn?.(`oh-my-clm: DSH mirror edit rejected: ${result.patch?.reason ?? "invalid edit"}`);
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
 * DSH host entry. The bridge deliberately uses only public Cordis lifecycle
 * surfaces and ordinary filesystem I/O; it does not register a duplicate tool
 * matrix or write unknown session events.
 */
export function apply(ctx: DshContext): void {
	const states = new Map<string, DshBridgeState>();
	ctx.effect?.(() => () => states.clear(), "oh-my-clm.state");
	ctx.systemPrompt?.section({
		name: PROMPT_SECTION,
		order: ctx.systemPrompt.getSectionOrder?.("TOOL_EDIT") ?? DEFAULT_ORDER,
		text: promptText(),
	});

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
			reconcile(ctx, session, state);
			return next();
		});
		// The agent context owns the listener, while this effect also makes the
		// plugin's disposer explicit when a profile unloads first.
		ctx.effect?.(() => disposePreStep, `oh-my-clm.agent(${key})`);
	});

	ctx.on("session/event", (session: DshSessionLike, event: { type?: string }) => {
		// Wait for a completed tool result (or a new user message) so a model
		// edit made by a tool is checked against the pre-step snapshot rather
		// than a half-settled assistant tool-call node.
		if (event?.type !== "tool/result" && event?.type !== "user/message") return;
		const state = states.get(String(session.id));
		if (state) reconcile(ctx, session, state);
	});

	ctx.on("agent/disposed", ({ agent }: { agent: DshAgent }) => {
		states.delete(String(agent.id));
	});
}

export const inject = ["systemPrompt"] as const;
