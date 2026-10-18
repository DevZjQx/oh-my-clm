import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply as dshHost } from "../../../dsh/index.ts";
import { sessionMirrorPath } from "../../../src/lib/clm-paths.ts";
import {
	executeDshCleanup,
	reconcileDshMirror,
	renderDshBlockIndex,
	type DshBridgeState,
	type DshFileSystem,
	type DshSessionLike,
} from "../../../src/features/live-context/dsh-bridge.ts";

class MemoryFiles implements DshFileSystem {
	readonly files = new Map<string, string>();

	readText(filePath: string): string | undefined {
		return this.files.get(filePath);
	}

	writeText(filePath: string, content: string): void {
		this.files.set(filePath, content);
	}
}

interface TestSession extends DshSessionLike {
	/** Record a control event that is not part of the message surface. */
	record(type: string, data: unknown): void;
}

function dshSession(
	cwd = "/workspace/oh-my-clm",
	id = "dsh-session-1",
	onAppend?: (event: { seq: number; type: string; data: unknown }) => void,
	lifecycle: ReadonlyArray<{ type: string; data: unknown }> = [
		{ type: "turn/start", data: { turn: 1 } },
		{ type: "step/start", data: { step: 1 } },
	],
): TestSession {
	const events: Array<{ seq: number; type: string; data: any; surfaceOp?: any; sourceEventSeqs?: readonly number[] }> = [
		{
			seq: 0,
			type: "system/message",
			data: { message: { id: "system-0", role: "system", source: { kind: "system-prompt" }, content: [{ type: "text", text: "Harness prompt" }] } },
		},
		{
			seq: 1,
			type: "user/message",
			data: { id: "user-1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Keep the repository task." }] },
		},
		{
			seq: 2,
			type: "assistant/message",
			data: {
				turn: 1,
				step: 1,
				stream: [],
				message: {
					id: "assistant-2",
					role: "assistant",
					source: { kind: "model", provider: "test", model: "test" },
					content: [
						{ type: "text", text: "I inspected the repository." },
						{ type: "tool-call", id: "call-1", name: "read", arguments: '{"path":"README.md"}' },
					],
				},
			},
		},
		{
			seq: 3,
			type: "tool/result",
			data: {
				message: {
					id: "tool-3",
					role: "tool",
					source: { kind: "tool", callId: "call-1" },
					toolCallId: "call-1",
					content: [{ type: "text", text: "Large output that can be omitted." }],
				},
			},
		},
		{
			seq: 4,
			type: "user/message",
			data: { id: "user-4", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Keep this later request." }] },
		},
	];
	for (const control of lifecycle) events.push({ seq: events.length, ...control });
	const surfaceEventTypes = new Set(["system/message", "user/message", "assistant/message", "tool/result", "developer/message"]);
	const surface = { nodes: events.filter((event) => surfaceEventTypes.has(event.type)).map((event) => event.seq) };
	let appending = false;
	const session: TestSession = {
		id,
		seq: events.length,
		header: { cwd },
		surface,
		snapshotEvents: () => events,
		record(type, data) {
			const event = { seq: events.length, type, data };
			events.push(event);
			(session as { seq: number }).seq = events.length;
			onAppend?.(event);
		},
		append(type, data, options) {
			if (appending) throw new Error("reentrant Session.append");
			const event = { seq: events.length, type, data, ...options };
			appending = true;
			try {
				events.push(event);
				if ((options.surfaceOp as { op?: string }).op === "append") {
					surface.nodes.push(event.seq);
				} else {
					const start = surface.nodes.indexOf(options.surfaceOp.startSeq);
					const end = surface.nodes.indexOf(options.surfaceOp.endSeq);
					assert.ok(start >= 0 && end >= start);
					surface.nodes.splice(start, end - start + 1, event.seq);
				}
				(session as { seq: number }).seq = events.length;
				onAppend?.(event);
			} finally {
				appending = false;
			}
			return event;
		},
	};
	return session;
}

function bridgeOptions(sessionId = "dsh-session-1") {
	return {
		mirrorPath: sessionMirrorPath(sessionId),
	};
}

function initialMirror(files: MemoryFiles, session: DshSessionLike, state: DshBridgeState): string {
	const options = bridgeOptions(String(session.id));
	reconcileDshMirror(state, session, files, options);
	return files.readText(options.mirrorPath) ?? "";
}

