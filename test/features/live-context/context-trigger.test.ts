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
		candidates: [{ start: 5, end: 5, tokens: 12, suffixTokens: 0, netTokens: 12, turnsOld: 1 }],
		savingsTokens: 12,
	});
	assert.match(single, /ranges: \["5"\]/);
	assert.match(single, /Candidates: 5 \(~12 tok freed, 1 turn old, 0 tok after the break, net ~12\)/);
	assert.doesNotMatch(single, /5-5/);
});

/**
 * A big old turn with the whole conversation behind it, and a recent turn whose
 * suffix is only the open turn. Deleting the old turn rewrites the prefix that
 * everything else sits on, so its real cost is the 0.9x-priced suffix, not the
 * tokens it frees (prefix-breakpoint note, §7 counterexample 1).
 */
function breakpointRecords(): MirrorRecord[] {
	return [
		record("0", "user", "Protected task.", { protected: true }),
		record("1", "assistant", "anchor block"),
		record("2", "user", "An old, large request."),
		record("3", "assistant", "A".repeat(8_000)),
		record("4", "user", "A middle request."),
		record("5", "assistant", "B".repeat(4_000)),
		record("6", "user", "The most recent settled request."),
		record("7", "toolResult", "C".repeat(20_000), { toolCallId: "call-3" }),
		record("8", "user", "The open turn, still growing."),
	];
}

test("cleanup candidates rank by net savings after the prefix break, not by free tokens", () => {
	const plan = planCleanupTrigger(breakpointRecords(), { completedTurns: 4 }, {
		completedTurns: 1,
		maxCandidates: 1,
	});
	assert.equal(plan.triggered, true);
	// The 20k toolResult turn is the newest and its suffix is only the open turn;
	// the 8k assistant turn is older and sits under four more blocks.
	assert.deepEqual(plan.candidates.map((candidate) => [candidate.start, candidate.end, candidate.turnsOld]), [[6, 7, 1]]);
	const candidate = plan.candidates[0];
	assert.ok(candidate !== undefined);
	assert.ok(candidate.suffixTokens > 0, "the suffix that must be re-prefilled is priced in");
	assert.ok(candidate.netTokens < candidate.tokens, "the net figure keeps the re-prefill cost visible");
	assert.match(renderCleanupCandidates(plan), /net ~\d+/);
	assert.match(renderCleanupCandidates(plan), /\d+ tok after the break/);
});

test("a range whose break never pays back inside the run is not suggested", () => {
	// With r = 0.1 the break costs ~0.9 × 5.7k of suffix to save ~230 a turn:
	// ~22 turns of payback, longer than the assumed horizon.
	const notWorthIt = [
		record("0", "user", "Protected task.", { protected: true }),
		record("1", "assistant", "anchor block"),
		record("2", "user", "An old request."),
		record("3", "assistant", "A".repeat(8_000)),
		record("4", "user", `${"D".repeat(20_000)} open turn`),
	];
	const plan = planCleanupTrigger(notWorthIt, { completedTurns: 1 }, { completedTurns: 1 });
	assert.equal(plan.triggered, true);
	assert.deepEqual(plan.candidates, [], "a trigger that only finds loss-making edits must say nothing");
	assert.equal(plan.savingsTokens, 0);
	assert.equal(renderCleanupCandidates(plan), "");
});

test("with no cache discount (r = 1) the break costs nothing, as on GLM-5", () => {
	// Same context, two endpoints: at r = 0.1 only the tail turn pays back; at
	// r = 1 the old 8k turn is worth deleting too, because no suffix is re-priced.
	const cached = planCleanupTrigger(breakpointRecords(), { completedTurns: 4 }, {
		completedTurns: 1,
		maxCandidates: 3,
	});
	const uncached = planCleanupTrigger(breakpointRecords(), { completedTurns: 4 }, {
		completedTurns: 1,
		maxCandidates: 3,
		cacheDiscount: 1,
	});
	assert.deepEqual(cached.candidates.map((candidate) => [candidate.start, candidate.end]), [[6, 7]]);
	assert.ok(
		uncached.candidates.some((candidate) => candidate.start === 2 && candidate.end === 3),
		"r = 1 makes a break that loses money under caching profitable",
	);
	const old = uncached.candidates.find((candidate) => candidate.start === 2);
	assert.ok(old !== undefined);
	assert.equal(old.netTokens, old.tokens, "an uncached endpoint pays nothing for the break");
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

test("cleanup candidates fall back to freed tokens then staleness when the break is free", () => {
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
		// r = 1 keeps the tie-break legible: no suffix is priced, so the biggest
		// range wins and staleness only breaks ties.
		cacheDiscount: 1,
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
