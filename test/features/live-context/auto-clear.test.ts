import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	DEFAULT_BATCH_GATE,
	SupersessionTracker,
	batchPassesGate,
	batchNetTokens,
	candidateRefused,
	createRereadPolicy,
	describeCall,
	noteKeyReread,
	parseToolArguments,
	readWindowOf,
	supersedes,
	targetKeyOf,
	type RefetchCall,
} from "../../../src/features/live-context/auto-clear.ts";

function call(name: string, args: unknown, blockId: string, seq: number, blockAge = 0): RefetchCall {
	return { name, args, blockId, seq, blockAge };
}

test("read targets share a key per path so windows can be compared", () => {
	const key = targetKeyOf("read", { file_path: "/x/a.ts", offset: 10, limit: 5 });
	assert.equal(key, targetKeyOf("read", { file_path: "/x/a.ts" }));
	assert.notEqual(key, targetKeyOf("read", { file_path: "/x/b.ts" }));
});

test("grep targets canonicalize argument order and ignore whitespace-only differences", () => {
	const a = targetKeyOf("grep", { pattern: "foo", path: "src" });
	const b = targetKeyOf("grep", { path: "src", pattern: "foo" });
	assert.equal(a, b);
	assert.notEqual(a, targetKeyOf("grep", { pattern: "foobar", path: "src" }));
});

test("non-refetchable tools have no target key", () => {
	assert.equal(targetKeyOf("bash", { command: "ls" }), undefined);
	assert.equal(targetKeyOf("write", { file_path: "/x" }), undefined);
});

test("a later read supersedes an earlier window only when it covers it", () => {
	const narrow = { name: "read", args: { file_path: "/a.ts", offset: 10, limit: 20 } };
	const covering = { name: "read", args: { file_path: "/a.ts", offset: 1, limit: 100 } };
	const disjoint = { name: "read", args: { file_path: "/a.ts", offset: 200, limit: 20 } };
	assert.equal(supersedes(covering, narrow), true);
	assert.equal(supersedes(narrow, covering), false);
	assert.equal(supersedes(disjoint, narrow), false);
	assert.equal(supersedes({ name: "read", args: { file_path: "/b.ts" } }, narrow), false);
});

test("a missing limit reads to end of file and therefore covers later windows", () => {
	assert.deepEqual(readWindowOf({ file_path: "/a.ts" }), {
		path: "/a.ts",
		first: 1,
		last: Number.MAX_SAFE_INTEGER,
	});
	assert.equal(
		supersedes({ name: "read", args: { file_path: "/a.ts", offset: 5 } }, { name: "read", args: { file_path: "/a.ts", offset: 5, limit: 10 } }),
		true,
	);
});

test("an identical grep call makes the earlier block dead", () => {
	const tracker = new SupersessionTracker();
	tracker.noteCall(call("grep", { pattern: "foo" }, "c1", 1));
	tracker.noteOutput(1, 4_000);
	tracker.noteBlockTokens("c1", 4_100);
	tracker.noteCall(call("grep", { pattern: "foo" }, "c2", 2));
	tracker.noteOutput(2, 4_000);
	tracker.noteBlockTokens("c2", 4_100);
	const batch = tracker.peekBatch();
	assert.equal(batch.candidates.length, 1);
	assert.equal(batch.candidates[0]?.blockId, "c1");
	assert.equal(batch.tokens, 4_100);
});

test("a block that still holds live output stays alive", () => {
	const tracker = new SupersessionTracker();
	// One block, two fetches: only the first is superseded later.
	tracker.noteCall(call("read", { file_path: "/a.ts", offset: 1, limit: 100 }, "p1", 1));
	tracker.noteOutput(1, 3_000);
	tracker.noteCall(call("grep", { pattern: "foo" }, "p1", 2));
	tracker.noteOutput(2, 3_000);
	tracker.noteBlockTokens("p1", 6_500);
	tracker.noteCall(call("read", { file_path: "/a.ts", offset: 1, limit: 100 }, "p2", 3));
	assert.deepEqual(tracker.peekBatch().candidates, []);
});

