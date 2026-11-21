import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../../extensions/clm.ts";

// The loader also reads a user-level config from the ambient home directory, and
// these tests turn the clearing channel on from their own project config. Pin
// that root before any test runs: the suite's outcome must not depend on the
// machine it runs on. (This is a file-location seam, not a plugin switch.)
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-user-config-"));

function user(content: string): Record<string, unknown> {
	return { role: "user", content, timestamp: Date.now() };
}

function toolResult(toolCallId: string, text: string): Record<string, unknown> {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function assistantWithToolCall(text: string, toolCallId: string, toolPath: string): Record<string, unknown> {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: toolPath } },
		],
		api: "test",
		provider: "test",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * The whole auto-clear contract on the real host seam: the extension's draft is
 * a `context_edit`, so applying it the way Pi does leaves the original event in
 * the session log, shows the pointer only in the active projection, and a
 * replayed boundary clears nothing again.
 */
test("Pi auto-clear replaces a superseded read in the projection and keeps the log's original", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-autoclear-"));
	// The channel ships off; this session turns it on where the loader looks.
	fs.writeFileSync(path.join(cwd, ".oh-my-clm.json"), JSON.stringify({ autoClear: { enabled: true } }), "utf8");
	const session = SessionManager.inMemory(cwd);
	const heavy = (fill: string) => `const data = "${fill.repeat(6000)}";`;
	const taskId = session.appendMessage(user("Keep the task constraints.") as any);
	const assistantId = session.appendMessage(assistantWithToolCall("Inspecting.", "call-1", "src/big.ts") as any);
	const firstResultId = session.appendMessage(toolResult("call-1", heavy("x")) as any);

	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	extension({
		on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
			handlers.set(name, handler);
			return () => undefined;
		},
		registerCommand: () => undefined,
		registerTool: () => undefined,
	} as any);
	const ctx = {
		cwd,
		hasUI: false,
		mode: "print",
		model: undefined,
		getContextUsage: () => ({ tokens: 4_000, contextWindow: 100_000, percent: 4 }),
		ui: { notify: () => undefined },
		sessionManager: session,
	};
	await handlers.get("session_start")?.({}, ctx);
	await handlers.get("context")?.({ messages: [] }, ctx);

	const firstAssistant = (session.getEntry(assistantId) as any).message;
	const firstResult = (session.getEntry(firstResultId) as any).message;
	await handlers.get("turn_end")?.({
		entries: [],
		turnIndex: 0,
		message: firstAssistant,
		toolResults: [firstResult],
		messageEntryId: assistantId,
		toolResultEntryIds: [firstResultId],
	}, ctx);

	const secondAssistantId = session.appendMessage(assistantWithToolCall("Reading again.", "call-2", "src/big.ts") as any);
	const secondResultId = session.appendMessage(toolResult("call-2", heavy("y")) as any);
	await handlers.get("context")?.({ messages: [] }, ctx);

	const original = (session.getEntry(firstResultId) as any).message;
	const secondAssistant = (session.getEntry(secondAssistantId) as any).message;
	const secondResult = (session.getEntry(secondResultId) as any).message;
	const result = await handlers.get("turn_end")?.({
		entries: [],
		turnIndex: 0,
		message: secondAssistant,
		toolResults: [secondResult],
		messageEntryId: secondAssistantId,
		toolResultEntryIds: [secondResultId],
	}, ctx) as { entries: Array<Record<string, unknown>> } | undefined;
	assert.ok(result, "the boundary returns entries");
	const edit = result.entries.find((entry) => entry.type === "context_edit" && entry.targetId === firstResultId);
	assert.ok(edit, "the superseded read result is cleared");
	assert.match((edit.replacement as { content: Array<{ text: string }> }).content[0]?.text ?? "", /^\[cleared /);

	session.appendContextEdit(firstResultId, edit.replacement as any);
	const stored = (session.getEntry(firstResultId) as any).message;
	assert.equal((stored.content as Array<{ text: string }>)[0]?.text, (original.content as Array<{ text: string }>)[0]?.text,
		"the session log keeps the original tool result");
	const projected = session.buildSessionProjection();
	const projectedMessage = projected.entries.find((entry: any) => entry.sourceEntry.id === firstResultId)?.messages[0] as any;
	assert.match((projectedMessage.content as Array<{ text: string }>)[0]?.text ?? "", /^\[cleared .* re-read before editing\]$/);
	assert.ok(projected.entries.some((entry: any) => entry.sourceEntry.id === taskId), "the task entry survives the clear");

	// Replaying the boundary without new traffic must not clear the block again.
	await handlers.get("context")?.({ messages: [] }, ctx);
	const replayed = await handlers.get("turn_end")?.({ entries: [] }, ctx) as { entries: Array<Record<string, unknown>> } | undefined;
	assert.equal((replayed?.entries ?? []).length, 0, "a replayed boundary clears nothing");
});

function assistant(text: string): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

test("Pi applies context edits to the active projection without changing raw history", () => {
	const session = SessionManager.inMemory("/tmp/oh-my-clm-integration");
	const taskId = session.appendMessage(user("Keep the task constraints.") as any);
	const assistantId = session.appendMessage(assistant("A long answer that can be compacted.") as any);
	const original = session.getEntry(assistantId) as any;

	session.appendContextEdit(assistantId, { content: [{ type: "text", text: "A compact answer." }] });
	const edited = session.buildSessionProjection();
	const editedMessage = edited.entries.find((entry) => entry.sourceEntry.id === assistantId)?.messages[0] as any;

	assert.equal((editedMessage.content as Array<{ text: string }>)[0]?.text, "A compact answer.");
	assert.equal(original.message.content[0].text, "A long answer that can be compacted.");
	assert.ok(edited.entries.some((entry) => entry.sourceEntry.id === taskId));
});

test("Pi branch navigation does not leak a context edit from another branch", () => {
	const session = SessionManager.inMemory("/tmp/oh-my-clm-branch");
	const taskId = session.appendMessage(user("Task") as any);
	const firstAssistantId = session.appendMessage(assistant("First branch answer") as any);
	session.appendContextEdit(firstAssistantId, { content: [{ type: "text", text: "Edited first answer" }] });

	session.branch(taskId);
	const secondAssistantId = session.appendMessage(assistant("Second branch answer") as any);
	const projection = session.buildSessionProjection();
	const visibleTexts = projection.messages.flatMap((message: any) =>
		Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "text").map((part: any) => part.text) : [message.content],
	);

	assert.ok(projection.entries.some((entry) => entry.sourceEntry.id === secondAssistantId));
	assert.equal(projection.entries.some((entry) => entry.sourceEntry.id === firstAssistantId), false);
	assert.equal(visibleTexts.includes("Edited first answer"), false);
});
