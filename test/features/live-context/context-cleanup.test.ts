import assert from "node:assert/strict";
import test from "node:test";
import {
	cleanupToolResult,
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
		reason: "",
	}), /removed block\(s\): 2, 3/);
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
	assert.equal(formatCleanupToolResult(compact), "cleanup applied; removed block(s): 2.");
	const full = cleanupToolResult(plan, "1. assistant: anchor", "full");
	assert.equal(formatCleanupToolResult(full), "cleanup applied; removed block(s): 2.\n\n1. assistant: anchor");
	const none = cleanupToolResult(plan, "1. assistant: anchor", "none");
	assert.equal(formatCleanupToolResult(none), "");
	assert.equal(parseCleanupResultCopy(undefined), "compact");
	assert.equal(parseCleanupResultCopy("full"), "full");
	assert.equal(parseCleanupResultCopy("none"), "none");
	assert.equal(parseCleanupResultCopy("verbose"), "compact");
});