test("a PTC block dies only when its refetch output is the whole visible body", () => {
	const tracker = new SupersessionTracker();
	tracker.noteCall(call("read", { file_path: "/a.ts" }, "root1", 1));
	tracker.noteOutput(1, 1_000);
	tracker.noteCall(call("grep", { pattern: "needle" }, "root1", 2));
	tracker.noteOutput(2, 1_000);
	tracker.noteBlockTokens("root1", 2_000);

	tracker.noteCall(call("read", { file_path: "/a.ts" }, "root2", 3));
	assert.deepEqual(tracker.peekBatch().candidates, []);

	tracker.noteCall(call("grep", { pattern: "needle" }, "root2", 4));
	const batch = tracker.peekBatch();
	assert.equal(batch.candidates.length, 1);
	assert.equal(batch.tokens, 2_000);
});

test("a program that printed live analysis is never replaced by one dead read", () => {
	const tracker = new SupersessionTracker();
	tracker.noteCall(call("read", { file_path: "/a.ts" }, "prog", 1));
	tracker.noteOutput(1, 400);
	tracker.noteBlockTokens("prog", 6_000);
	tracker.noteCall(call("read", { file_path: "/a.ts" }, "again", 2));
	// The read itself is dead, but the block is mostly stdout the model still needs.
	assert.deepEqual(tracker.peekBatch().candidates, []);
});

test("an old all-refetchable block is cleared without a superseder", () => {
	const tracker = new SupersessionTracker({ staleTurns: 3 });
	tracker.noteCall(call("read", { file_path: "/a.ts" }, "old", 1));
	tracker.noteOutput(1, 2_000);
	tracker.noteBlockTokens("old", 2_000, 42, 2);
	assert.deepEqual(tracker.peekBatch(4).candidates, []);
	const [candidate] = tracker.peekBatch(5).candidates;
	assert.equal(candidate?.blockId, "old");
	assert.equal(candidate?.reason, "stale");
	assert.equal(candidate?.ageTurns, 3);
	assert.equal(candidate?.label, "read /a.ts");
	assert.deepEqual(candidate?.keys, ["read\u0000/a.ts"]);
});

test("a recent block is not stale, and the age rule can be turned off", () => {
	const tracker = new SupersessionTracker({ staleTurns: 3 });
	tracker.noteCall(call("read", { file_path: "/a.ts" }, "block", 1));
	tracker.noteOutput(1, 2_000);
	tracker.noteBlockTokens("block", 2_000, 42, 4);
	assert.deepEqual(tracker.peekBatch(5).candidates, []);
	tracker.noteBlockTokens("block", 2_000, 42, 1);
	assert.equal(tracker.peekBatch(4).candidates[0]?.reason, "stale");
	// Without a boundary turn the age rule cannot run; the entry point keeps the
	// offline replay honest instead of clearing everything as "old".
	assert.deepEqual(tracker.peekBatch().candidates, []);
	const off = new SupersessionTracker({ staleTurns: 0 });
	off.noteCall(call("read", { file_path: "/a.ts" }, "block", 1));
	off.noteOutput(1, 2_000);
	off.noteBlockTokens("block", 2_000, 42, 1);
	assert.deepEqual(off.peekBatch(99).candidates, []);
});

test("a stale block still has to be re-fetchable in full", () => {
	const tracker = new SupersessionTracker({ staleTurns: 1 });
	tracker.noteCall(call("read", { file_path: "/a.ts" }, "mixed", 1));
	tracker.noteOutput(1, 300);
	tracker.noteBlockTokens("mixed", 5_000, 42, 1);
	assert.deepEqual(tracker.peekBatch(9).candidates, []);
});

test("an image or a URL is a re-fetchable target too", () => {
	const tracker = new SupersessionTracker();
	tracker.noteCall(call("read_image", { file_path: "/a.png" }, "img1", 1));
	tracker.noteOutput(1, 1_500);
	tracker.noteBlockTokens("img1", 1_500);
	tracker.noteCall(call("read_image", { file_path: "/a.png" }, "img2", 2));
	assert.equal(tracker.peekBatch().candidates[0]?.label, "read image /a.png");

	tracker.noteCall(call("web_fetch", { url: "https://example.com/a" }, "web1", 3));
	tracker.noteOutput(3, 900);
	tracker.noteBlockTokens("web1", 900);
	tracker.noteCall(call("web_fetch", { url: "https://example.com/a" }, "web2", 4));
	assert.equal(tracker.peekBatch().candidates.at(-1)?.label, "web_fetch https://example.com/a");
	assert.notEqual(
		targetKeyOf("web_fetch", { url: "https://example.com/a" }),
		targetKeyOf("web_fetch", { url: "https://example.com/b" }),
	);
});

