import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply as dshHost } from "../../../dsh/index.ts";
// Test-only import: the plugin bundle must not load a second copy of this host
// package (its tool scheduler is keyed by a module-level Symbol), but the test
// needs the host's real output validator to reproduce INVALID_TOOL_OUTPUT.
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { sessionMirrorPath } from "../../../src/lib/clm-paths.ts";
import {
	buildDshMirrorRecords,
	dshBlockIndexText,
	executeDshCleanup,
	reconcileDshMirror,
	renderDshBlockIndex,
	type DshBridgeState,
	type DshFileSystem,
	type DshSessionLike,
} from "../../../src/features/live-context/dsh-bridge.ts";
import { renderMirror } from "../../../src/features/live-context/context-format.ts";
import { formatCleanupToolResult } from "../../../src/features/live-context/context-cleanup.ts";

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

function bridgeOptions(sessionId = "dsh-session-1", cleanupResult?: "compact" | "full" | "none") {
	return {
		mirrorPath: sessionMirrorPath(sessionId),
		...(cleanupResult ? { cleanupResult } : {}),
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
	state.blockIndex = { turn: 1, closedSteps: 1, text: "stale index" };
	const result = reconcileDshMirror(state, session, files, bridgeOptions(String(session.id)));
	assert.equal(result.status, "applied");
	// An applied mirror edit renumbers IDs and must clear the cached index.
	assert.equal(state.blockIndex, undefined);
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
	// Default copy is compact: the refreshed index is already re-rendered in
	// each step's runtime context, so the result carries only the confirmation.
	assert.equal(result.blockIndex, undefined);
	assert.match(formatCleanupToolResult(result), /^cleanup applied; removed 1 block\(s\): 3\.$/);
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
	assert.equal(protectedResult.blockIndex, undefined);
	const pairedResult = executeDshCleanup(session, [2], bridgeOptions(String(session.id)));
	assert.equal(pairedResult.status, "rejected");
	assert.match(pairedResult.reason, /block 1|paired/i);
});

test("DSH cleanup list returns rows and leaves the surface and mirror untouched", () => {
	const session = dshSession();
	const files = new MemoryFiles();
	const options = bridgeOptions(String(session.id));
	const before = [...session.surface.nodes];
	const listed = executeDshCleanup(
		session,
		{ blockIds: [], explicitIds: [], rangedIds: [], skipRoles: [], offload: [], list: { start: 1, end: 3 } },
		options,
		files,
	);
	assert.equal(listed.status, "listed");
	assert.deepEqual(listed.removedBlockIds, []);
	assert.match(listed.rows ?? "", /^<oh-my-clm-block-list>\nRead-only rows for IDs 1-3; nothing was removed\.\n/);
	assert.match(listed.rows ?? "", /\n1\. assistant: I inspected the repository/);
	assert.match(listed.rows ?? "", /\n3\. user: Keep this later request\./);
	assert.deepEqual(session.surface.nodes, before);
	// A listing answers from the projection, so it does not even create the mirror.
	assert.equal(files.readText(options.mirrorPath), undefined);
	assert.equal(formatCleanupToolResult(listed, "none"), listed.rows);
});

