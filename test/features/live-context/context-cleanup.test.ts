import assert from "node:assert/strict";
import test from "node:test";
import {
	cleanupToolResult,
	describeCleanupList,
	formatBlockIdRuns,
	formatCleanupToolResult,
	parseCleanupArgs,
	parseCleanupMirror,
	parseCleanupResultCopy,
	planCleanup,
	removeMirrorBlocks,
} from "../../../src/features/live-context/context-cleanup.ts";
import { parseMirror, renderMirror, type MirrorRecord } from "../../../src/features/live-context/context-format.ts";

function cleanupRecords(): MirrorRecord[] {
	return [
		{
			id: "task",
			role: "user",
			text: "Keep the task.",
			protected: true,
			toolCallIds: [],
		},
		{
			id: "anchor",
			role: "assistant",
			text: "Load-bearing block one.",
			protected: false,
			toolCallIds: [],
		},
		{
			id: "stale-answer",
			role: "assistant",
			text: "A stale answer that should be removed.",
			protected: false,
			toolCallIds: [],
		},
		{
			id: "self-read",
			role: "toolResult",
			text: "A full mirror read that is self-referential noise.",
			protected: false,
			toolCallIds: [],
		},
		{
			id: "later-fact",
			role: "user",
			text: "Keep this later fact.",
			protected: false,
			toolCallIds: [],
		},
	];
}

test("cleanup validates IDs and removes whole spans without reconstructing bodies", () => {
	const records = cleanupRecords();
	const mirror = renderMirror(records);
	const structural = parseCleanupMirror(mirror);
	assert.equal("body" in (structural.blocks.get("1") ?? {}), false);
	const plan = planCleanup(records, structural, [2, 3]);
	assert.equal(plan.status, "applied");
	assert.deepEqual(plan.removedBlockIds, [2, 3]);
	assert.deepEqual(plan.omittedIds, ["stale-answer", "self-read"]);

	const cleaned = removeMirrorBlocks(mirror, plan.removedBlockIds);
	assert.match(cleaned, /^<!-- clm-v2 -->/);
	assert.match(cleaned, /CLM_SNAPSHOT/);
	assert.match(cleaned, /CLM_ENTRY id=1 role=assistant/);
	assert.match(cleaned, /Load-bearing block one\./);
	assert.doesNotMatch(cleaned, /stale answer/);
	assert.doesNotMatch(cleaned, /self-referential noise/);
	assert.match(cleaned, /CLM_ENTRY id=4 role=user/);
	assert.equal(parseMirror(cleaned).recognized, true);
	assert.match(formatCleanupToolResult({
		status: "applied",
		requestedBlockIds: [2, 3],
		removedBlockIds: [2, 3],
		pairedRemovalIds: [],
		reason: "",
	}), /removed 2 block\(s\): 2-3/);
});

test("cleanup works when a retained preview is truncated", () => {
	const records: MirrorRecord[] = [
		{
			id: "task",
			role: "user",
			text: "Task",
			protected: true,
			toolCallIds: [],
		},
		{
			id: "anchor",
			role: "assistant",
			text: "Anchor",
			protected: false,
			toolCallIds: [],
		},
		{
			id: "huge-noise",
			role: "toolResult",
			text: "x".repeat(10_000),
			renderText: "x".repeat(80) + "\n...[oh-my-clm mirror preview truncated; 10000 source characters retained unless this block is edited]...",
			protected: false,
			toolCallIds: [],
		},
		{
			id: "fact",
			role: "user",
			text: "A retained fact.",
			protected: false,
			toolCallIds: [],
		},
	];
	const mirror = renderMirror(records);
	assert.match(mirror, /preview truncated/);
	const plan = planCleanup(records, parseCleanupMirror(mirror), [2]);
	assert.equal(plan.status, "applied");
	const cleaned = removeMirrorBlocks(mirror, plan.removedBlockIds);
	assert.doesNotMatch(cleaned, /preview truncated/);
	assert.match(cleaned, /A retained fact\./);
});

