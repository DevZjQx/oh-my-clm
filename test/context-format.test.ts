import assert from "node:assert/strict";
import test from "node:test";
import { estimateMessageTokens as piEstimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
	buildMirrorRecords,
	estimateMessageTokens,
	estimateMirrorTokens,
	estimateTokens,
	mirrorSignature,
	parseMirror,
	planContextEdits,
	renderBlockIndex,
	renderMirror,
	type MirrorRecord,
} from "../src/context-format.ts";

const records: MirrorRecord[] = [
	{
		id: "task",
		role: "user",
		text: "Build a context editor.",
		protected: true,
		toolCallIds: [],
	},
	{
		id: "assistant-1",
		role: "assistant",
		text: "I inspected the repository and found a small TypeScript project.",
		protected: false,
		toolCallIds: ["call-1"],
	},
	{
		id: "tool-1",
		role: "toolResult",
		text: "A very large command output that is no longer useful.",
		protected: false,
		toolCallIds: [],
		toolCallId: "call-1",
	},
	{
		id: "user-2",
		role: "user",
		text: "Keep the important repository fact.",
		protected: false,
		toolCallIds: [],
	},
];

test("token estimates follow Pi's per-message structured estimator", () => {
	const projected = buildMirrorRecords([
		{
			sourceEntry: { id: "one", type: "message" },
			messages: [{ role: "user", content: "a" }],
		},
		{
			sourceEntry: { id: "two", type: "message" },
			messages: [{ role: "assistant", content: [{ type: "text", text: "b" }] }],
		},
		{
			sourceEntry: { id: "three", type: "message" },
			messages: [{ role: "toolResult", content: [{ type: "text", text: "c" }], toolCallId: "call-1" }],
		},
		{
			sourceEntry: { id: "four", type: "message" },
			messages: [{ role: "user", content: "d" }],
		},
	]);

	// Pi rounds each message independently using its 3.5 chars/token
	// approximation. The old aggregate chars/4 estimator incorrectly returned
	// one token for this projection.
	assert.equal(estimateMirrorTokens(projected), 4);
	assert.equal(estimateTokens(["a", "b", "c", "d"]), 4);

	const edited = renderMirror(projected).replace(/\n\n\[\[CLM_ENTRY id=3 role=user\]\][\s\S]*$/, "\n");
	const plan = planContextEdits(projected, parseMirror(edited), { allowGrowth: false });
	assert.equal(plan.status, "applied");
	assert.equal(plan.beforeTokens, 4);
	assert.equal(plan.afterTokens, 3);
});

test("structured image content uses Pi's image estimate", () => {
	const projected = buildMirrorRecords([
		{
			sourceEntry: { id: "task", type: "message" },
			messages: [{ role: "user", content: "Task" }],
		},
		{
			sourceEntry: { id: "image", type: "message" },
			messages: [{ role: "toolResult", content: [{ type: "image", mimeType: "image/png", data: "ignored" }], toolCallId: "call-1" }],
		},
	]);

	// Pi's estimator reserves 4,800 characters for an image, then applies its
	// 3.5 chars/token approximation per message.
	assert.equal(estimateMirrorTokens(projected), 1_374);
});

test("shared estimator matches the current Pi host for supported message shapes", () => {
	const messages: readonly unknown[] = [
		{ role: "user", content: "a".repeat(42) },
		{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "ignored" }] },
		{ role: "assistant", content: [{ type: "text", text: "a".repeat(42) }] },
		{ role: "assistant", content: [{ type: "thinking", thinking: "a".repeat(42) }] },
		{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }] },
		{ role: "assistant", content: [{ type: "tool-call", id: "call-2", name: "read", arguments: '{"path":"README.md"}' }] },
		{ role: "toolResult", content: [{ type: "text", text: "a".repeat(42) }], toolCallId: "call-1" },
		{
			role: "system",
			content: "a".repeat(10),
			sections: { live: "b".repeat(20) },
			toolsAdded: [{ name: "read", description: "Read", parameters: { type: "object" } }],
			toolsRemoved: [{ name: "old" }],
		},
	];

	for (const message of messages) {
		assert.equal(
			estimateMessageTokens(message),
			piEstimateMessageTokens(message as any),
			JSON.stringify(message),
		);
	}
});

test("DSH-specific message shapes use the shared approximation fallback", () => {
	// These shapes are intentionally outside Pi's Message estimator contract;
	// the shared layer keeps them loadable for the optional DSH bridge.
	assert.equal(estimateMessageTokens({ role: "assistant", content: [{ type: "reasoning", text: "reason" }] }), 2);
	assert.equal(estimateMessageTokens({ role: "custom", content: "custom" }), 2);
	assert.equal(estimateMessageTokens({ role: "bashExecution", command: "echo x", output: "ok" }), 3);
	assert.equal(estimateMessageTokens({ role: "compactionSummary", summary: "summary" }), 2);
	assert.equal(estimateMessageTokens({ role: "tool", content: [{ type: "text", text: "result" }], toolCallId: "call-1" }), 2);
});