test("DSH cleanup result copy is compact by default with opt-in full and none", () => {
	const compactSession = dshSession();
	const compact = executeDshCleanup(compactSession, [3], bridgeOptions(String(compactSession.id)));
	assert.equal(compact.status, "applied");
	assert.equal(compact.copy, "compact");
	assert.equal(compact.blockIndex, undefined);
	assert.doesNotMatch(formatCleanupToolResult(compact), /\n1\. assistant/);

	const fullSession = dshSession();
	const full = executeDshCleanup(fullSession, [3], {
		...bridgeOptions(String(fullSession.id)),
		cleanupResult: "full",
	});
	assert.equal(full.status, "applied");
	assert.equal(full.copy, "full");
	assert.match(full.blockIndex ?? "", /\n1\. assistant: I inspected the repository/);
	assert.match(full.blockIndex ?? "", /\n2\. toolResult: Large output that can be omitted\./);
	assert.doesNotMatch(full.blockIndex ?? "", /Keep this later request/);
	assert.match(formatCleanupToolResult(full), /removed 1 block\(s\): 3\.[\s\S]*\n1\. assistant/);

	const noneSession = dshSession();
	const none = executeDshCleanup(noneSession, [3], {
		...bridgeOptions(String(noneSession.id)),
		cleanupResult: "none",
	});
	assert.equal(none.status, "applied");
	assert.equal(none.copy, "none");
	assert.equal(formatCleanupToolResult(none), "");

	// Rejections follow the same copy mode.
	const rejected = executeDshCleanup(dshSession(), [1], {
		...bridgeOptions("reject-full"),
		cleanupResult: "full",
	});
	assert.equal(rejected.status, "rejected");
	assert.match(rejected.blockIndex ?? "", /I inspected the repository/);
	assert.match(formatCleanupToolResult(rejected), /cleanup rejected;[\s\S]*block 1/);
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

test("DSH block index honors the compact host options", () => {
	const session = dshSession("/workspace/index-options", "dsh-index-options");
	const options = {
		...bridgeOptions(String(session.id)),
		blockIndex: { maxPreviewChars: 24, headBlocks: 1, tailBlocks: 1 },
	};
	const index = renderDshBlockIndex(session, options);
	assert.match(index, /\n1\. assistant: I inspected the repo/);
	// The tail window keeps the newest block; the gap between is named.
	assert.match(index, /\n3\. user: Keep this later request\./);
	assert.doesNotMatch(index, /\n2\. toolResult:/);
	assert.match(index, /\.\.\. 1 editable block\(s\) omitted \(ID 2\)\./);
});

test("DSH block index refreshes every N steps and invalidates after cleanup", () => {
	// Production timing: DSH renders the runtime context at agent/pre-step,
	// before the upcoming step/start is appended and after the previous
	// step/end. The fixture therefore has no open step when the index renders,
	// which is exactly the case the old turn/step cache key could not match.
	const session = dshSession("/workspace/index-throttle", "dsh-index-throttle", undefined, [
		{ type: "turn/start", data: { turn: 1 } },
	]);
	const options = bridgeOptions(String(session.id));
	const state: DshBridgeState = {};
	const appendUser = (id: string, text: string) =>
		(session.append as (type: string, data: unknown, options: unknown) => unknown)("user/message", {
			id,
			role: "user",
			source: { kind: "user" },
			content: [{ type: "text", text }],
		}, { surfaceOp: { op: "append" } });

	const first = dshBlockIndexText(session, options, state, 4);
	appendUser("user-cache-1", "New block within the window");
	// Appending never renumbers listed IDs, so the same text stays valid.
	assert.equal(dshBlockIndexText(session, options, state, 4), first);
	assert.doesNotMatch(first, /New block within the window/);

	// Steps 1-3 close inside the window; the cached text stays in use.
	for (let step = 1; step <= 3; step += 1) {
		session.record("step/end", { turn: 1, step });
		assert.equal(dshBlockIndexText(session, options, state, 4), first);
	}

	// Step 4 closes: four completed steps have accumulated, so it re-renders.
	session.record("step/end", { turn: 1, step: 4 });
	const refreshed = dshBlockIndexText(session, options, state, 4);
	assert.notEqual(refreshed, first);
	assert.match(refreshed, /New block within the window/);

	// A new turn always refreshes even when the step window has not elapsed.
	session.record("step/end", { turn: 1, step: 5 });
	assert.equal(dshBlockIndexText(session, options, state, 4), refreshed);
	session.record("turn/end", { turn: 1 });
	session.record("turn/start", { turn: 2 });
	appendUser("user-cache-2", "A new turn starts");
	const turnTwo = dshBlockIndexText(session, options, state, 4);
	assert.notEqual(turnTwo, refreshed);
	assert.match(turnTwo, /A new turn starts/);

	// Removal renumbers IDs, so an applied cleanup must force a fresh render.
	// The mutation itself needs an open turn/step, which DSH opens after pre-step.
	session.record("step/start", { turn: 2, step: 6 });
	// Block 1 is load-bearing for cleanup, so remove block 3 (the later user turn).
	const cleanup = executeDshCleanup(session, [3], options, undefined, state);
	assert.equal(cleanup.status, "applied", cleanup.reason);
	assert.equal(state.blockIndex, undefined);
	const afterCleanup = dshBlockIndexText(session, options, state, 4);
	assert.notEqual(afterCleanup, turnTwo);
	assert.doesNotMatch(afterCleanup, /Keep this later request/);
	assert.match(afterCleanup, /New block within the window/);
	assert.match(afterCleanup, /\n1\. assistant: I inspected the repository/);
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
	assert.equal(
		(rewritten as any).data?.message?.source?.kind,
		"oh-my-clm:model-mirror-edit",
		"a model mirror edit must be persisted with its planner provenance, not a user source",
	);
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
	commands: {
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
	const commandDefinitions = new Map<string, any>();
	return {
		tools: {
			definitions,
			register(definition: any) {
				definitions.set(definition.name, definition);
				return () => definitions.delete(definition.name);
			},
		},
		commands: {
			definitions: commandDefinitions,
			register(definition: any) {
				commandDefinitions.set(definition.name, definition);
				return () => commandDefinitions.delete(definition.name);
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

test("DSH cleanup tool value passes the declared output schema", async () => {
	const root = listenerContext();
	dshHost({ ...root } as any);
	const tool = root.tools.definitions.get("cleanup");
	assert.ok(tool?.output?.schema);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-dsh-output-"));
	const previous = process.env.CLM_CLEANUP_RESULT;
	const run = async (id: string) => {
		const session = dshSession(cwd, id);
		const args = { blockIds: [3] };
		const value = await tool.execute(args, { agent: { session } });
		return { value, rendered: tool.output.render(args, value) };
	};
	try {
		// DSH validates the returned value against output.schema (which declares
		// additionalProperties: false) before rendering. Host-only rendering state
		// such as the copy mode must not ride along, or every call fails with
		// ToolOutputError(INVALID_TOOL_OUTPUT).
		delete process.env.CLM_CLEANUP_RESULT;
		const compact = await run("dsh-output-tool");
		assert.deepEqual(validateJsonSchemaValue(tool.output.schema, compact.value, "value"), []);
		assert.deepEqual(compact.rendered, [{ type: "text", text: "cleanup applied; removed 1 block(s): 3." }]);

		process.env.CLM_CLEANUP_RESULT = "none";
		const silent = await run("dsh-output-tool-none");
		assert.deepEqual(validateJsonSchemaValue(tool.output.schema, silent.value, "value"), []);
		assert.deepEqual(silent.rendered, [{ type: "text", text: "" }]);

		process.env.CLM_CLEANUP_RESULT = "full";
		const full = await run("dsh-output-tool-full");
		assert.deepEqual(validateJsonSchemaValue(tool.output.schema, full.value, "value"), []);
		const fullText = full.rendered[0]?.text ?? "";
		assert.match(fullText, /^cleanup applied; removed 1 block\(s\): 3\.\n\n<oh-my-clm-block-index>/);

		// A read-only listing is a distinct status with its own payload, and it
		// must pass the same declared schema.
		delete process.env.CLM_CLEANUP_RESULT;
		const listSession = dshSession(cwd, "dsh-output-tool-list");
		const listArgs = { list: "1-3" };
		const listed = await tool.execute(listArgs, { agent: { session: listSession } });
		assert.equal(listed.status, "listed");
		assert.deepEqual(validateJsonSchemaValue(tool.output.schema, listed, "value"), []);
		const listedText = tool.output.render(listArgs, listed)[0]?.text ?? "";
		assert.match(listedText, /^<oh-my-clm-block-list>\nRead-only rows for IDs 1-3; nothing was removed\./);
		assert.deepEqual(listSession.surface.nodes, [0, 1, 2, 3, 4]);
	} finally {
		if (previous === undefined) delete process.env.CLM_CLEANUP_RESULT;
		else process.env.CLM_CLEANUP_RESULT = previous;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// docs/plan.md §5.1 / case 10 (red): the DSH static prompt must state *when*
// to clean (an explicit trigger condition), must not end by telling the model
// that nothing is required, and must stay inside the standing-tax budget.
// Today it only says *how* to clean and closes with "Nothing else is required
// of you.", so these assertions are expected to fail until §5.1 is implemented.
test("plan §5.1 (case 10, DSH): static prompt states when to clean within the length budget", () => {
	const root = listenerContext();
	dshHost({ ...root } as any);
	const promptSection = root.sections[0]?.text ?? "";
	assert.doesNotMatch(
		promptSection,
		/Nothing else is required of you/i,
		"DSH prompt must not dissuade the model from cleaning (§5.1)",
	);
	assert.match(
		promptSection,
		/(?:sub-question|subtask|子任务|收到清理候选|cleanup candidate|complet\w+ (?:a )?(?:sub)?task|at .{0,24}boundar\w*|(?:when|once|after) .{0,80}cleanup)/i,
		"DSH prompt must carry an explicit cleanup trigger condition (§5.1)",
	);
	assert.ok(promptSection.length <= 800, `live-context prompt grew to ${promptSection.length} chars`);
});

// docs/plan.md §5.2 / case 11 (red): the dynamic context must show usage with a
// percentage, and only a fired threshold may assemble a confirmation-shaped
// cleanup candidate. Candidates must stay inside the editable range and must
// never include block 1, and the payload is frozen at the turn boundary so it
// cannot append a fresh snapshot on every step.
test("plan §5.2 (case 11): usage line and cleanup candidates follow host usage and thresholds", async () => {
	const envKeys = [
		"CLM_TRIGGER_PCT",
		"CLM_TRIGGER_TURNS",
		"CLM_TRIGGER_TOOL_RATIO",
		"CLM_TRIGGER_SINCE",
		"CLM_CACHE_DISCOUNT",
		"CLM_CACHE_PAYBACK_TURNS",
	] as const;
	const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
	for (const key of envKeys) delete process.env[key];
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-trigger-"));
	let tokensUsed = 6_400;
	const projections = {
		snapshot() {
			return {
				values: {
					// Billing totals are cumulative for the whole session. They must
					// not reach the gate: as occupancy they read 300%+ on a 1M window
					// and rejected every cleanup, however much it removed.
					tokenUsage: { cacheReadTokens: 3_375_000, uncachedInputTokens: 0 },
					contextPressure: { contextWindow: 8_000, pressureTokens: tokensUsed },
				},
			};
		},
	};
	const append = (session: TestSession, type: string, data: unknown) =>
		(session.append as (type: string, data: unknown, options: unknown) => unknown)(type, data, { surfaceOp: { op: "append" } });
	// One completed turn plus the provider-visible block index: the completed
	// units are the run 1-2 (block 1, not suggestible) and the turn 3-5.
	const seedSecondTurn = (session: TestSession): void => {
		append(session, "assistant/message", {
			turn: 1,
			step: 1,
			stream: [],
			message: {
				id: "assistant-trigger",
				role: "assistant",
				source: { kind: "model", provider: "test", model: "test" },
				content: [
					{ type: "text", text: "I grepped the second area." },
					{ type: "tool-call", id: "call-trigger", name: "grep", arguments: "{}" },
				],
			},
		});
		append(session, "tool/result", {
			message: {
				id: "tool-trigger",
				role: "tool",
				source: { kind: "tool", callId: "call-trigger" },
				toolCallId: "call-trigger",
				content: [{ type: "text", text: `Settled second-area output that can be omitted. ${"Q".repeat(20_000)}` }],
			},
		});
		append(session, "user/message", {
			id: "user-trigger",
			role: "user",
			source: { kind: "user" },
			content: [{ type: "text", text: "Third request." }],
		});
	};
	const contextFor = async (root: ListenerContext, session: TestSession) => {
		const agent = { id: `agent-${String(session.id)}`, session, ctx: listenerContext() };
		await root.emit("agent/created", { agent });
		const text = root.contexts[0]?.text;
		assert.equal(typeof text, "function");
		return () => (typeof text === "function" ? text({ agent }) : "");
	};
	try {
		// Defaults are off: the usage line is visible, no candidate is produced.
		const quiet = listenerContext();
		dshHost({ ...quiet, sessionProjections: projections } as any);
		const quietSession = dshSession(cwd, "dsh-52-off");
		seedSecondTurn(quietSession);
		const quietRender = await contextFor(quiet, quietSession);
		assert.match(quietRender(), /Usage: 6\.4k\/8k tokens \(80%\) · 6 editable blocks · no cleanup yet/);
		assert.doesNotMatch(quietRender(), /Suggested cleanup/);

		// A fired usage threshold produces one legal, ready-to-confirm candidate.
		process.env.CLM_TRIGGER_PCT = "70";
		const root = listenerContext();
		dshHost({ ...root, sessionProjections: projections } as any);
		const session = dshSession(cwd, "dsh-52-hit");
		seedSecondTurn(session);
		const render = await contextFor(root, session);
		const triggered = render();
		assert.match(triggered, /Usage: 6\.4k\/8k tokens \(80%\)/);
		assert.match(
			triggered,
			/Suggested cleanup \(usage 80% ≥ 70%\): cleanup\(\{ ranges: \["3-5"\], skipRoles: \["user"\] \}\) frees ~\d+ tok\./,
		);
		assert.match(triggered, /3-5 \(~\d+ tok freed, 1 turn old, \d+ tok after the break, net ~\d+\); block 1, user messages, and the current turn stay\./);
		// The suggested call must keep the human's request inside its own range:
		// a bare range would delete the user block that starts the turn.
		const userBlock = buildDshMirrorRecords(session, bridgeOptions(String(session.id)))
			.filter((record) => !record.protected && record.role === "user");
		assert.ok(userBlock.length > 0, "the seeded window has a user block to preserve");
		// Candidates live inside the same block index the model already reads.
		const indexBody = /<oh-my-clm-block-index>([\s\S]*)<\/oh-my-clm-block-index>/.exec(triggered)?.[1] ?? "";
		assert.match(indexBody, /Suggested cleanup/);
		const ranges = [...indexBody.matchAll(/"(\d+)(?:-(\d+))?"/g)].map((match) => ({
			start: Number(match[1]),
			end: Number(match[2] ?? match[1]),
		}));
		assert.ok(ranges.length > 0, "the trigger must name concrete ranges");
		const editable = buildDshMirrorRecords(session, bridgeOptions(String(session.id))).filter((record) => !record.protected).length;
		for (const range of ranges) {
			assert.ok(range.start >= 2, `block 1 must never be a candidate: ${range.start}`);
			assert.ok(range.start <= range.end && range.end <= editable, `candidate ${range.start}-${range.end} is outside 2-${editable}`);
		}

		// The payload is frozen at the turn boundary: host usage growing inside
		// the same turn must not change one byte of the runtime context.
		tokensUsed = 7_600;
		assert.equal(render(), triggered);
		// A new turn refreshes it with the new host usage.
		session.record("turn/end", { turn: 1 });
		session.record("turn/start", { turn: 2 });
		const nextTurn = render();
		assert.notEqual(nextTurn, triggered);
		assert.match(nextTurn, /Usage: 7\.6k\/8k tokens \(95%\)/);

		// A threshold that is not hit yields the usage line but no candidate.
		process.env.CLM_TRIGGER_PCT = "95";
		tokensUsed = 6_400;
		const cold = listenerContext();
		dshHost({ ...cold, sessionProjections: projections } as any);
		const coldSession = dshSession(cwd, "dsh-52-miss");
		seedSecondTurn(coldSession);
		const coldRender = await contextFor(cold, coldSession);
		assert.match(coldRender(), /Usage: 6\.4k\/8k tokens \(80%\)/);
		assert.doesNotMatch(coldRender(), /Suggested cleanup/);

		// Without the host projection service the estimate is labelled `~`.
		delete process.env.CLM_TRIGGER_PCT;
		const bare = listenerContext();
		dshHost({ ...bare } as any);
		const bareSession = dshSession(cwd, "dsh-52-estimate");
		seedSecondTurn(bareSession);
		const bareRender = await contextFor(bare, bareSession);
		assert.match(bareRender(), /Usage: ~\d+(?:\.\d+)?k? tokens \(window unknown\)/);
		assert.doesNotMatch(bareRender(), /Suggested cleanup/);
	} finally {
		for (const key of envKeys) {
			const value = previousEnv.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		for (const id of ["dsh-52-off", "dsh-52-hit", "dsh-52-miss", "dsh-52-estimate"]) {
			fs.rmSync(path.dirname(sessionMirrorPath(id)), { recursive: true, force: true });
		}
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

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
	const promptSection = root.sections[0]?.text ?? "";
	assert.match(promptSection, /oh-my-clm-block-index/);
	assert.match(promptSection, /cleanup/);
	// A tool-call rewrite drops its paired result, so the fact belongs in that body.
	assert.match(promptSection, /also omits its tool result/);
	// The mirror path and its editability are in scope because the mirror is the
	// compression interface. The schema still owns the API, and bridge internals
	// and env switches stay out of model-visible text.
	assert.match(promptSection, /\/tmp\/clm-<session-id>\/LIVE_CTX_MAIN\.md/);
	assert.doesNotMatch(promptSection, /blockIds|skipRoles|CLM_CLEANUP_RESULT|CLM_INDEX_|CLM_MAX_|Session\.append|sourceEventSeqs/);
	assert.ok(promptSection.length <= 800, `live-context prompt grew to ${promptSection.length} chars`);
	assert.equal(root.contexts[0]?.name, "oh-my-clm:block-index");
	assert.equal(root.contexts[0]?.order, 200);
	assert.equal(root.tools.definitions.has("cleanup"), true);
	assert.equal(root.tools.definitions.get("cleanup")?.name, "cleanup");
	const cleanupTool = root.tools.definitions.get("cleanup");
	const toolSession = dshSession(cwd, "dsh-host-tool");
	const toolResult = await cleanupTool.execute({ blockIds: [3] }, { agent: { session: toolSession } });
	assert.equal(toolResult.status, "applied");
	assert.deepEqual(toolSession.surface.nodes, [0, 1, 2, 3, 7]);
	assert.equal(root.listeners.has("agent/disposed"), true);

	const session = dshSession(cwd, "dsh-host-native");
	const agent = { id: "agent-1", session, ctx: agentContext };
	await root.emit("agent/created", { agent });
	const indexText = root.contexts[0]?.text;
	assert.equal(typeof indexText, "function");
	const index = typeof indexText === "function" ? indexText({ agent }) : "";
	assert.match(index, /<oh-my-clm-block-index>/);
	// The section can only name the `<session-id>` template; the dynamic context
	// must resolve it so the model has a path it can actually use.
	assert.ok(index.startsWith(`Mirror: ${sessionMirrorPath(String(session.id))}\n`), index.slice(0, 160));
	// The production default is the turn digest: one closed run plus the anchor.
	assert.match(index, /\n1-2\. assistant\+toolResult ×2 \(\d+ tok\)/);
	assert.match(index, /\nIDs 3\.\. \(current turn, not listed\): Keep this later request\./);
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

test("DSH host caches the block index across steps and invalidates on compaction", async () => {
	// This covers the blocks-mode text, which changes on every appended block.
	// The digest default is covered by the turn-digest tests.
	const previousMode = process.env.CLM_INDEX_MODE;
	process.env.CLM_INDEX_MODE = "blocks";
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-index-cache-"));
	const root = listenerContext();
	const agentContext = listenerContext();
	dshHost({ ...root } as any);
	const session = dshSession(cwd, "dsh-index-cache");
	// agent.id deliberately differs from session.id: the cache is session-scoped.
	const agent = { id: "agent-index-cache", session, ctx: agentContext };
	const appendUser = (id: string, text: string) =>
		(session.append as (type: string, data: unknown, options: unknown) => unknown)("user/message", {
			id,
			role: "user",
			source: { kind: "user" },
			content: [{ type: "text", text }],
		}, { surfaceOp: { op: "append" } });
	try {
		await root.emit("agent/created", { agent });
		const text = root.contexts[0]?.text as (context: { agent: unknown }) => string;
		const first = text({ agent });

		appendUser("user-cache-1", "New block within the window");
		assert.equal(text({ agent }), first);
		assert.doesNotMatch(first, /New block within the window/);

		// Production timing has no open step when the index renders; a single
		// completed step is inside the window and must keep the cached text.
		session.record("step/end", { turn: 1, step: 1 });
		session.record("step/start", { turn: 1, step: 2 });
		assert.equal(text({ agent }), first);
		// Four completed steps reach the refresh window.
		for (let step = 2; step <= 4; step += 1) session.record("step/end", { turn: 1, step });
		const refreshed = text({ agent });
		assert.notEqual(refreshed, first);
		assert.match(refreshed, /New block within the window/);

		appendUser("user-cache-2", "Post compaction block");
		assert.doesNotMatch(text({ agent }), /Post compaction block/);
		await root.emit("session/event", session, { seq: 999, type: "compaction/summary", data: {} });
		assert.match(text({ agent }), /Post compaction block/);
	} finally {
		if (previousMode === undefined) delete process.env.CLM_INDEX_MODE;
		else process.env.CLM_INDEX_MODE = previousMode;
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(path.dirname(sessionMirrorPath(String(session.id))), { recursive: true, force: true });
	}
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

test("DSH reads contextPressure occupancy from sessionProjections and labels the fallback", async () => {
	const root = listenerContext();
	const snapshotKeys: Array<readonly string[] | undefined> = [];
	const projections = {
		snapshot(_session: unknown, keys?: readonly string[]) {
			snapshotKeys.push(keys);
			return {
				asOfSeq: 12,
				values: {
					// Cumulative billed prompt tokens for the session: 3.3M on a 10k
					// window. Reading these as occupancy reported 322% and deadlocked
					// the shrink gate; only contextPressure is occupancy.
					tokenUsage: {
						uncachedInputTokens: 3_370_000,
						outputTokens: 120,
						cacheReadTokens: 5_000,
						cacheWriteTokens: 0,
					},
					contextPressure: { contextWindow: 10_000, pressureTokens: 9_000, projectedTokens: 9_800 },
				},
			};
		},
	};
	dshHost({ ...root, sessionProjections: projections } as any);
	const command = root.commands.definitions.get("clm");
	assert.ok(command, "/clm was not registered");
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-dsh-host-usage-"));
	const sessionId = `dsh-host-usage-${process.pid}-${Date.now()}`;
	const mirrorPath = sessionMirrorPath(sessionId);
	const session = dshSession(cwd, sessionId);
	const invocation = {
		agent: { id: sessionId, session },
		commandId: "command-1",
		rawInput: "status",
		attachments: [],
		signal: new AbortController().signal,
	};
	try {
		const status = await command.handler(invocation);
		assert.equal(status.kind, "success", status.text);
		assert.match(status.text, /DSH projectedTokens: 9800\/10000 tokens \(contextPressure/);
		assert.ok(snapshotKeys.some((keys) => keys?.includes("contextPressure")));
		assert.ok(
			snapshotKeys.every((keys) => !keys || !keys.includes("tokenUsage")),
			"the cumulative tokenUsage totals must never be read as occupancy",
		);

		// Without the projection service the fallback must be visibly labelled,
		// never passed off as an exact value (P1-2 / docs/plan.md §5.2).
		const bare = listenerContext();
		dshHost({ ...bare } as any);
		const fallback = await bare.commands.definitions.get("clm").handler(invocation);
		assert.equal(fallback.kind, "success", fallback.text);
		assert.match(fallback.text, /DSH projectedTokens: unavailable; the shrink gate falls back to the ~ estimate/);
	} finally {
		fs.rmSync(path.dirname(mirrorPath), { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("DSH reads sessionProjections through ctx.get, not an undeclared property", async () => {
	// Reproduce Cordis: an undeclared service read on the context proxy throws
	// `cannot get property "<name>" without inject`, while `ctx.get(name)` is the
	// supported inject-free path. A direct property read here stranded `/clm
	// status` on `could not render status` and silently emptied the runtime
	// block index (both call sites share this read).
	const root = listenerContext();
	const projections = {
		snapshot() {
			return {
				asOfSeq: 12,
				values: {
					tokenUsage: { uncachedInputTokens: 3_000_000, cacheReadTokens: 9_000_000 },
					contextPressure: { contextWindow: 10_000, projectedTokens: 9_800 },
				},
			};
		},
	};
	const readKeys: string[] = [];
	const cordisLike = new Proxy(
		{
			...root,
			get(name: string) {
				readKeys.push(name);
				return name === "sessionProjections" ? projections : undefined;
			},
		},
		{
			get(target, prop, receiver) {
				if (prop === "sessionProjections") {
					throw new Error(`cannot get property "${String(prop)}" without inject`);
				}
				return Reflect.get(target, prop, receiver);
			},
		},
	);
	dshHost(cordisLike as any);
	const command = root.commands.definitions.get("clm");
	assert.ok(command, "/clm was not registered");
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-dsh-inject-free-"));
	const sessionId = `dsh-inject-free-${process.pid}-${Date.now()}`;
	const mirrorPath = sessionMirrorPath(sessionId);
	const session = dshSession(cwd, sessionId);
	const invocation = {
		agent: { id: sessionId, session },
		commandId: "command-1",
		rawInput: "status",
		attachments: [],
		signal: new AbortController().signal,
	};
	try {
		const status = await command.handler(invocation);
		assert.equal(status.kind, "success", status.text);
		assert.match(status.text, /DSH projectedTokens: 9800\/10000 tokens \(contextPressure/);
		assert.ok(readKeys.includes("sessionProjections"), "usage must be read through ctx.get");

		// The same read path feeds the runtime block index, so it must still render.
		const agent = { id: `agent-${sessionId}`, session, ctx: listenerContext() };
		await root.emit("agent/created", { agent });
		const renderText = root.contexts[0]?.text;
		if (typeof renderText !== "function") throw new Error("block index context is not dynamic");
		assert.match(renderText({ agent }), /Usage: 9\.8k\/10k tokens \(98%\)/);
	} finally {
		fs.rmSync(path.dirname(mirrorPath), { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("DSH /clm command reports the live mirror status and validates arguments", async () => {
	const root = listenerContext();
	dshHost({ ...root } as any);
	const command = root.commands.definitions.get("clm");
	assert.ok(command, "/clm was not registered");
	assert.equal(command.name, "clm");
	assert.equal(command.description, "Show the oh-my-clm live context status or switch the index mode");

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-dsh-clm-command-"));
	const sessionId = `dsh-clm-command-${process.pid}-${Date.now()}`;
	const mirrorPath = sessionMirrorPath(sessionId);
	const session = dshSession(cwd, sessionId);
	const invocation = (rawInput: string) => ({
		agent: { id: sessionId, session },
		commandId: "command-1",
		rawInput,
		attachments: [],
		signal: new AbortController().signal,
	});
	try {
		const missing = await command.handler(invocation(""));
		assert.equal(missing.kind, "success", missing.text);
		assert.match(missing.text, /^oh-my-clm status \(DSH\)/);
		assert.ok(missing.text.includes(`mirror: ${mirrorPath}`), missing.text);
		assert.match(missing.text, /mirror state: missing \(written on the next bridge pass\)/);
		assert.match(missing.text, /editable blocks: 3/);
		assert.match(missing.text, /protected blocks: 1/);
		assert.match(missing.text, /canonical editable: ~\d+ tokens/);
		assert.match(missing.text, /DSH surface nodes: 5/);
		assert.match(missing.text, /edit policy: shrink-only/);

		// The status compares the artifact byte-for-byte with the canonical
		// projection, so an untouched bridge-written mirror reports "in sync".
		fs.mkdirSync(path.dirname(mirrorPath), { recursive: true, mode: 0o700 });
		fs.writeFileSync(mirrorPath, renderMirror(buildDshMirrorRecords(session, { mirrorPath })), "utf8");
		const synced = await command.handler(invocation(" status "));
		assert.equal(synced.kind, "success", synced.text);
		assert.match(synced.text, /mirror state: in sync/);

		const rejected = await command.handler(invocation("refresh"));
		assert.equal(rejected.kind, "error");
		assert.match(rejected.text, /Usage: \/clm \[status \| mode/);
	} finally {
		fs.rmSync(path.dirname(mirrorPath), { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("DSH digest index collapses a turn and stays byte-stable while it grows", () => {
	const session = dshSession("/workspace/index-digest", "dsh-index-digest");
	// user/message carries the message as its own data; tool/result nests it.
	const append = (type: string, message: unknown) =>
		(session.append as (type: string, data: unknown, options: unknown) => unknown)(
			type,
			type === "user/message" ? message : { message },
			{ surfaceOp: { op: "append" } },
		);
	const options = { ...bridgeOptions(String(session.id)), indexMode: "digest" as const };
	const first = renderDshBlockIndex(session, options);
	assert.match(first, /\n1-2\. assistant\+toolResult ×2 \(\d+ tok\): I inspected the repository/);
	assert.match(first, /\nIDs 3\.\. \(current turn, not listed\): Keep this later request\./);
	assert.doesNotMatch(first, /omitted/);

	// A tool result appended inside the growing turn belongs to the live run,
	// whose line is an anchor only, so the runtime-context text must not change.
	append("tool/result", {
		id: "tool-live",
		role: "toolResult",
		content: [{ type: "text", text: "live output" }],
		toolCallId: "call-live",
		source: { kind: "tool" },
	});
	assert.equal(renderDshBlockIndex(session, options), first);

	// A new user message closes the previous turn, which is the one point where
	// the digest has to be re-rendered.
	append("user/message", {
		id: "user-next",
		role: "user",
		content: [{ type: "text", text: "Next turn" }],
		source: { kind: "user" },
	});
	const next = renderDshBlockIndex(session, options);
	assert.notEqual(next, first);
	assert.match(next, /\n3-4\. turn ×2 \(\d+ tok\): user \(\d+ tok\) \+ 1 noise: Keep this later request\./);
	assert.match(next, /\nIDs 5\.\. \(current turn, not listed\): Next turn/);
});

test("DSH digest mode renders turn ranges and the cleanup tool accepts a range", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-digest-mode-"));
	const root = listenerContext();
	const agentContext = listenerContext();
	dshHost({ ...root } as any);
	const session = dshSession(cwd, "dsh-digest-mode");
	const agent = { id: "agent-digest-mode", session, ctx: agentContext };
	const previous = process.env.CLM_INDEX_MODE;
	process.env.CLM_INDEX_MODE = "digest";
	try {
		await root.emit("agent/created", { agent });
		const text = root.contexts[0]?.text as (context: { agent: unknown }) => string;
		const digest = text({ agent });
		assert.match(digest, /\n1-2\. assistant\+toolResult ×2 \(\d+ tok\)/);
		assert.match(digest, /\nIDs 3\.\. \(current turn, not listed\)/);
		// The production options path (not a per-test option object) selected it.
		const status = root.commands.definitions.get("clm");
		const response = status.handler({ agent, rawInput: "status" });
		assert.match(response.text, /block index: digest/);

		const tool = root.tools.definitions.get("cleanup");
		const output = await tool.execute({ ranges: ["3-3"] }, { agent });
		assert.equal(output.status, "applied");
		assert.deepEqual(output.requestedBlockIds, [3]);
		assert.deepEqual(output.removedBlockIds, [3]);
		assert.deepEqual(output.pairedRemovalIds, []);
	} finally {
		if (previous === undefined) delete process.env.CLM_INDEX_MODE;
		else process.env.CLM_INDEX_MODE = previous;
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(path.dirname(sessionMirrorPath(String(session.id))), { recursive: true, force: true });
	}
});

test("DSH /clm mode switches the index shape live and clears the cached preview", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-dsh-clm-mode-"));
	const root = listenerContext();
	const agentContext = listenerContext();
	dshHost({ ...root } as any);
	const session = dshSession(cwd, `dsh-clm-mode-${process.pid}-${Date.now()}`);
	const agent = { id: `${String(session.id)}-agent`, session, ctx: agentContext };
	const command = root.commands.definitions.get("clm");
	const invocation = (rawInput: string) => ({ agent, commandId: "command-mode", rawInput, attachments: [], signal: new AbortController().signal });
	try {
		await root.emit("agent/created", { agent });
		const text = root.contexts[0]?.text as (context: { agent: unknown }) => string;
		// The process default is the turn digest; render once so it is cached.
		assert.match(text({ agent }), /\n1-2\. assistant\+toolResult ×2 \(\d+ tok\)/);

		const switched = await command.handler(invocation("mode blocks"));
		assert.equal(switched.kind, "success", switched.text);
		assert.match(text({ agent }), /\n1\. assistant: I inspected the repository/);

		const status = await command.handler(invocation("status"));
		assert.match(status.text, /block index: blocks/);
		const current = await command.handler(invocation("mode"));
		assert.match(current.text, /index mode: blocks/);

		const back = await command.handler(invocation("mode digest"));
		assert.equal(back.kind, "success", back.text);
		assert.match(text({ agent }), /\n1-2\. assistant\+toolResult ×2 \(\d+ tok\)/);

		const invalid = await command.handler(invocation("mode compact"));
		assert.equal(invalid.kind, "error");
		const auto = await command.handler(invocation("mode auto"));
		assert.equal(auto.kind, "success", auto.text);
		// Without CLM_INDEX_MODE the process default is the digest.
		assert.match(text({ agent }), /\n1-2\. assistant\+toolResult ×2/);
	} finally {
		// The override is module state: reset it so later tests see the default.
		await command.handler(invocation("mode auto"));
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(path.dirname(sessionMirrorPath(String(session.id))), { recursive: true, force: true });
	}
});

// docs/plan.md §3 case 4b / P1-3: the source field is owned by the runtime, so a
// model-driven replacement must not be attributed to a human user. Assert the
// exact planner-derived kind: `notEqual(..., "user")` alone passed when the
// source was missing entirely, and did not prove provenance reached the event.
test("plan §3.4b (P1-3): DSH cleanup replacements carry the runtime provenance", () => {
	const session = dshSession();
	const files = new MemoryFiles();
	const options = bridgeOptions(String(session.id));
	const result = executeDshCleanup(session, [3], options, files);
	assert.equal(result.status, "applied");
	const mutations = session.snapshotEvents().filter((event) => event.type === "developer/message");
	assert.ok(mutations.length > 0);
	for (const mutation of mutations) {
		assert.equal(
			(mutation.data as any).message?.source?.kind,
			"oh-my-clm:runtime-cleanup",
			"a cleanup replacement must record which runtime planner produced it",
		);
	}
});

// docs/plan.md §5.4 / case 13: DSH lands an offload as an in-place content
// replacement, so the node keeps its address and the surface does not shrink
// by a node even though its text does.
test("plan §5.4 (case 13, DSH): offload replaces content instead of omitting the node", () => {
	const session = dshSession();
	const files = new MemoryFiles();
	const options = bridgeOptions(String(session.id));
	const before = [...session.surface.nodes];
	const result = executeDshCleanup(
		session,
		{ blockIds: [], explicitIds: [], rangedIds: [], skipRoles: [], offload: [{ blockId: 2, note: "README read." }] },
		options,
		files,
	);
	assert.equal(result.status, "applied");
	assert.deepEqual(result.removedBlockIds, []);
	assert.deepEqual(result.offloadedBlockIds, [2]);
	// DSH is append-only: the surface slot keeps a tool/result node, but the node
	// itself is a new event. The block count and its ordinal are what stay fixed.
	assert.equal(session.surface.nodes.length, before.length);
	const replacedSeq = session.surface.nodes[before.indexOf(3)];
	const replaced = session.snapshotEvents().find((event) => event.seq === replacedSeq);
	assert.equal(replaced?.type, "tool/result");
	const replacement = session.snapshotEvents().find((event) => event.type === "tool/result" && event.seq > 6);
	assert.ok(replacement);
	assert.deepEqual((replacement.data as any).message.content, [{ type: "text", text: "[offloaded: README read.]" }]);
	const mirror = files.readText(options.mirrorPath) ?? "";
	assert.match(mirror, /\[\[CLM_ENTRY id=2 role=toolResult\]\]\n\[offloaded: README read\.\]\n\[\[\/CLM_ENTRY id=2\]\]/);
	assert.match(mirror, /CLM_ENTRY id=1 role=assistant/);
	assert.match(formatCleanupToolResult(result), /^cleanup applied; offloaded 1 block\(s\): 2\.$/);
});