test("cleanup preserves block 1 and rejects stale or malformed targets", () => {
	const records = cleanupRecords();
	const mirror = renderMirror(records);
	const protectedPlan = planCleanup(records, parseCleanupMirror(mirror), [1]);
	assert.equal(protectedPlan.status, "rejected");
	assert.match(protectedPlan.reason ?? "", /block 1/i);

	const unknownPlan = planCleanup(records, parseCleanupMirror(mirror), [99]);
	assert.equal(unknownPlan.status, "rejected");
	assert.match(unknownPlan.reason ?? "", /unknown/i);

	const duplicateArgs = parseCleanupArgs({ blockIds: [2, 2] });
	assert.equal(duplicateArgs.ok, false);
	const emptyArgs = parseCleanupArgs({ blockIds: [] });
	assert.equal(emptyArgs.ok, false);
	const extraArgs = parseCleanupArgs({ blockIds: [2], reason: "unexpected" });
	assert.equal(extraArgs.ok, false);

	const stale = mirror.replace(/CLM_SNAPSHOT [a-f0-9]{16}/, "CLM_SNAPSHOT 0000000000000000");
	const stalePlan = planCleanup(records, parseCleanupMirror(stale), [2]);
	assert.equal(stalePlan.status, "rejected");
	assert.match(stalePlan.reason ?? "", /stale/i);
});

test("cleanup refuses to remove a paired owner when block 1 must remain", () => {
	const records: MirrorRecord[] = [
		{
			id: "task",
			role: "user",
			text: "Task",
			protected: true,
			toolCallIds: [],
		},
		{
			id: "owner",
			role: "assistant",
			text: "Anchor tool call",
			protected: false,
			toolCallIds: ["call-1"],
		},
		{
			id: "result",
			role: "toolResult",
			text: "Noise",
			protected: false,
			toolCallIds: [],
			toolCallId: "call-1",
		},
	];
	const plan = planCleanup(records, parseCleanupMirror(renderMirror(records)), [2]);
	assert.equal(plan.status, "rejected");
	assert.match(plan.reason ?? "", /block 1|paired/i);
});

test("cleanup result formatting honors compact, full, and none copies", () => {
	const plan = {
		status: "applied" as const,
		requestedBlockIds: [2],
		removedBlockIds: [2],
		reason: "",
	};
	const compact = cleanupToolResult(plan, "1. assistant: anchor");
	assert.equal(compact.copy, "compact");
	assert.equal(formatCleanupToolResult(compact), "cleanup applied; removed 1 block(s): 2.");
	const full = cleanupToolResult(plan, "1. assistant: anchor", "full");
	assert.equal(formatCleanupToolResult(full), "cleanup applied; removed 1 block(s): 2.\n\n1. assistant: anchor");
	const none = cleanupToolResult(plan, "1. assistant: anchor", "none");
	assert.equal(formatCleanupToolResult(none), "");
	assert.equal(parseCleanupResultCopy(undefined), "compact");
	assert.equal(parseCleanupResultCopy("full"), "full");
	assert.equal(parseCleanupResultCopy("none"), "none");
	assert.equal(parseCleanupResultCopy("verbose"), "compact");
});

test("cleanup args accept inclusive ranges and a role filter", () => {
	const ranges = parseCleanupArgs({ ranges: ["3-5", "8"] });
	assert.equal(ranges.ok, true);
	if (!ranges.ok) return;
	assert.deepEqual(ranges.args.blockIds, [3, 4, 5, 8]);
	assert.deepEqual(ranges.args.explicitIds, []);
	assert.deepEqual(ranges.args.rangedIds, [3, 4, 5, 8]);
	assert.deepEqual(ranges.args.skipRoles, []);

	const mixed = parseCleanupArgs({ blockIds: [9], ranges: ["3-5"], skipRoles: ["user"] });
	assert.equal(mixed.ok, true);
	if (!mixed.ok) return;
	assert.deepEqual(mixed.args.blockIds, [3, 4, 5, 9]);
	assert.deepEqual(mixed.args.explicitIds, [9]);
	assert.deepEqual(mixed.args.skipRoles, ["user"]);
	// An ID named explicitly wins over the same ID produced by a range, so it
	// keeps the strict unknown-ID behavior.
	const overlapping = parseCleanupArgs({ blockIds: [4], ranges: ["3-5"] });
	assert.equal(overlapping.ok, true);
	if (!overlapping.ok) return;
	assert.deepEqual(overlapping.args.explicitIds, [4]);
	assert.deepEqual(overlapping.args.blockIds, [3, 4, 5]);
});