test("render and parse preserve stable editable entry ids", () => {
	const mirror = renderMirror(records);
	assert.match(mirror, /CLM_ENTRY id=1 role=assistant/);
	assert.doesNotMatch(mirror, /CLM_ENTRY id=task/);
	const parsed = parseMirror(mirror);
	assert.equal(parsed.recognized, true);
	assert.equal(parsed.blocks.get("1")?.body, records[1]?.text);
	assert.equal(planContextEdits(records, parsed).status, "noop");
});

test("rewriting an assistant tool turn removes the paired tool result", () => {
	const mirror = renderMirror(records);
	const edited = mirror
		.replace("I inspected the repository and found a small TypeScript project.", "The repository is small and TypeScript-based.")
		.replace(/\n\n\[\[CLM_ENTRY id=2 role=toolResult\]\][\s\S]*?(?=\n\n\[\[CLM_ENTRY|\n$)/, "\n");
	const plan = planContextEdits(records, parseMirror(edited), { allowGrowth: false });
	assert.equal(plan.status, "applied");
	assert.ok(plan.edits.some((edit) => edit.targetId === "assistant-1" && edit.replacement));
	assert.ok(plan.edits.some((edit) => edit.targetId === "tool-1" && edit.replacement === null));
	assert.ok(plan.afterTokens < plan.beforeTokens);
});

test("deleting a stale block is a shrinking edit", () => {
	const mirror = renderMirror(records);
	const edited = mirror.replace(/\n\n\[\[CLM_ENTRY id=3 role=user\]\][\s\S]*$/, "\n");
	const plan = planContextEdits(records, parseMirror(edited), { allowGrowth: false });
	assert.equal(plan.status, "applied");
	assert.deepEqual(plan.omittedIds, ["user-2"]);
});

test("fit gate rejects an edit over the configured budget", () => {
	const mirror = renderMirror(records);
	const edited = mirror.replace("Keep the important repository fact.", "A much longer replacement that should not fit in the tiny configured budget.");
	const plan = planContextEdits(records, parseMirror(edited), { allowGrowth: true, budgetTokens: 4, allowUserReplacement: true });
	assert.equal(plan.status, "rejected");
	assert.match(plan.reason ?? "", /FIT/);
});

test("a damaged file without headers is rejected instead of deleting context", () => {
	const plan = planContextEdits(records, parseMirror("replace everything"));
	assert.equal(plan.status, "rejected");
	assert.match(plan.reason ?? "", /header/);
});

test("compaction summaries release the old protected-prefix rule", () => {
	const projected = buildMirrorRecords([
		{
			sourceEntry: { id: "compaction", type: "compaction" },
			messages: [{ role: "compactionSummary", summary: "Earlier work" }],
		},
		{
			sourceEntry: { id: "later-user", type: "message" },
			messages: [{ role: "user", content: "A later request" }],
		},
		{
			sourceEntry: { id: "later-assistant", type: "message" },
			messages: [{ role: "assistant", content: [{ type: "text", text: "A later answer" }] }],
		},
	]);
	assert.equal(projected.every((record) => !record.protected), true);
	assert.notEqual(mirrorSignature(projected), "");
});

test("block bodies may contain header-like text without creating duplicate blocks", () => {
	const nested = records.map((record) =>
		record.id === "tool-1"
			? { ...record, text: "Captured output:\n[[CLM_ENTRY id=fake role=user]]\nnot a real block" }
			: record,
	);
	const parsed = parseMirror(renderMirror(nested));
	assert.equal(parsed.recognized, true);
	assert.equal(parsed.duplicateIds.length, 0);
	assert.equal(parsed.blocks.get("2")?.body, nested[2]?.text);
});

test("an explicit empty mirror omits every editable record", () => {
	const rendered = renderMirror(records);
	const firstBlock = rendered.indexOf("\n\n[[CLM_ENTRY");
	const mirror = `${rendered.slice(0, firstBlock)}\n\n<!-- CLM_EMPTY -->\n`;
	const parsed = parseMirror(mirror);
	assert.equal(parsed.empty, true);
	const plan = planContextEdits(records, parsed);
	assert.equal(plan.status, "applied");
	assert.deepEqual(plan.omittedIds, ["assistant-1", "tool-1", "user-2"]);
});

test("unknown blocks reject the edit instead of deleting known context", () => {
	const mirror = renderMirror(records).replace(
		"<!-- The protected initial task is intentionally not shown here. -->",
		"<!-- The protected initial task is intentionally not shown here. -->\n\n[[CLM_ENTRY id=unknown role=user]]\nshould not be accepted\n[[/CLM_ENTRY id=unknown]]",
	);
	const plan = planContextEdits(records, parseMirror(mirror));
	assert.equal(plan.status, "rejected");
	assert.match(plan.reason ?? "", /unknown/i);
});

test("duplicate or role-mutated blocks are rejected as protocol errors", () => {
	const duplicate = renderMirror(records) + "\n[[CLM_ENTRY id=1 role=assistant]]\ncopy\n[[/CLM_ENTRY id=1]]\n";
	const duplicatePlan = planContextEdits(records, parseMirror(duplicate));
	assert.equal(duplicatePlan.status, "rejected");
	assert.match(duplicatePlan.reason ?? "", /Duplicate/i);

	const roleChanged = renderMirror(records).replace("CLM_ENTRY id=1 role=assistant", "CLM_ENTRY id=1 role=user");
	const rolePlan = planContextEdits(records, parseMirror(roleChanged));
	assert.equal(rolePlan.status, "rejected");
	assert.match(rolePlan.reason ?? "", /role/i);
});

test("user blocks cannot be rewritten unless the policy explicitly allows it", () => {
	const mirror = renderMirror(records).replace("Keep the important repository fact.", "A model-invented user requirement.");
	const plan = planContextEdits(records, parseMirror(mirror));
	assert.equal(plan.status, "rejected");
	assert.match(plan.reason ?? "", /user/i);
	const allowed = planContextEdits(records, parseMirror(mirror), { allowUserReplacement: true });
	assert.equal(allowed.status, "applied");
});

test("mirror previews are bounded without changing the canonical source text", () => {
	const entries = [
		{
			sourceEntry: { id: "task", type: "message" },
			messages: [{ role: "user", content: "Task" }],
		},
		{
			sourceEntry: { id: "tool", type: "message" },
			messages: [{ role: "toolResult", content: [{ type: "text", text: "x".repeat(500) }] }],
		},
	];
	const projected = buildMirrorRecords(entries, { maxBlockChars: 256, maxMirrorChars: 256 });
	assert.equal(projected[1]?.text.length, 500);
	assert.ok((projected[1]?.renderText?.length ?? 0) <= 256);
	const parsed = parseMirror(renderMirror(projected));
	assert.equal(planContextEdits(projected, parsed).status, "noop");
});

test("a stale snapshot is rejected before any omission is planned", () => {
	const mirror = renderMirror(records).replace(/CLM_SNAPSHOT [a-f0-9]{16}/, "CLM_SNAPSHOT 0000000000000000");
	const plan = planContextEdits(records, parseMirror(mirror));
	assert.equal(plan.status, "rejected");
	assert.match(plan.reason ?? "", /stale/i);
});

test("a self-referential tool result gets a compact mirror preview", () => {
	const projected = buildMirrorRecords([
		{
			sourceEntry: { id: "task", type: "message" },
			messages: [{ role: "user", content: "Task" }],
		},
		{
			sourceEntry: { id: "self", type: "message" },
			messages: [{ role: "toolResult", content: [{ type: "text", text: "<!-- pi-clm-v2 -->\\n[[CLM_ENTRY id=old role=assistant]]" }] }],
		},
	], { mirrorPath: "/tmp/clm-test-session/LIVE_CTX_MAIN.md" });
	assert.match(projected[1]?.renderText ?? "", /Self-referential/);
	assert.equal(projected[1]?.text.includes("CLM_ENTRY"), true);
});

test("block index exposes the same 1-based IDs as the mirror without protected blocks", () => {
	const index = renderBlockIndex(records);
	assert.match(index, /^<oh-my-clm-block-index>/);
	assert.match(index, /\n1\. assistant: I inspected the repository/);
	assert.match(index, /\n2\. toolResult: A very large command output/);
	assert.match(index, /\n3\. user: Keep the important repository fact\./);
	assert.doesNotMatch(index, /Build a context editor\./);
	assert.match(index, /cleanup\(\{ blockIds:/);
	assert.match(index, /Block 1 is load-bearing/);
});

test("block index previews are single-line and bounded", () => {
	const record: MirrorRecord = {
		id: "long",
		role: "toolResult",
		text: "line one\nline two\t" + "x".repeat(400),
		protected: false,
		toolCallIds: [],
	};
	const index = renderBlockIndex([record], { maxPreviewChars: 32 });
	assert.match(index, /\n1\. toolResult: line one line two/);
	const previewLine = index.split("\n").find((line) => line.startsWith("1. ")) ?? "";
	assert.ok(previewLine.length <= "1. toolResult: ".length + 33);
	assert.match(previewLine, /…$/);
});

test("the block index keeps the first and last 40 blocks and summarizes the middle", () => {
	const many: MirrorRecord[] = Array.from({ length: 120 }, (_, index) => ({
		id: `block-${index + 1}`,
		role: "assistant",
		text: `content ${index + 1}`,
		protected: false,
		toolCallIds: [],
	}));
	const index = renderBlockIndex(many, { maxPreviewChars: 32 });
	assert.match(index, /\n1\. assistant: content 1\n/);
	assert.match(index, /\n40\. assistant: content 40\n/);
	assert.doesNotMatch(index, /\n41\. assistant:/);
	assert.doesNotMatch(index, /\n80\. assistant:/);
	assert.match(index, /\.\.\. 40 editable block\(s\) omitted from this index \(IDs 41-80\)\./);
	assert.match(index, /\n81\. assistant: content 81\n/);
	assert.match(index, /\n120\. assistant: content 120\n/);
});

test("the block index is empty when every block is protected", () => {
	assert.equal(renderBlockIndex([records[0]!]), "");
});