test("a peek consumes nothing: a skipped pass re-offers its candidates", () => {
	const tracker = new SupersessionTracker();
	tracker.noteCall(call("glob", { pattern: "**/*.ts" }, "g1", 1));
	tracker.noteOutput(1, 300);
	tracker.noteBlockTokens("g1", 300);
	tracker.noteCall(call("glob", { pattern: "**/*.ts" }, "g2", 2));
	assert.equal(tracker.peekBatch().candidates.length, 1);
	// Below both floors, so a real pass would skip and try again next boundary.
	assert.equal(batchPassesGate(tracker.peekBatch()), false);
	assert.equal(tracker.peekBatch().candidates.length, 1);
	// A second dead block piles up and the next boundary can pay for both.
	tracker.noteCall(call("glob", { pattern: "**/*.md" }, "g3", 3));
	tracker.noteOutput(3, 300);
	tracker.noteBlockTokens("g3", 300);
	tracker.noteCall(call("glob", { pattern: "**/*.md" }, "g4", 4));
	assert.equal(tracker.peekBatch().candidates.length, 2);
	assert.equal(batchPassesGate(tracker.peekBatch()), true);
});

test("retiring the blocks one pass cleared is the only irreversible step", () => {
	const tracker = new SupersessionTracker();
	tracker.noteCall(call("glob", { pattern: "**/*.ts" }, "g1", 1));
	tracker.noteOutput(1, 2_000);
	tracker.noteBlockTokens("g1", 2_000);
	tracker.noteCall(call("glob", { pattern: "**/*.ts" }, "g2", 2));
	assert.equal(tracker.peekBatch().candidates.length, 1);
	tracker.retire(["g1"]);
	assert.equal(tracker.peekBatch().candidates.length, 0);
});

test("a settlement can ask whether a pass ahead of it already retired a block", () => {
	const tracker = new SupersessionTracker();
	tracker.noteCall(call("glob", { pattern: "**/*.ts" }, "g1", 1));
	tracker.noteOutput(1, 2_000);
	tracker.noteBlockTokens("g1", 2_000);
	tracker.noteCall(call("glob", { pattern: "**/*.ts" }, "g2", 2));
	// Two boundaries announced in one tick capture this batch twice; the second
	// settlement has to see that the first one already took the block.
	const captured = tracker.peekBatch();
	assert.equal(tracker.isRetired("g1"), false);
	tracker.retire(captured.candidates.map((candidate) => candidate.blockId));
	assert.equal(tracker.isRetired("g1"), true);
	assert.deepEqual(tracker.peekBatch().candidates, []);
});

test("a replayed decision retires its target by the tool/result seq it names", () => {
	const tracker = new SupersessionTracker();
	tracker.noteCall(call("grep", { pattern: "x" }, "c1", 1));
	tracker.noteOutput(1, 1_500);
	tracker.noteBlockTokens("c1", 1_500, 42);
	tracker.noteCall(call("grep", { pattern: "x" }, "c2", 2));
	assert.equal(tracker.peekBatch().candidates.length, 1);
	assert.equal(tracker.retireBySeq(999), false);
	assert.equal(tracker.retireBySeq(42), true);
	assert.equal(tracker.peekBatch().candidates.length, 0);
});

test("output recorded after supersession still counts toward the dead share", () => {
	const tracker = new SupersessionTracker();
	tracker.noteCall(call("read", { file_path: "/a.ts" }, "b1", 1));
	tracker.noteCall(call("read", { file_path: "/a.ts" }, "b2", 2));
	tracker.noteOutput(1, 5_000);
	tracker.noteBlockTokens("b1", 5_000);
	assert.equal(tracker.peekBatch().tokens, 5_000);
});