test("cleanup args reject malformed ranges, empty targets, and unknown fields", () => {
	for (const bad of [
		{ ranges: ["5-3"] },
		{ ranges: ["abc"] },
		{ ranges: ["0-2"] },
		{ ranges: ["1-100000"] },
		{ ranges: [3] },
		{ blockIds: [] },
		{ blockIds: [], ranges: [] },
		{ blockIds: [1], extra: true },
		{ blockIds: [1], skipRoles: ["system"] },
	]) {
		assert.equal(parseCleanupArgs(bad).ok, false, JSON.stringify(bad));
	}
});

test("a range deletes a whole turn, clamps at the end, and preserves block 1", () => {
	const records = cleanupRecords();
	const structural = parseCleanupMirror(renderMirror(records));
	const parsed = parseCleanupArgs({ ranges: ["1-4"] });
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const plan = planCleanup(records, structural, parsed.args);
	assert.equal(plan.status, "applied");
	// Block 1 is load-bearing, so a range that covers it keeps it; IDs past the
	// last block are clamped instead of rejecting the whole call.
	assert.deepEqual(plan.requestedBlockIds, [1, 2, 3, 4]);
	assert.deepEqual(plan.removedBlockIds, [2, 3, 4]);
	assert.deepEqual(plan.pairedRemovalIds, []);

	const beyond = parseCleanupArgs({ ranges: ["2-99"] });
	assert.equal(beyond.ok, true);
	if (!beyond.ok) return;
	const clamped = planCleanup(records, structural, beyond.args);
	assert.equal(clamped.status, "applied");
	assert.deepEqual(clamped.removedBlockIds, [2, 3, 4]);

	// A mistyped explicit ID is still rejected instead of silently ignored.
	assert.equal(planCleanup(records, structural, [99]).status, "rejected");
});

test("skipRoles keeps user blocks inside a requested range", () => {
	const records = cleanupRecords();
	const structural = parseCleanupMirror(renderMirror(records));
	const parsed = parseCleanupArgs({ ranges: ["2-4"], skipRoles: ["user"] });
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const plan = planCleanup(records, structural, parsed.args);
	assert.equal(plan.status, "applied");
	// Block 4 is the later user turn and survives the range.
	assert.deepEqual(plan.removedBlockIds, [2, 3]);
});

test("paired removals are reported separately from the requested targets", () => {
	const records: MirrorRecord[] = [
		{ id: "task", role: "user", text: "Keep the task.", protected: true, toolCallIds: [] },
		{ id: "anchor", role: "assistant", text: "Anchor.", protected: false, toolCallIds: [] },
		{ id: "call", role: "assistant", text: "Running a command.", protected: false, toolCallIds: ["call-1"] },
		{ id: "result", role: "toolResult", text: "Command output.", protected: false, toolCallIds: [], toolCallId: "call-1" },
		{ id: "later", role: "user", text: "Later.", protected: false, toolCallIds: [] },
	];
	const structural = parseCleanupMirror(renderMirror(records));
	// Editable ordinals: anchor=1, call=2, result=3, later=4. Requesting the
	// assistant tool call also removes its result, which was never requested.
	const plan = planCleanup(records, structural, [2]);
	assert.equal(plan.status, "applied");
	assert.deepEqual(plan.requestedBlockIds, [2]);
	assert.deepEqual(plan.removedBlockIds, [2, 3]);
	assert.deepEqual(plan.pairedRemovalIds, [3]);
	const text = formatCleanupToolResult(cleanupToolResult(plan));
	assert.equal(text, "cleanup applied; removed 2 block(s): 2-3. Paired (not requested): 3.");
});

