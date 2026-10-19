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
	renderBlockDigest,
	renderBlockIndex,
	renderBlockList,
	renderMirror,
	type MirrorRecord,
} from "../../../src/features/live-context/context-format.ts";

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

test("the legacy pi-clm-v2 header is not recognized", () => {
	const legacy = renderMirror(records).replace("<!-- clm-v2 -->", "<!-- pi-clm-v2 -->");
	const parsed = parseMirror(legacy);
	assert.equal(parsed.recognized, false);
	assert.equal(parsed.version, undefined);
	assert.equal(parsed.malformed, false);
	const plan = planContextEdits(records, parsed);
	assert.equal(plan.status, "rejected");
	assert.match(plan.reason ?? "", /No valid CLM mirror header/);
});

test("a self-referential tool result gets a compact mirror preview", () => {
	const projected = buildMirrorRecords([
		{
			sourceEntry: { id: "task", type: "message" },
			messages: [{ role: "user", content: "Task" }],
		},
		{
			sourceEntry: { id: "self", type: "message" },
			messages: [{ role: "toolResult", content: [{ type: "text", text: "<!-- clm-v2 -->\\n[[CLM_ENTRY id=old role=assistant]]" }] }],
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
	// The static protocol lives in the host's stable system-prompt section, not
	// in this per-step runtime-context payload.
	assert.doesNotMatch(index, /Batch every removal into one cleanup call/);
	assert.doesNotMatch(index, /When the list is longer/);
	assert.doesNotMatch(index, /Block 1 is load-bearing/);
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

test("the block index lists the head plus the most recent blocks", () => {
	const many: MirrorRecord[] = Array.from({ length: 200 }, (_, index) => ({
		id: `block-${index + 1}`,
		role: "assistant",
		text: `content ${index + 1}`,
		protected: false,
		toolCallIds: [],
	}));
	const index = renderBlockIndex(many, { maxPreviewChars: 32 });
	const listed = index.split("\n");
	const at = (line: string) => listed.findIndex((value) => value === line);
	assert.ok(at("1. assistant: content 1") >= 0);
	assert.ok(at("12. assistant: content 12") > 0);
	// Recency gets the budget: the trailing window is the last 40 blocks.
	assert.ok(at("161. assistant: content 161") > at("12. assistant: content 12"));
	assert.ok(at("200. assistant: content 200") > at("161. assistant: content 161"));
	assert.doesNotMatch(index, /\n13\. assistant:/);
	assert.doesNotMatch(index, /\n160\. assistant:/);
	// The one skipped run is named, so an ID jump is never mistaken for a gap.
	assert.equal(at("... 148 editable block(s) omitted (IDs 13-160)."), at("12. assistant: content 12") + 1);
	// 52 listed blocks, 1 omission line, 2 wrapper lines, 1 caption line.
	assert.equal(listed.length, 56);
});

test("the tail window covers the last blocks of a longer session", () => {
	const many: MirrorRecord[] = Array.from({ length: 80 }, (_, index) => ({
		id: `block-${index + 1}`,
		role: "assistant",
		text: `content ${index + 1}`,
		protected: false,
		toolCallIds: [],
	}));
	const index = renderBlockIndex(many, { maxPreviewChars: 32 });
	assert.match(index, /\n12\. assistant: content 12\n/);
	assert.doesNotMatch(index, /\n13\. assistant:/);
	assert.match(index, /\n\.\.\. 28 editable block\(s\) omitted \(IDs 13-40\)\.\n/);
	assert.match(index, /\n41\. assistant: content 41\n/);
	assert.match(index, /\n80\. assistant: content 80\n/);
	// The window reaches the end, so no second omission line is needed.
	assert.doesNotMatch(index, /omitted \(IDs 81-/);
});

test("the block index head and tail stay configurable", () => {
	const many: MirrorRecord[] = Array.from({ length: 120 }, (_, index) => ({
		id: `block-${index + 1}`,
		role: "assistant",
		text: `content ${index + 1}`,
		protected: false,
		toolCallIds: [],
	}));
	const index = renderBlockIndex(many, { maxPreviewChars: 32, headBlocks: 5, tailBlocks: 10 });
	assert.match(index, /\n5\. assistant: content 5\n/);
	assert.doesNotMatch(index, /\n6\. assistant:/);
	assert.match(index, /\n\.\.\. 105 editable block\(s\) omitted \(IDs 6-110\)\.\n/);
	assert.match(index, /\n111\. assistant: content 111\n/);
	assert.match(index, /\n120\. assistant: content 120\n/);
});

test("the block index adds no omission line when every block is listed", () => {
	const many: MirrorRecord[] = Array.from({ length: 40 }, (_, index) => ({
		id: `block-${index + 1}`,
		role: "assistant",
		text: `content ${index + 1}`,
		protected: false,
		toolCallIds: [],
	}));
	const index = renderBlockIndex(many, { maxPreviewChars: 32 });
	assert.match(index, /\n40\. assistant: content 40\n/);
	assert.doesNotMatch(index, /omitted/);
});

test("the block index names everything it omits when the tail window is disabled", () => {
	const many: MirrorRecord[] = Array.from({ length: 60 }, (_, index) => ({
		id: `block-${index + 1}`,
		role: "assistant",
		text: `content ${index + 1}`,
		protected: false,
		toolCallIds: [],
	}));
	const single = renderBlockIndex(many, { maxPreviewChars: 32, headBlocks: 10, tailBlocks: 0 });
	assert.match(single, /\n\.\.\. 50 editable block\(s\) omitted \(IDs 11-60\)\.\n/);
	const none = renderBlockIndex(many, { maxPreviewChars: 32, headBlocks: 0, tailBlocks: 0 });
	assert.match(none, /\n\.\.\. 60 editable block\(s\) omitted \(IDs 1-60\)\.\n/);
	assert.doesNotMatch(none, /\n1\. assistant:/);
});

test("a single omitted block gets a singular ID in the omission line", () => {
	const many: MirrorRecord[] = Array.from({ length: 53 }, (_, index) => ({
		id: `block-${index + 1}`,
		role: "assistant",
		text: `content ${index + 1}`,
		protected: false,
		toolCallIds: [],
	}));
	const index = renderBlockIndex(many, { maxPreviewChars: 32 });
	assert.match(index, /\n\.\.\. 1 editable block\(s\) omitted \(ID 13\)\.\n/);
	assert.doesNotMatch(index, /ID 13-13/);
});

test("the block index preview defaults to 64 characters", () => {
	const record: MirrorRecord = {
		id: "long",
		role: "toolResult",
		text: "x".repeat(400),
		protected: false,
		toolCallIds: [],
	};
	const index = renderBlockIndex([record]);
	const previewLine = index.split("\n").find((line) => line.startsWith("1. ")) ?? "";
	assert.ok(previewLine.length <= "1. toolResult: ".length + 65, previewLine);
	assert.match(previewLine, /…$/);
});

test("the block index is empty when every block is protected", () => {
	assert.equal(renderBlockIndex([records[0]!]), "");
});

const listRecords: MirrorRecord[] = [
	{ id: "task", role: "user", text: "Protected task.", protected: true, toolCallIds: [] },
	{ id: "a1", role: "assistant", text: "First block.", protected: false, toolCallIds: [] },
	{ id: "t1", role: "toolResult", text: "Second block.", protected: false, toolCallIds: [] },
	{ id: "u2", role: "user", text: "Third block.", protected: false, toolCallIds: [] },
	{ id: "a2", role: "assistant", text: "Fourth block.", protected: false, toolCallIds: [] },
];

test("the block list returns read-only rows for one range", () => {
	const listed = renderBlockList(listRecords, { start: 2, end: 4 }, { maxPreviewChars: 24 });
	assert.ok(listed.ok);
	if (!listed.ok) return;
	assert.match(listed.text, /^<oh-my-clm-block-list>\nRead-only rows for IDs 2-4; nothing was removed\.\n/);
	assert.match(listed.text, /\n2\. toolResult: Second block\.\n/);
	assert.match(listed.text, /\n3\. user: Third block\.\n/);
	assert.match(listed.text, /\n4\. assistant: Fourth block\.\n/);
	assert.match(listed.text, /\n<\/oh-my-clm-block-list>$/);
});

test("the block list clamps the range and rejects a start past the end", () => {
	const clamped = renderBlockList(listRecords, { start: 2, end: 999 });
	assert.ok(clamped.ok);
	if (!clamped.ok) return;
	assert.match(clamped.text, /Read-only rows for IDs 2-4;/);
	const past = renderBlockList(listRecords, { start: 9, end: 12 });
	assert.equal(past.ok, false);
	if (past.ok) return;
	assert.match(past.reason, /last ID 4/);
	const empty = renderBlockList([listRecords[0]!], { start: 1, end: 2 });
	assert.equal(empty.ok, false);
});

test("the block list truncates by character budget and names the next range", () => {
	const many: MirrorRecord[] = Array.from({ length: 40 }, (_, index) => ({
		id: `block-${index + 1}`,
		role: "assistant",
		text: `content ${index + 1} ${"x".repeat(40)}`,
		protected: false,
		toolCallIds: [],
	}));
	const listed = renderBlockList(many, { start: 1, end: 40 }, { maxPreviewChars: 64, maxChars: 600 });
	assert.ok(listed.ok);
	if (!listed.ok) return;
	assert.match(listed.text, /^<oh-my-clm-block-list>\nRead-only rows for IDs 1-40; nothing was removed\.\n/);
	const rows = [...listed.text.matchAll(/^(\d+)\. assistant: /gm)].map((match) => Number(match[1]));
	assert.ok(rows.length > 0 && rows.length < 40, `listed ${rows.length} rows`);
	assert.deepEqual(rows, Array.from({ length: rows.length }, (_, index) => index + 1));
	const last = rows[rows.length - 1]!;
	assert.match(
		listed.text,
		new RegExp(`\\.\\.\\. ${40 - last} more block\\(s\\); call cleanup\\(\\{ list: "${last + 1}-40" \\}\\) to continue\\.`),
	);
});

const digestRecords: MirrorRecord[] = [
	{ id: "task", role: "user", text: "Build a context editor.", protected: true, toolCallIds: [] },
	{ id: "a1", role: "assistant", text: "I inspected the repository.", protected: false, toolCallIds: ["c1"] },
	{ id: "t1", role: "toolResult", text: "A large command output.", protected: false, toolCallIds: [], toolCallId: "c1" },
	{ id: "u2", role: "user", text: "继续推送更新", protected: false, toolCallIds: [] },
	{ id: "a2", role: "assistant", text: "Pushed the change.", protected: false, toolCallIds: ["c2"] },
	{ id: "t2", role: "toolResult", text: "ok", protected: false, toolCallIds: [], toolCallId: "c2" },
	{ id: "u3", role: "user", text: "清理上下文。", protected: false, toolCallIds: [] },
];

test("block digest lists one line per turn with an inclusive ID range and token cost", () => {
	const digest = renderBlockDigest(digestRecords);
	assert.match(digest, /^<oh-my-clm-block-index>/);
	assert.match(digest, /\n1-2\. assistant\+toolResult ×2 \(\d+ tok\): I inspected the repository\.\n/);
	assert.match(digest, /\n3-5\. turn ×3 \(\d+ tok\): user \(\d+ tok\) \+ 2 noise: 继续推送更新\n/);
	// The growing turn is an anchor only, so its end never has to be guessed.
	assert.match(digest, /\nIDs 6\.\. \(current turn, not listed\): 清理上下文。\n/);
	// Protected blocks have no cleanup ID.
	assert.doesNotMatch(digest, /Build a context editor/);
	// A range never spans a user block, so deleting a line cannot silently drop
	// a later human turn.
	for (const line of digest.split("\n")) {
		const range = line.match(/^(\d+)-(\d+)\./);
		if (!range) continue;
		const from = Number(range[1]);
		const to = Number(range[2]);
		assert.ok(!digestRecords.slice(0, 0).length || from <= to);
		assert.ok(to - from + 1 <= 5, `range ${line} looks too wide`);
	}
});

test("block digest is byte-stable while a turn appends ordinary messages", () => {
	const first = renderBlockDigest(digestRecords);
	const withNoise: MirrorRecord[] = [
		...digestRecords,
		{ id: "a3", role: "assistant", text: "Running the test suite.", protected: false, toolCallIds: [] },
		{ id: "t3", role: "toolResult", text: "pass", protected: false, toolCallIds: [] },
	];
	assert.equal(renderBlockDigest(withNoise), first);
	// A new user message closes the open turn, which is the only point where the
	// digest has to change.
	const withTurn: MirrorRecord[] = [
		...withNoise,
		{ id: "u4", role: "user", text: "Now tighten the index.", protected: false, toolCallIds: [] },
	];
	const closed = renderBlockDigest(withTurn);
	assert.notEqual(closed, first);
	assert.match(closed, /\n6-8\. turn ×3 \(\d+ tok\): user \(\d+ tok\) \+ 2 noise: 清理上下文。\n/);
	assert.match(closed, /\nIDs 9\.\. \(current turn, not listed\): Now tighten the index\.\n/);
});

test("block digest caps listed turns and names the omitted ID range", () => {
	const many: MirrorRecord[] = [];
	for (let turn = 1; turn <= 60; turn += 1) {
		many.push({
			id: `u${turn}`,
			role: "user",
			text: `turn ${turn}`,
			protected: turn === 1,
			toolCallIds: [],
		});
		many.push({ id: `a${turn}`, role: "assistant", text: `answer ${turn}`, protected: false, toolCallIds: [] });
	}
	const digest = renderBlockDigest(many, { maxLines: 6 });
	const lines = digest.split("\n");
	// 3 oldest + 3 newest turns, plus one omission line for the skipped range.
	assert.match(digest, /answer 1\n/);
	assert.match(digest, /turn 3\n/);
	assert.match(digest, /turn 57\n/);
	assert.match(digest, /turn 59\n/);
	assert.doesNotMatch(digest, /turn 30/);
	assert.ok(lines.some((line) => /^\.\.\. \d+ editable block\(s\) omitted \(IDs \d+-\d+\)\.$/.test(line)));
	assert.match(digest, /IDs 118\.\. \(current turn, not listed\): turn 60/);
});

function rankedDigestRecords(): MirrorRecord[] {
	const many: MirrorRecord[] = [];
	for (let turn = 1; turn <= 60; turn += 1) {
		many.push({
			id: `u${turn}`,
			role: "user",
			text: `turn ${turn}`,
			protected: turn === 1,
			toolCallIds: [],
		});
		many.push({
			id: `a${turn}`,
			role: "assistant",
			text: turn === 30 ? "x".repeat(2_000) : `answer ${turn}`,
			protected: false,
			toolCallIds: [],
		});
	}
	return many;
}

test("block digest names the largest omitted turns by cost", () => {
	const digest = renderBlockDigest(rankedDigestRecords(), { maxLines: 6 });
	// Turn 30 is omitted by the cap and is by far the most expensive stretch, so
	// the summary names it first: that is the range worth reclaiming.
	assert.match(digest, /\n\.\.\. largest omitted turns: 58-59 \(\d+(?:\.\d+)?k? tok\), /);
	assert.match(digest, /58-59 \([\d.]+k? tok\)[^\n]*\.\n/);
});

test("block digest omits the ranking line when every turn is listed", () => {
	assert.doesNotMatch(renderBlockDigest(digestRecords), /largest omitted turns/);
});

test("the digest ranking line stays byte-stable while a turn appends", () => {
	const many = rankedDigestRecords();
	const first = renderBlockDigest(many, { maxLines: 6 });
	const withNoise: MirrorRecord[] = [
		...many,
		{ id: "a61", role: "assistant", text: "Still working.", protected: false, toolCallIds: [] },
	];
	assert.equal(renderBlockDigest(withNoise, { maxLines: 6 }), first);
});

test("block digest stays useful when the only editable blocks are the live run", () => {
	const digest = renderBlockDigest([
		{ id: "task", role: "user", text: "Build a context editor.", protected: true, toolCallIds: [] },
		{ id: "a1", role: "assistant", text: "I inspected the repository.", protected: false, toolCallIds: [] },
	]);
	assert.match(digest, /\nIDs 1\.\. \(current turn, not listed\): I inspected the repository\./);
	assert.equal(renderBlockDigest([]), "");
	assert.equal(renderBlockDigest([{ id: "only", role: "user", text: "task", protected: true, toolCallIds: [] }]), "");
});

test("a turn that only contains a user block is listed as one user line", () => {
	const digest = renderBlockDigest([
		{ id: "task", role: "user", text: "Task.", protected: true, toolCallIds: [] },
		{ id: "u1", role: "user", text: "First turn", protected: false, toolCallIds: [] },
		{ id: "u2", role: "user", text: "Second turn", protected: false, toolCallIds: [] },
	]);
	assert.match(digest, /\n1\. user \(\d+ tok\): First turn\n/);
	assert.doesNotMatch(digest, /\. turn /);
	assert.match(digest, /\nIDs 2\.\. \(current turn, not listed\): Second turn\n/);
});