test("the gate needs enough tokens, enough blocks, or enough rot to matter", () => {
	const one = {
		candidates: [{ blockId: "a", seq: 7, tokens: 300, calls: [], keys: [], label: "read /a.ts", ageBlocks: 2, reason: "superseded" as const }],
		tokens: 300,
	};
	const two = {
		candidates: [
			{ blockId: "a", seq: 7, tokens: 700, calls: [], keys: [], label: "read /a.ts", ageBlocks: 2, reason: "superseded" as const },
			{ blockId: "b", seq: 8, tokens: 700, calls: [], keys: [], label: "read /b.ts", ageBlocks: 3, reason: "superseded" as const },
		],
		tokens: 1_400,
	};
	assert.equal(batchPassesGate(one), false);
	assert.equal(batchPassesGate(two), true);
	assert.equal(batchPassesGate(one, { minTokens: 200, minBlocks: 5, minShare: 0, maxSuffixTokens: 0, minNetTokens: 0 }), true);
	assert.equal(batchPassesGate({ candidates: [], tokens: 0 }), false);
	assert.equal(DEFAULT_BATCH_GATE.minTokens, 1_200);
	assert.equal(DEFAULT_BATCH_GATE.minShare, 0.05);
});

test("dead share of the live prompt opens the gate without crossing the volume floor", () => {
	// 800 dead tokens is below minTokens; the gate stays shut in a large prompt
	// and opens once the same rot is 5% of what the model reads.
	const batch = {
		candidates: [{ blockId: "a", seq: 7, tokens: 800, calls: [], keys: [], label: "read /a.ts", ageBlocks: 2, reason: "superseded" as const }],
		tokens: 800,
	};
	const gate = { minTokens: 1_200, minBlocks: 5, minShare: 0.05 };
	const rotGate = { ...gate, maxSuffixTokens: 0, minNetTokens: 0 };
	assert.equal(batchPassesGate(batch, rotGate, 16_000), true);
	assert.equal(batchPassesGate(batch, rotGate, 100_000), false);
	// Unknown prompt size disables the share path instead of guessing.
	assert.equal(batchPassesGate(batch, rotGate, 0), false);
	// A zero share is how the money-shaped gate is restored, for anyone who wants it.
	assert.equal(batchPassesGate(batch, { ...rotGate, minShare: 0 }, 16_000), false);
});

/**
 * The money test the volume gate deliberately does not make. A batch's suffix
 * is paid once at the full input rate; its freed tokens stop renting at the
 * cached rate. The replayed session's first batch freed 73k tokens behind a
 * 463k suffix — 308 steps of payback on a 139-step session.
 */
test("the money gates price a batch's suffix and amortized net", () => {
	// The break-even horizon of the plan's first batch: r=0.02, so
	// net = 0.02·ΔL − 0.98·S/N is negative until N ≈ 308 requests.
	assert.equal(batchNetTokens(73_646, 463_204, 0.02, 300), -40);
	assert.equal(batchNetTokens(73_646, 463_204, 0.02, 400), 338);
	// A tail cheap enough to break even inside ten requests passes at minNet 0.
	assert.equal(batchNetTokens(2_000, 2_000, 0.02, 10), -156, "a 2k tail behind 2k freed needs ~100 requests");
	// Out-of-range inputs degrade to the documented defaults, not NaN.
	assert.equal(batchNetTokens(1_000, 1_000, 12, 10), batchNetTokens(1_000, 1_000, 1, 10));
	assert.equal(batchNetTokens(1_000, 1_000, 0.02, 0), -960, "N floors at 1 instead of dividing by zero");
	// Defaults ship with both money knobs off: the anti-rot channel keeps its shape.
	assert.equal(DEFAULT_BATCH_GATE.maxSuffixTokens, 0);
	assert.equal(DEFAULT_BATCH_GATE.minNetTokens, 0);
});

test("arguments arrive as raw JSON on tool/call and as objects on PTC sub-calls", () => {
	assert.deepEqual(parseToolArguments('{"file_path":"/a.ts"}'), { file_path: "/a.ts" });
	assert.deepEqual(parseToolArguments({ file_path: "/a.ts" }), { file_path: "/a.ts" });
	assert.equal(parseToolArguments("{not json"), undefined);
});