test("formatBlockIdRuns compresses sorted runs", () => {
	assert.equal(formatBlockIdRuns([3, 4, 5, 7, 9, 10]), "3-5, 7, 9-10");
	assert.equal(formatBlockIdRuns([]), "");
	assert.equal(formatBlockIdRuns([5, 4, 4, 6]), "4-6");
});

test("a range that covers block 1 keeps its paired tool result instead of rejecting", () => {
	const records: MirrorRecord[] = [
		{ id: "task", role: "user", text: "Task.", protected: true, toolCallIds: [] },
		{ id: "call", role: "assistant", text: "First tool call.", protected: false, toolCallIds: ["call-1"] },
		{ id: "result", role: "toolResult", text: "First output.", protected: false, toolCallIds: [], toolCallId: "call-1" },
		{ id: "later", role: "user", text: "Later turn.", protected: false, toolCallIds: [] },
	];
	const structural = parseCleanupMirror(renderMirror(records));
	const onlyPair = parseCleanupArgs({ ranges: ["1-2"] });
	assert.equal(onlyPair.ok, true);
	if (!onlyPair.ok) return;
	const nothing = planCleanup(records, structural, onlyPair.args);
	assert.equal(nothing.status, "rejected");
	assert.match(nothing.reason ?? "", /Nothing in the requested targets is removable/);

	// The same range plus the later turn removes only what is safe.
	const withLater = parseCleanupArgs({ ranges: ["1-3"] });
	assert.equal(withLater.ok, true);
	if (!withLater.ok) return;
	const plan = planCleanup(records, structural, withLater.args);
	assert.equal(plan.status, "applied");
	assert.deepEqual(plan.removedBlockIds, [3]);
});

test("cleanup list is parsed as a read-only range and rejects mixed targets", () => {
	const parsed = parseCleanupArgs({ list: "4-8" });
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.deepEqual(parsed.args.list, { start: 4, end: 8 });
	assert.deepEqual(parsed.args.blockIds, []);
	const single = parseCleanupArgs({ list: "7" });
	assert.equal(single.ok, true);
	if (single.ok) assert.deepEqual(single.args.list, { start: 7, end: 7 });

	const mixed = parseCleanupArgs({ list: "4-8", blockIds: [2] });
	assert.equal(mixed.ok, false);
	if (!mixed.ok) assert.match(mixed.reason, /read-only/);
	const mixedRange = parseCleanupArgs({ list: "4-8", ranges: ["1-2"] });
	assert.equal(mixedRange.ok, false);
	const bad = parseCleanupArgs({ list: "8-4" });
	assert.equal(bad.ok, false);
	if (!bad.ok) assert.match(bad.reason, /ends before it starts/);
	const notString = parseCleanupArgs({ list: true });
	assert.equal(notString.ok, false);
	// Empty companions are tolerated: a schema-driven client may always send them.
	const empty = parseCleanupArgs({ list: "1-2", blockIds: [], ranges: [], skipRoles: [] });
	assert.equal(empty.ok, true);
});

test("cleanup list returns read-only rows and is never planned as a removal", () => {
	const records = cleanupRecords();
	const listed = describeCleanupList(records, { start: 2, end: 3 });
	assert.equal(listed.status, "listed");
	assert.deepEqual(listed.removedBlockIds, []);
	assert.match(listed.rows ?? "", /^<oh-my-clm-block-list>\nRead-only rows for IDs 2-3; nothing was removed\.\n/);
	assert.match(listed.rows ?? "", /\n2\. assistant: A stale answer that should be removed\.\n/);
	// The listing survives every copy mode: it is the requested content, not a
	// confirmation that may be suppressed.
	assert.equal(formatCleanupToolResult(listed, "none"), listed.rows);
	assert.equal(formatCleanupToolResult(listed, "compact"), listed.rows);

	const structural = parseCleanupMirror(renderMirror(records));
	const parsed = parseCleanupArgs({ list: "2-3" });
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const plan = planCleanup(records, structural, parsed.args);
	assert.equal(plan.status, "rejected");
	assert.match(plan.reason ?? "", /read-only/);

	const past = describeCleanupList(records, { start: 99, end: 120 });
	assert.equal(past.status, "rejected");
	assert.match(past.reason, /last ID 4/);
});
