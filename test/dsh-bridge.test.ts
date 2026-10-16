import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply as dshHost } from "../dsh/index.ts";
import {
	DSH_MIRROR_RELATIVE_PATH,
	DSH_PATCH_RELATIVE_PATH,
	reconcileDshMirror,
	type DshBridgeState,
	type DshFileSystem,
	type DshSessionLike,
} from "../src/dsh-bridge.ts";

class MemoryFiles implements DshFileSystem {
	readonly files = new Map<string, string>();

	readText(filePath: string): string | undefined {
		return this.files.get(filePath);
	}

	writeText(filePath: string, content: string): void {
		this.files.set(filePath, content);
	}
}

function dshSession(cwd = "/workspace/oh-my-clm"): DshSessionLike {
	const events = [
		{
			seq: 0,
			type: "system/message",
			data: { message: { role: "system", content: [{ type: "text", text: "Harness prompt" }] } },
		},
		{
			seq: 1,
			type: "user/message",
			data: { role: "user", content: [{ type: "text", text: "Keep the repository task." }] },
		},
		{
			seq: 2,
			type: "assistant/message",
			data: {
				message: {
					role: "assistant",
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
					role: "tool",
					toolCallId: "call-1",
					content: [{ type: "text", text: "Large output that can be omitted." }],
				},
			},
		},
		{
			seq: 4,
			type: "user/message",
			data: { role: "user", content: [{ type: "text", text: "Keep this later request." }] },
		},
	];
	return {
		id: "dsh-session-1",
		header: { cwd },
		surface: { nodes: events.map((event) => event.seq) },
		snapshotEvents: () => events,
	};
}

function bridgeOptions() {
	return {
		mirrorPath: "/workspace/.pi/clm/LIVE_CTX_MAIN.md",
		patchPath: "/workspace/.pi/clm/LIVE_CTX_MAIN.patch.json",
		sessionId: "dsh-session-1",
		now: () => 123,
	};
}

function initialMirror(files: MemoryFiles, session: DshSessionLike, state: DshBridgeState): string {
	reconcileDshMirror(state, session, files, bridgeOptions());
	return files.readText(bridgeOptions().mirrorPath) ?? "";
}

test("DSH bridge mirrors the host surface and writes a paired explicit patch", () => {
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
	files.writeText(bridgeOptions().mirrorPath, edited);
	const result = reconcileDshMirror(state, session, files, bridgeOptions());
	assert.equal(result.status, "patch-written");
	assert.equal(result.patch?.status, "applied");
	assert.deepEqual(result.patch?.changedIds, ["dsh:2", "dsh:3"]);
	assert.ok(result.patch?.edits.some((edit) => edit.targetId === "dsh:2" && edit.action === "replace"));
	assert.ok(result.patch?.edits.some((edit) => edit.targetId === "dsh:3" && edit.action === "omit"));
	assert.equal(JSON.parse(files.readText(bridgeOptions().patchPath) ?? "{}").protocol, "oh-my-clm-dsh-patch-v1");
	// A proposal is deliberately not a session mutation.
	assert.deepEqual(session.surface.nodes, [0, 1, 2, 3, 4]);
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
		files.writeText(bridgeOptions().mirrorPath, item.mutate(mirror));
		const result = reconcileDshMirror(state, session, files, bridgeOptions());
		assert.equal(result.status, "rejected", item.name);
		assert.match(result.patch?.reason ?? "", item.pattern, item.name);
		assert.equal(JSON.parse(files.readText(bridgeOptions().patchPath) ?? "{}").status, "rejected", item.name);
	}
});

interface ListenerContext {
	systemPrompt: {
		section(section: { name: string; order: number; text: string }): () => void;
		getSectionOrder(name: string): number;
	};
	sections: Array<{ name: string; order: number; text: string }>;
	listeners: Map<string, Array<(...args: any[]) => any>>;
	on(name: string, listener: (...args: any[]) => any): () => void;
	effect(effect: () => unknown): void;
	emit(name: string, ...args: any[]): Promise<unknown[]>;
}

function listenerContext(): ListenerContext {
	const listeners = new Map<string, Array<(...args: any[]) => any>>();
	const sections: Array<{ name: string; order: number; text: string }> = [];
	return {
		systemPrompt: {
			section: (section) => {
				sections.push(section);
				return () => undefined;
			},
			getSectionOrder: () => 3240,
		},
		sections,
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

test("mock DSH host loads the entry, registers prompt/lifecycle hooks, and emits a patch", async () => {
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
	assert.match(root.sections[0]?.text ?? "", /explicit, auditable proposal/);
	assert.equal(root.listeners.has("agent/disposed"), true);

	const session = dshSession(cwd);
	const agent = { id: "agent-1", session, ctx: agentContext };
	await root.emit("agent/created", { agent });
	const next = () => Promise.resolve({ kind: "enter", messages: [] });
	await agentContext.emit("agent/pre-step", { agent, turn: 1, step: 1, messages: [], signal: new AbortController().signal }, next);
	const mirrorPath = path.join(cwd, DSH_MIRROR_RELATIVE_PATH);
	const patchPath = path.join(cwd, DSH_PATCH_RELATIVE_PATH);
	assert.ok(fs.existsSync(mirrorPath));
	const mirror = fs.readFileSync(mirrorPath, "utf8");
	fs.writeFileSync(mirrorPath, mirror.replace("Keep this later request.", "Short later request."), "utf8");
	await agentContext.emit("agent/pre-step", { agent, turn: 1, step: 2, messages: [], signal: new AbortController().signal }, next);
	assert.equal(JSON.parse(fs.readFileSync(patchPath, "utf8")).status, "rejected");
	assert.match(logs.join("\n"), /user-authored|user-authored|rejected/);
});