test("a candidate carries the surface seq, the target keys and a pointer label", () => {
	const tracker = new SupersessionTracker();
	tracker.noteCall(call("read", { file_path: "/src/a.ts", offset: 10, limit: 20 }, "c1", 1));
	tracker.noteOutput(1, 3_000);
	tracker.noteBlockTokens("c1", 3_000, 42);
	tracker.noteCall(call("read", { file_path: "/src/a.ts", offset: 1, limit: 200 }, "c2", 2));
	const [candidate] = tracker.peekBatch().candidates;
	assert.equal(candidate?.seq, 42);
	assert.equal(candidate?.label, "read /src/a.ts:10-29");
	assert.equal(candidate?.reason, "superseded");
	assert.deepEqual(candidate?.keys, ["read\u0000/src/a.ts"]);
});

test("a block older than its surface seq keeps the newest seq it saw", () => {
	const tracker = new SupersessionTracker();
	tracker.noteCall(call("grep", { pattern: "x" }, "c1", 1));
	tracker.noteOutput(1, 1_600);
	tracker.noteBlockTokens("c1", 1_500, 9);
	tracker.noteBlockTokens("c1", 1_600, 11);
	tracker.noteCall(call("grep", { pattern: "x" }, "c2", 2));
	assert.equal(tracker.peekBatch().candidates[0]?.seq, 11);
});

test("pointer labels name the target and stay one line", () => {
	assert.equal(describeCall({ name: "read", args: { file_path: "/a.ts" } }), "read /a.ts");
	assert.equal(describeCall({ name: "read", args: { file_path: "/a.ts", offset: 5 } }), "read /a.ts:5-");
	assert.equal(describeCall({ name: "grep", args: { pattern: "needle" } }), 'grep "needle"');
	assert.equal(describeCall({ name: "web_fetch", args: { url: "https://example.com/a" } }), "web_fetch https://example.com/a");
	assert.equal(describeCall({ name: "read_image", args: { file_path: "/a.png" } }), "read image /a.png");
	const long = describeCall({ name: "grep", args: { pattern: "x".repeat(200) } });
	assert.equal(long.includes("\n"), false);
	assert.equal(long.length < 90, true);
});



/**
 * The stale rule's second clock. A turn is 11–39 steps wide, so a turn count
 * cannot age anything inside one long turn; tool results land once per step, so
 * counting them bounds the age the way the turn count never can.
 */
test("a block also ages by tool results, not only by turn boundaries", () => {
	const tracker = new SupersessionTracker({ staleTurns: 0, staleSteps: 3 });
	tracker.noteCall(call("read", { file_path: "/a.ts" }, "old", 1));
	tracker.noteOutput(1, 2_000);
	tracker.noteBlockLanding();
	tracker.noteBlockTokens("old", 2_000, 42, 2);
	// Two results later it is still inside the step budget, and no turn boundary
	// exists to age it.
	assert.deepEqual(tracker.peekBatch().candidates, []);
	tracker.noteBlockLanding();
	tracker.noteBlockLanding();
	assert.deepEqual(tracker.peekBatch().candidates, []);
	tracker.noteBlockLanding();
	const [candidate] = tracker.peekBatch().candidates;
	assert.equal(candidate?.blockId, "old");
	assert.equal(candidate?.reason, "stale");
	assert.equal(candidate?.ageSteps, 3);
	// The turn clock is off, so this is purely the step clock: no boundary needed.
	assert.equal(candidate?.ageTurns, undefined);
});

test("the step clock is off by default and can be disabled on its own", () => {
	const tracker = new SupersessionTracker();
	tracker.noteCall(call("read", { file_path: "/a.ts" }, "old", 1));
	tracker.noteOutput(1, 2_000);
	tracker.noteBlockLanding();
	tracker.noteBlockTokens("old", 2_000, 42, 1);
	for (let index = 0; index < 50; index += 1) tracker.noteBlockLanding();
	assert.deepEqual(tracker.peekBatch(1).candidates, []);

	const turnOnly = new SupersessionTracker({ staleTurns: 1, staleSteps: 0 });
	turnOnly.noteCall(call("read", { file_path: "/a.ts" }, "old", 1));
	turnOnly.noteOutput(1, 2_000);
	turnOnly.noteBlockLanding();
	turnOnly.noteBlockTokens("old", 2_000, 42, 1);
	for (let index = 0; index < 50; index += 1) turnOnly.noteBlockLanding();
	assert.deepEqual(turnOnly.peekBatch(1).candidates, [], "steps alone must not age it");
	assert.equal(turnOnly.peekBatch(2).candidates[0]?.reason, "stale");
});

