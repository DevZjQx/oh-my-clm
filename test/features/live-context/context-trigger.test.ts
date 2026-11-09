import assert from "node:assert/strict";
import test from "node:test";
import {
	formatTokenCount,
	formatUsageLine,
	planCleanupTrigger,
	renderCleanupCandidates,
} from "../../../src/features/live-context/context-trigger.ts";
import {
	estimateMirrorTokens,
	type MirrorRecord,
	type MirrorRole,
} from "../../../src/features/live-context/context-format.ts";

function record(id: string, role: MirrorRole, text: string, extra: Partial<MirrorRecord> = {}): MirrorRecord {
	return { id, role, text, protected: false, toolCallIds: [], ...extra };
}

/**
 * Editable ordinals: 1 assistant, 2 toolResult (unit 1-2), 3 user, 4 assistant,
 * 5 toolResult (unit 3-5), 6 user (open unit). The protected initial task is
 * excluded from the ordinals, as in the real projection.
 */
function records(): MirrorRecord[] {
	return [
		record("0", "user", "Initial task that stays protected.", { protected: true }),
		record("1", "assistant", "I inspected the repository.\nread README"),
		record("2", "toolResult", "Z".repeat(2_000), { toolCallId: "call-1" }),
		record("3", "user", "A settled second request."),
		record("4", "assistant", "I grepped the second area.\ngrep"),
		record("5", "toolResult", "Y".repeat(2_000), { toolCallId: "call-2" }),
		record("6", "user", "The current turn is still growing."),
	];
}

test("cleanup trigger defaults to off and never suggests block 1", () => {
	const off = planCleanupTrigger(records(), { completedTurns: 9, usageTokens: 9_000, contextWindow: 10_000 });
	assert.equal(off.triggered, false);
	assert.deepEqual(off.candidates, []);
	assert.equal(renderCleanupCandidates(off), "");

	const hit = planCleanupTrigger(
		records(),
		{ completedTurns: 0, usageTokens: 9_000, contextWindow: 10_000, exactUsage: true },
		{ usagePercent: 50 },
	);
	assert.equal(hit.triggered, true);
	assert.deepEqual(hit.candidates.map((candidate) => [candidate.start, candidate.end]), [[3, 5]]);
	assert.ok(hit.candidates.every((candidate) => candidate.start > 1));
	const rendered = renderCleanupCandidates(hit);
	assert.match(rendered, /^Suggested cleanup \(usage 90% ≥ 50%\): cleanup\(\{ ranges: \["3-5"\], skipRoles: \["user"\] \}\) frees ~\d+ tok\./);
	assert.match(rendered, /block 1, user messages, and the current turn stay\./);
	// The suggested call keeps the human's request: a candidate is a range plus
	// the keep-rule, and the quoted savings already exclude the user block.
	const unitTokens = hit.candidates[0]?.tokens ?? 0;
	assert.ok(unitTokens > 0);
	assert.ok(hit.savingsTokens < estimateMirrorTokens(records().slice(3, 6)), "user text is preserved, so it is not claimed as savings");
});

test("cleanup candidates never suggest deleting a user message", () => {
	// A turn that holds nothing but the human's request frees nothing under the
	// keep-rule, so it must not be suggested at all.
	const userOnly = [
		record("0", "user", "protected task", { protected: true }),
		record("1", "assistant", "anchor block"),
		record("2", "user", "An old request with no tool noise at all."),
		record("3", "user", "The open turn."),
	];
	const plan = planCleanupTrigger(userOnly, { completedTurns: 3 }, { completedTurns: 1 });
	assert.deepEqual(plan.candidates, []);
	assert.equal(renderCleanupCandidates(plan), "");

	// A single-block candidate is spelled the same in the call and the detail line.
	const single = renderCleanupCandidates({
		triggered: true,
		signals: ["1 completed turn ≥ 1"],
		candidates: [{ start: 5, end: 5, tokens: 12, turnsOld: 1 }],
		savingsTokens: 12,
	});
	assert.match(single, /ranges: \["5"\]/);
	assert.match(single, /Candidates: 5 \(~12 tok, 1 turn old\)/);
	assert.doesNotMatch(single, /5-5/);
});

test("cleanup trigger signals are labelled and an estimated usage keeps the ~ marker", () => {
	const estimated = planCleanupTrigger(records(), {
		usageTokens: 800,
		contextWindow: 1_000,
		exactUsage: false,
		completedTurns: 0,
	}, { usagePercent: 70 });
	assert.deepEqual(estimated.signals, ["~usage 80% ≥ 70%"]);

	const mixed = planCleanupTrigger(records(), {
		completedTurns: 4,
		lastCleanupTurn: 1,
		currentTurn: 5,
	}, { completedTurns: 3, turnsSinceCleanup: 3, toolResultShare: 0.5 });
	assert.equal(mixed.triggered, true);
	assert.ok(mixed.signals.includes("4 completed turns ≥ 3"));
	assert.ok(mixed.signals.includes("4 turns since cleanup ≥ 3"));
	assert.ok(mixed.signals.some((signal) => signal.startsWith("toolResult ") && signal.endsWith("% ≥ 50%")));
});

test("cleanup candidates rank by reclaimable tokens times staleness", () => {
	const sized = [
		record("0", "user", "protected", { protected: true }),
		record("1", "assistant", "anchor block"),
		record("2", "user", "small but old turn"),
		record("3", "assistant", "tiny"),
		record("4", "user", "large recent turn"),
		record("5", "assistant", "L".repeat(8_000)),
		record("6", "user", "open turn"),
	];
	const plan = planCleanupTrigger(sized, {
		completedTurns: 1,
		usageTokens: 100,
		contextWindow: 1_000,
	}, {
		usagePercent: 1,
		maxCandidates: 1,
	});
	assert.equal(plan.triggered, true);
	// 5 is far larger than 3, so savings beat the extra turn of staleness.
	assert.deepEqual(plan.candidates.map((candidate) => [candidate.start, candidate.end, candidate.turnsOld]), [[4, 5, 1]]);
	assert.equal(plan.savingsTokens, plan.candidates[0]?.tokens);
});

test("usage line marks the estimate and an unknown window instead of guessing", () => {
	assert.equal(formatTokenCount(6_400), "6.4k");
	assert.equal(formatTokenCount(8_000), "8k");
	assert.equal(formatTokenCount(128_000), "128k");
	assert.equal(formatTokenCount(640), "640");
	assert.equal(
		formatUsageLine({ tokens: 6_400, contextWindow: 8_000, exact: true, editableBlocks: 6 }),
		"Usage: 6.4k/8k tokens (80%) · 6 editable blocks · no cleanup yet",
	);
	assert.equal(
		formatUsageLine({ tokens: 6_400, contextWindow: 8_000, exact: false, editableBlocks: 6, lastCleanupTurn: 2 }),
		"Usage: ~6.4k/8k tokens (80%) · 6 editable blocks · last cleanup at turn 2",
	);
	assert.equal(
		formatUsageLine({ tokens: 640, exact: false, editableBlocks: 1 }),
		"Usage: ~640 tokens (window unknown) · 1 editable block · no cleanup yet",
	);
});