test("DSH bridge mirrors the host surface and applies edits through Session.append replacement", () => {
	const files = new MemoryFiles();
	const session = dshSession();
	const state: DshBridgeState = {};
	const mirror = initialMirror(files, session, state);
	assert.match(mirror, /CLM_ENTRY id=1 role=assistant/);
	assert.match(mirror, /CLM_ENTRY id=2 role=toolResult/);
	assert.doesNotMatch(mirror, /CLM_ENTRY id=0/);

	const edited = mirror
		.replace("I inspected the repository.\nread {\"path\":\"README.md\"}", "The repository is small and TypeScript-based.")
		.replace(/\n\n\[\[CLM_ENTRY id=2 role=toolResult\]\][\s\S]*?(?=\n\n\[\[CLM_ENTRY id=3)/, "\n");
	files.writeText(bridgeOptions(String(session.id)).mirrorPath, edited);
	const result = reconcileDshMirror(state, session, files, bridgeOptions(String(session.id)));
	assert.equal(result.status, "applied");
	assert.equal([...files.files.keys()].some((filePath) => filePath.endsWith(".patch.json")), false);
	assert.deepEqual(session.surface.nodes, [0, 1, 7, 8, 4]);
	assert.doesNotMatch(files.readText(bridgeOptions(String(session.id)).mirrorPath) ?? "", /Large output that can be omitted/);
	assert.doesNotMatch(files.readText(bridgeOptions(String(session.id)).mirrorPath) ?? "", /The repository is small and TypeScript-based\./);
	assert.equal(session.snapshotEvents().filter((event) => event.type === "developer/message").length, 2);
	assert.equal(session.snapshotEvents().filter((event) => event.seq >= 7).map((event) => event.type).join(","), "developer/message,developer/message");
	const rewritten = session.snapshotEvents().find((event) =>
		event.type === "developer/message"
			&& (event.data as any).message?.content?.some((part: any) => part.text === "The repository is small and TypeScript-based."),
	);
	assert.ok(rewritten);
	assert.equal((rewritten.data as any).message.role, "developer");
	assert.deepEqual((rewritten as any).sourceEventSeqs, [2]);
	// Both replacement kinds must use the step that is open at append time,
	// not the shadowed node's original envelope.
	for (const event of session.snapshotEvents().filter((candidate) => candidate.type === "developer/message")) {
		assert.equal((event.data as any).turn, 1);
		assert.equal((event.data as any).step, 1);
	}
});

test("DSH tool result rewrites keep the original event envelope", () => {
	const files = new MemoryFiles();
	const session = dshSession();
	const state: DshBridgeState = {};
	const options = bridgeOptions(String(session.id));
	const mirror = initialMirror(files, session, state);
	files.writeText(options.mirrorPath, mirror.replace("Large output that can be omitted.", "Short tool output."));

	const result = reconcileDshMirror(state, session, files, options);
	assert.equal(result.status, "applied");
	const original = session.snapshotEvents().find((event) => event.seq === 3);
	assert.ok(original);
	const replacement = session.snapshotEvents().find((event) => event.type === "tool/result" && event.seq > 6);
	assert.ok(replacement);
	assert.deepEqual((replacement.data as any).message.source, (original.data as any).message.source);
	assert.equal((replacement.data as any).message.id, "tool-3");
	assert.equal((replacement.data as any).message.toolCallId, "call-1");
	assert.equal((replacement.data as any).turn, undefined);
	assert.equal((replacement.data as any).step, undefined);
	assert.deepEqual((replacement.data as any).message.content, [{ type: "text", text: "Short tool output." }]);
});

test("DSH cleanup removes selected blocks directly from the active surface", () => {
	const session = dshSession();
	const files = new MemoryFiles();
	const options = bridgeOptions(String(session.id));
	const result = executeDshCleanup(session, [3], options, files);
	assert.equal(result.status, "applied");
	assert.deepEqual(result.requestedBlockIds, [3]);
	assert.deepEqual(result.removedBlockIds, [3]);
	assert.match(result.blockIndex ?? "", /\n1\. assistant: I inspected the repository/);
	assert.match(result.blockIndex ?? "", /\n2\. toolResult: Large output that can be omitted\./);
	assert.doesNotMatch(result.blockIndex ?? "", /Keep this later request/);
	assert.deepEqual(session.surface.nodes, [0, 1, 2, 3, 7]);
	assert.doesNotMatch(files.readText(options.mirrorPath) ?? "", /CLM_ENTRY id=3 role=user/);
	assert.match(files.readText(options.mirrorPath) ?? "", /CLM_ENTRY id=1 role=assistant/);
	const omission = session.snapshotEvents().find((event) => event.type === "developer/message");
	assert.ok(omission);
	assert.equal((omission.data as any).turn, 1);
	assert.equal((omission.data as any).step, 1);

	const protectedResult = executeDshCleanup(session, [1], bridgeOptions(String(session.id)));
	assert.equal(protectedResult.status, "rejected");
	assert.match(protectedResult.reason, /block 1/i);
	assert.match(protectedResult.blockIndex ?? "", /\n2\. toolResult:/);
	const pairedResult = executeDshCleanup(session, [2], bridgeOptions(String(session.id)));
	assert.equal(pairedResult.status, "rejected");
	assert.match(pairedResult.reason, /block 1|paired/i);
});

test("DSH runtime-context snapshots are not editable blocks", () => {
	const session = dshSession("/workspace/runtime-context", "dsh-runtime-context");
	(session.append as (type: string, data: unknown, options: unknown) => unknown)("user/message", {
		id: "runtime-context-1",
		role: "user",
		source: { kind: "runtime-context", form: "snapshot", sections: [{ name: "oh-my-clm:block-index", text: "block index" }] },
		content: [{ type: "text", text: "Current runtime context.\n\n<oh-my-clm-block-index>\n1. assistant: not a real block\n</oh-my-clm-block-index>" }],
	}, { surfaceOp: { op: "append" } });
	const files = new MemoryFiles();
	const state: DshBridgeState = {};
	const options = bridgeOptions(String(session.id));
	const mirror = initialMirror(files, session, state);
	assert.doesNotMatch(mirror, /Current runtime context/);
	assert.doesNotMatch(mirror, /CLM_ENTRY id=4/);
	const index = renderDshBlockIndex(session, options);
	assert.match(index, /\n1\. assistant: I inspected the repository/);
	assert.match(index, /\n3\. user: Keep this later request\./);
	assert.doesNotMatch(index, /runtime context/i);
});

test("DSH replacements use the open step instead of the shadowed node's envelope", () => {
	const session = dshSession("/workspace/open-step", "dsh-open-step", undefined, [
		{ type: "turn/start", data: { turn: 1 } },
		{ type: "step/start", data: { step: 1 } },
		{ type: "step/end", data: { turn: 1, step: 1 } },
		{ type: "step/start", data: { step: 2 } },
	]);
	const files = new MemoryFiles();
	const options = bridgeOptions(String(session.id));
	const result = executeDshCleanup(session, [3], options, files);
	assert.equal(result.status, "applied");
	const omission = session.snapshotEvents().find((event) => event.type === "developer/message");
	assert.ok(omission);
	// The omitted user event had no turn/step envelope; the bridge must still
	// use the open turn 1/step 2 rather than a zero fallback.
	assert.equal((omission.data as any).turn, 1);
	assert.equal((omission.data as any).step, 2);

	const state: DshBridgeState = {};
	const mirror = initialMirror(files, session, state);
	files.writeText(
		options.mirrorPath,
		mirror.replace("I inspected the repository.\nread {\"path\":\"README.md\"}", "Short repository inspection."),
	);
	const second = reconcileDshMirror(state, session, files, options);
	assert.equal(second.status, "applied");
	const replacements = session.snapshotEvents().filter((event) => event.type === "developer/message");
	assert.equal(replacements.length, 3);
	for (const event of replacements) {
		assert.equal((event.data as any).turn, 1);
		assert.equal((event.data as any).step, 2);
	}
});

test("DSH refuses to mutate while no turn/step is open", () => {
	const lifecycleCases = [
		[
			{ type: "turn/start", data: { turn: 1 } },
			{ type: "step/start", data: { step: 1 } },
			{ type: "step/end", data: { turn: 1, step: 1 } },
		],
		[
			{ type: "turn/start", data: { turn: 1 } },
			{ type: "step/start", data: { step: 1 } },
			{ type: "turn/end", data: { turn: 1 } },
		],
		[],
	];
	for (const [index, lifecycle] of lifecycleCases.entries()) {
		const session = dshSession("/workspace/closed", `dsh-closed-${index}`, undefined, lifecycle);
		const files = new MemoryFiles();
		const state: DshBridgeState = {};
		const options = bridgeOptions(String(session.id));
		const mirror = initialMirror(files, session, state);
		files.writeText(
			options.mirrorPath,
			mirror.replace("I inspected the repository.\nread {\"path\":\"README.md\"}", "Short."),
		);
		const result = reconcileDshMirror(state, session, files, options);
		assert.equal(result.status, "rejected", `lifecycle ${index}`);
		assert.match(result.reason ?? "", /no open step/i, `lifecycle ${index}`);
		assert.equal(files.readText(options.mirrorPath), mirror, `lifecycle ${index}`);

		const cleanup = executeDshCleanup(session, [3], options);
		assert.equal(cleanup.status, "rejected", `lifecycle ${index}`);
		assert.match(cleanup.reason, /no open step/i, `lifecycle ${index}`);
		assert.equal(session.snapshotEvents().some((event) => event.type === "developer/message"), false, `lifecycle ${index}`);
	}
});

test("DSH bridge restores the canonical mirror after an applied edit", () => {
	const files = new MemoryFiles();
	const session = dshSession();
	const state: DshBridgeState = {};
	const options = bridgeOptions(String(session.id));
	const mirror = initialMirror(files, session, state);
	const edited = mirror.replace("I inspected the repository.\nread {\"path\":\"README.md\"}", "Repository inspected.");
	files.writeText(options.mirrorPath, edited);

	const result = reconcileDshMirror(state, session, files, options);
	assert.equal(result.status, "applied");
	assert.notEqual(files.readText(options.mirrorPath), mirror);
	assert.doesNotMatch(files.readText(options.mirrorPath) ?? "", /Repository inspected/);
	assert.doesNotMatch(files.readText(options.mirrorPath) ?? "", /I inspected the repository/);
	assert.doesNotMatch(files.readText(options.mirrorPath) ?? "", /Large output that can be omitted/);
	const rewritten = session.snapshotEvents().find((event) =>
		event.type === "developer/message"
			&& (event.data as any).message?.content?.some((part: any) => part.text === "Repository inspected."),
	);
	assert.ok(rewritten);
	assert.deepEqual((rewritten as any).sourceEventSeqs, [2]);
	assert.equal([...files.files.keys()].some((filePath) => filePath.endsWith(".patch.json")), false);

	const canonical = files.readText(options.mirrorPath);
	const second = reconcileDshMirror(state, session, files, options);
	assert.equal(second.status, "noop");
	assert.equal(files.readText(options.mirrorPath), canonical);
});

test("DSH bridge restores the canonical mirror after a rejected edit", () => {
	const files = new MemoryFiles();
	const session = dshSession();
	const state: DshBridgeState = {};
	const options = bridgeOptions(String(session.id));
	const mirror = initialMirror(files, session, state);
	files.writeText(options.mirrorPath, mirror.replace("Keep this later request.", "Rewritten later request."));

	const result = reconcileDshMirror(state, session, files, options);
	assert.equal(result.status, "rejected");
	assert.match(result.reason ?? "", /user-authored/i);
	assert.equal(files.readText(options.mirrorPath), mirror);
	assert.equal([...files.files.keys()].some((filePath) => filePath.endsWith(".patch.json")), false);

	const second = reconcileDshMirror(state, session, files, options);
	assert.equal(second.status, "noop");
	assert.equal(files.readText(options.mirrorPath), mirror);
});

test("DSH sessions in the same cwd use separate artifact directories", () => {
	const files = new MemoryFiles();
	const cwd = "/workspace/shared";
	const first = dshSession(cwd, "dsh-first");
	const second = dshSession(cwd, "dsh-second");
	const firstState: DshBridgeState = {};
	const secondState: DshBridgeState = {};

	reconcileDshMirror(firstState, first, files, bridgeOptions(String(first.id)));
	reconcileDshMirror(secondState, second, files, bridgeOptions(String(second.id)));

	const firstPath = sessionMirrorPath(String(first.id));
	const secondPath = sessionMirrorPath(String(second.id));
	assert.notEqual(firstPath, secondPath);
	assert.ok(files.readText(firstPath));
	assert.ok(files.readText(secondPath));
});

test("DSH bridge rejects unknown, duplicate, stale, and role-mutated edits", () => {
	const cases = [
		{
			name: "unknown",
			mutate: (mirror: string) => `${mirror}\n[[CLM_ENTRY id=unknown role=user]]\nnope\n[[/CLM_ENTRY id=unknown]]\n`,
			pattern: /Unknown CLM_ENTRY ids/,
		},
		{
			name: "duplicate",
			mutate: (mirror: string) => `${mirror}\n[[CLM_ENTRY id=1 role=assistant]]\ncopy\n[[/CLM_ENTRY id=1]]\n`,
			pattern: /Duplicate CLM_ENTRY ids/,
		},
		{
			name: "role",
			mutate: (mirror: string) => mirror.replace("CLM_ENTRY id=1 role=assistant", "CLM_ENTRY id=1 role=user"),
			pattern: /role changed/,
		},
		{
			name: "stale",
			mutate: (mirror: string) => mirror.replace(/CLM_SNAPSHOT [a-f0-9]{16}/, "CLM_SNAPSHOT 0000000000000000"),
			pattern: /snapshot is stale/,
		},
	];

	for (const item of cases) {
		const files = new MemoryFiles();
		const session = dshSession();
		const state: DshBridgeState = {};
		const mirror = initialMirror(files, session, state);
		files.writeText(bridgeOptions(String(session.id)).mirrorPath, item.mutate(mirror));
		const result = reconcileDshMirror(state, session, files, bridgeOptions(String(session.id)));
		assert.equal(result.status, "rejected", item.name);
		assert.match(result.reason ?? "", item.pattern, item.name);
		assert.equal([...files.files.keys()].some((filePath) => filePath.endsWith(".patch.json")), false, item.name);
	}
});

interface ListenerContext {
	tools: {
		definitions: Map<string, any>;
		register(definition: any): () => void;
	};
	systemPrompt: {
		section(section: { name: string; order: number; text: string }): () => void;
		context(context: { name: string; order: number; text: string | ((context: { agent?: any }) => string) }): () => void;
		getSectionOrder(name: string): number;
	};
	sections: Array<{ name: string; order: number; text: string }>;
	contexts: Array<{ name: string; order: number; text: string | ((context: { agent?: any }) => string) }>;
	listeners: Map<string, Array<(...args: any[]) => any>>;
	on(name: string, listener: (...args: any[]) => any): () => void;
	effect(effect: () => unknown): void;
	emit(name: string, ...args: any[]): Promise<unknown[]>;
}

function listenerContext(): ListenerContext {
	const listeners = new Map<string, Array<(...args: any[]) => any>>();
	const sections: Array<{ name: string; order: number; text: string }> = [];
	const contexts: Array<{ name: string; order: number; text: string | ((context: { agent?: any }) => string) }> = [];
	const definitions = new Map<string, any>();
	return {
		tools: {
			definitions,
			register(definition: any) {
				definitions.set(definition.name, definition);
				return () => definitions.delete(definition.name);
			},
		},
		systemPrompt: {
			section: (section) => {
				sections.push(section);
				return () => undefined;
			},
			context: (contextValue) => {
				contexts.push(contextValue);
				return () => undefined;
			},
			getSectionOrder: () => 3240,
		},
		sections,
		contexts,
		listeners,
		on(name, listener) {
			const list = listeners.get(name) ?? [];
			list.push(listener);
			listeners.set(name, list);
			return () => undefined;
		},
		effect: () => undefined,
		async emit(name, ...args) {
			return Promise.all((listeners.get(name) ?? []).map((listener) => listener(...args)));
		},
	};
}

test("mock DSH host loads the entry, registers hooks, and mutates the active surface", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-dsh-host-"));
	const root = listenerContext();
	const agentContext = listenerContext();
	const logs: string[] = [];
	dshHost({
		...root,
		logger: { info: (message: string) => logs.push(message), warn: (message: string) => logs.push(message) },
	} as any);
	assert.equal(root.listeners.has("agent/created"), true);
	assert.equal(root.listeners.has("session/event"), true);
	assert.equal(root.sections[0]?.name, "oh-my-clm:live-context");
	assert.match(root.sections[0]?.text ?? "", /cleanup\(\{ blockIds:/);
	assert.match(root.sections[0]?.text ?? "", /Session\.append\(\).*surface-replacement seam/);
	assert.match(root.sections[0]?.text ?? "", /oh-my-clm-block-index/);
	assert.equal(root.contexts[0]?.name, "oh-my-clm:block-index");
	assert.equal(root.contexts[0]?.order, 200);
	assert.equal(root.tools.definitions.has("cleanup"), true);
	assert.equal(root.tools.definitions.get("cleanup")?.name, "cleanup");
	const cleanupTool = root.tools.definitions.get("cleanup");
	const toolSession = dshSession(cwd, "dsh-host-tool");
	const toolResult = await cleanupTool.execute({ blockIds: [3] }, { agent: { session: toolSession } });
	assert.equal(toolResult.status, "applied");
	assert.deepEqual(toolSession.surface.nodes, [0, 1, 2, 3, 7]);
	assert.match(root.sections[0]?.text ?? "", /\/tmp\/clm-<session-id>\/LIVE_CTX_MAIN\.md/);
	assert.equal(root.listeners.has("agent/disposed"), true);

	const session = dshSession(cwd, "dsh-host-native");
	const agent = { id: "agent-1", session, ctx: agentContext };
	await root.emit("agent/created", { agent });
	const indexText = root.contexts[0]?.text;
	assert.equal(typeof indexText, "function");
	const index = typeof indexText === "function" ? indexText({ agent }) : "";
	assert.match(index, /<oh-my-clm-block-index>/);
	assert.match(index, /\n1\. assistant: I inspected the repository/);
	assert.match(index, /\n2\. toolResult: Large output/);
	assert.match(index, /\n3\. user: Keep this later request\./);
	const next = () => Promise.resolve({ kind: "enter", messages: [] });
	await agentContext.emit("agent/pre-step", { agent, turn: 1, step: 1, messages: [], signal: new AbortController().signal }, next);
	const mirrorPath = sessionMirrorPath(String(session.id));
	assert.equal(fs.existsSync(path.join(cwd, ".pi", "clm", "LIVE_CTX_MAIN.md")), false);
	assert.ok(fs.existsSync(mirrorPath));
	if (process.platform !== "win32") {
		assert.equal(fs.statSync(path.dirname(mirrorPath)).mode & 0o777, 0o700);
		assert.equal(fs.statSync(mirrorPath).mode & 0o777, 0o600);
	}
	const mirror = fs.readFileSync(mirrorPath, "utf8");
	fs.writeFileSync(mirrorPath, mirror.replace("I inspected the repository.\nread {\"path\":\"README.md\"}", "Short repository inspection."), "utf8");
	await agentContext.emit("agent/pre-step", { agent, turn: 1, step: 2, messages: [], signal: new AbortController().signal }, next);
		assert.match(logs.join("\n"), /applied through Session\.append/);
	assert.deepEqual(session.surface.nodes, [0, 1, 7, 8, 4]);
	assert.equal(fs.readdirSync(path.dirname(mirrorPath)).some((name) => name.includes(".patch.")), false);
	fs.rmSync(path.dirname(mirrorPath), { recursive: true, force: true });
});

test("DSH defers mirror mutation until session event publication has settled", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-dsh-race-"));
	const root = listenerContext();
	const agentContext = listenerContext();
	const logs: string[] = [];
	let session: DshSessionLike;
	session = dshSession(cwd, "dsh-host-race", (event) => {
		void root.emit("session/event", session, event);
	});
	dshHost({
		...root,
		logger: { info: (message: string) => logs.push(message), warn: (message: string) => logs.push(message) },
	} as any);
	const agent = { id: String(session.id), session, ctx: agentContext };
	const next = () => Promise.resolve({ kind: "enter", messages: [] });
	const mirrorPath = sessionMirrorPath(String(session.id));
	try {
		await root.emit("agent/created", { agent });
		await agentContext.emit("agent/pre-step", { agent, turn: 1, step: 1, messages: [], signal: new AbortController().signal }, next);
		const mirror = fs.readFileSync(mirrorPath, "utf8");
		const edited = mirror.replace("I inspected the repository.\nread {\"path\":\"README.md\"}", "Short repository inspection.");
		fs.writeFileSync(mirrorPath, edited, "utf8");

		session.append("tool/result", {
			message: {
				id: "tool-5",
				role: "tool",
				source: { kind: "tool", callId: "call-2" },
				toolCallId: "call-2",
				content: [{ type: "text", text: "Fresh tool output after the edit." }],
			},
		}, { surfaceOp: { op: "append" } } as any);
		// The file edit is still visible immediately after append returns; the
		// bridge must not have tried to rewrite it from inside session/event.
		assert.equal(fs.readFileSync(mirrorPath, "utf8"), edited);

		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(session.snapshotEvents().length, 10);
		assert.deepEqual(session.surface.nodes, [0, 1, 8, 9, 4, 7]);
		assert.ok(logs.some((message) => message.includes("applied through Session.append surface replacement")));
		assert.equal(logs.some((message) => message.includes("reentrant Session.append")), false);
		const canonical = fs.readFileSync(mirrorPath, "utf8");
		assert.doesNotMatch(canonical, /Short repository inspection\./);
		assert.doesNotMatch(canonical, /I inspected the repository/);
		assert.match(canonical, /Fresh tool output after the edit\./);
	} finally {
		fs.rmSync(path.dirname(mirrorPath), { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("DSH defers a pending edit until step/start opens the next step", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-dsh-defer-"));
	const root = listenerContext();
	const agentContext = listenerContext();
	const logs: string[] = [];
	let session: TestSession;
	session = dshSession(cwd, "dsh-host-defer", (event) => {
		void root.emit("session/event", session, event);
	});
	dshHost({
		...root,
		logger: { info: (message: string) => logs.push(message), warn: (message: string) => logs.push(message) },
	} as any);
	const agent = { id: String(session.id), session, ctx: agentContext };
	const next = () => Promise.resolve({ kind: "enter", messages: [] });
	const mirrorPath = sessionMirrorPath(String(session.id));
	try {
		await root.emit("agent/created", { agent });
		// The default lifecycle has turn 1/step 1 open, so the first pre-step
		// converges the mirror without mutating the surface.
		await agentContext.emit("agent/pre-step", { agent, turn: 1, step: 1, messages: [], signal: new AbortController().signal }, next);
		assert.ok(fs.existsSync(mirrorPath));

		session.record("step/end", { turn: 1, step: 1 });
		const mirror = fs.readFileSync(mirrorPath, "utf8");
		const edited = mirror.replace("I inspected the repository.\nread {\"path\":\"README.md\"}", "Short repository inspection.");
		fs.writeFileSync(mirrorPath, edited, "utf8");

		// agent/pre-step runs before step/start: it must not mutate while the
		// previous step is closed, and it must leave the pending edit intact.
		await agentContext.emit("agent/pre-step", { agent, turn: 1, step: 2, messages: [], signal: new AbortController().signal }, next);
		assert.equal(fs.readFileSync(mirrorPath, "utf8"), edited);
		assert.equal(session.snapshotEvents().some((event) => event.type === "developer/message"), false);

		// step/start is published after pre-step; the queued bridge pass now
		// applies the edit with the newly opened coordinates.
		session.record("step/start", { turn: 1, step: 2 });
		await new Promise<void>((resolve) => setImmediate(resolve));
		const applied = session.snapshotEvents().filter((event) => event.type === "developer/message");
		assert.equal(applied.length, 2);
		for (const event of applied) {
			assert.equal((event.data as any).turn, 1);
			assert.equal((event.data as any).step, 2);
		}
		assert.ok(logs.some((message) => message.includes("applied through Session.append surface replacement")));
		const canonical = fs.readFileSync(mirrorPath, "utf8");
		assert.doesNotMatch(canonical, /Short repository inspection\./);
		assert.doesNotMatch(canonical, /I inspected the repository/);
	} finally {
		fs.rmSync(path.dirname(mirrorPath), { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