/**
 * The one-sided floor is the shape that priced the replayed session out: a
 * batch's suffix is measured from its oldest block, so the backlog's suffix is
 * the whole session. The rot window keeps the selector on the young end.
 */
test("the step clock clears inside an age window, not past it", () => {
	const tracker = new SupersessionTracker({ staleTurns: 0, staleSteps: 2, minAgeSteps: 2, maxAgeSteps: 4 });
	tracker.noteCall(call("read", { file_path: "/a.ts" }, "old", 1));
	tracker.noteOutput(1, 2_000);
	tracker.noteBlockLanding();
	tracker.noteBlockTokens("old", 2_000, 42, 1);
	// One result later it is still in the hot set, even though the old floor of 2
	// would not have fired yet either; the window's floor is the same floor.
	tracker.noteBlockLanding();
	assert.deepEqual(tracker.peekBatch(1).candidates, []);
	tracker.noteBlockLanding();
	assert.equal(tracker.peekBatch(1).candidates[0]?.reason, "stale");
	// Past the window's upper bound the block is backlog: it stays, because the
	// suffix it would cost is the whole session behind it.
	for (let index = 0; index < 3; index += 1) tracker.noteBlockLanding();
	assert.deepEqual(tracker.peekBatch(1).candidates, [], "an unbounded age rule selects the backlog");
	// `maxAgeSteps: 0` is the unbounded rule of today, for a config that wants it.
	const unbounded = new SupersessionTracker({ staleTurns: 0, staleSteps: 2, minAgeSteps: 0, maxAgeSteps: 0 });
	unbounded.noteCall(call("read", { file_path: "/a.ts" }, "old", 1));
	unbounded.noteOutput(1, 2_000);
	unbounded.noteBlockLanding();
	unbounded.noteBlockTokens("old", 2_000, 42, 1);
	for (let index = 0; index < 8; index += 1) unbounded.noteBlockLanding();
	assert.equal(unbounded.peekBatch(1).candidates[0]?.reason, "stale");
});

test("the hot-set margin holds even when the step clock is set below it", () => {
	// A step clock at 1 with the default margin still waits two results: clearing
	// a result the model may read next step is the tail bill with no rot behind it.
	const tracker = new SupersessionTracker({ staleTurns: 0, staleSteps: 1 });
	tracker.noteCall(call("read", { file_path: "/a.ts" }, "old", 1));
	tracker.noteOutput(1, 2_000);
	tracker.noteBlockLanding();
	tracker.noteBlockTokens("old", 2_000, 42, 1);
	tracker.noteBlockLanding();
	assert.deepEqual(tracker.peekBatch(1).candidates, []);
	tracker.noteBlockLanding();
	assert.equal(tracker.peekBatch(1).candidates[0]?.reason, "stale");
});

/**
 * Refusing one key is the surgical answer to a target that keeps coming back;
 * the session-wide latch is for a rate spread across many keys. Without it, one
 * pathological file shuts the whole channel.
 */
test("a key that keeps coming back is refused, not the whole session", () => {
	const policy = createRereadPolicy();
	assert.equal(noteKeyReread(policy, "read\u0000/a.ts"), false);
	assert.equal(noteKeyReread(policy, "read\u0000/a.ts"), true);
	assert.deepEqual([...policy.refused], ["read\u0000/a.ts"]);
	// A different target is untouched, so the channel stays open for it.
	assert.equal(noteKeyReread(policy, "read\u0000/b.ts"), false);
	assert.deepEqual([...policy.refused], ["read\u0000/a.ts"]);
});

test("a candidate that touches a refused key is skipped whole", () => {
	const policy = createRereadPolicy();
	const candidate = { keys: ["read\u0000/a.ts", "grep\u0000x"] };
	assert.equal(candidateRefused(policy, candidate), false);
	noteKeyReread(policy, "read\u0000/a.ts");
	noteKeyReread(policy, "read\u0000/a.ts");
	// Clearing rewrites the whole block, so one refused key inside it is enough:
	// the model would be sent back to a target it already proved is live.
	assert.equal(candidateRefused(policy, candidate), true);
});
