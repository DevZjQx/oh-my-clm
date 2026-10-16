import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

function user(content: string): Record<string, unknown> {
	return { role: "user", content, timestamp: Date.now() };
}

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
