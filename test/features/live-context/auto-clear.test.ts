import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	DEFAULT_BATCH_GATE,
	SupersessionTracker,
	batchPassesGate,
	describeCall,
	fitBatch,
	parseToolArguments,
	readWindowOf,
	supersedes,
	targetKeyOf,
	type CanaryBatch,
	type ClearCandidate,
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

test("a PTC block dies only when every refetch inside it is superseded", () => {
	const tracker = new SupersessionTracker();
	tracker.noteCall(call("read", { file_path: "/a.ts" }, "root1", 1));
	tracker.noteOutput(1, 1_000);
	tracker.noteCall(call("grep", { pattern: "needle" }, "root1", 2));
	tracker.noteOutput(2, 1_000);
	tracker.noteBlockTokens("root1", 2_400);

	tracker.noteCall(call("read", { file_path: "/a.ts" }, "root2", 3));
	assert.deepEqual(tracker.peekBatch().candidates, []);

	tracker.noteCall(call("grep", { pattern: "needle" }, "root2", 4));
	const batch = tracker.peekBatch();
	assert.equal(batch.candidates.length, 1);
	assert.equal(batch.tokens, 2_400);
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

test("the gate needs either enough tokens or enough blocks", () => {
	const one = {
		candidates: [{ blockId: "a", seq: 7, tokens: 300, calls: [], keys: [], label: "read /a.ts", ageBlocks: 2 }],
		tokens: 300,
	};
	const two = {
		candidates: [
			{ blockId: "a", seq: 7, tokens: 700, calls: [], keys: [], label: "read /a.ts", ageBlocks: 2 },
			{ blockId: "b", seq: 8, tokens: 700, calls: [], keys: [], label: "read /b.ts", ageBlocks: 3 },
		],
		tokens: 1_400,
	};
	assert.equal(batchPassesGate(one), false);
	assert.equal(batchPassesGate(two), true);
	assert.equal(batchPassesGate(one, { minTokens: 200, minBlocks: 5 }), true);
	assert.equal(batchPassesGate({ candidates: [], tokens: 0 }), false);
	assert.equal(DEFAULT_BATCH_GATE.minTokens, 1_200);
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
	tracker.noteBlockTokens("c1", 3_200, 42);
	tracker.noteCall(call("read", { file_path: "/src/a.ts", offset: 1, limit: 200 }, "c2", 2));
	const [candidate] = tracker.peekBatch().candidates;
	assert.equal(candidate?.seq, 42);
	assert.equal(candidate?.label, "read /src/a.ts:10-29");
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
	const long = describeCall({ name: "grep", args: { pattern: "x".repeat(200) } });
	assert.equal(long.includes("\n"), false);
	assert.equal(long.length < 90, true);
});

function candidate(blockId: string, seq: number, tokens: number): ClearCandidate {
	return { blockId, seq, tokens, calls: [], keys: [], label: `read ${blockId}`, ageBlocks: 0 };
}

function batchOf(...candidates: ClearCandidate[]): CanaryBatch {
	return { candidates, tokens: candidates.reduce((total, entry) => total + entry.tokens, 0) };
}

test("a batch larger than the remaining budget is sliced oldest-first", () => {
	const batch = batchOf(candidate("c3", 3, 10_000), candidate("c1", 1, 30_000), candidate("c2", 2, 25_000));
	const fitted = fitBatch(batch, 40_000);
	assert.deepEqual(fitted?.candidates.map((entry) => entry.blockId), ["c1", "c3"]);
	assert.equal(fitted?.tokens, 40_000);
});

test("an oversized single block runs only as the first pass", () => {
	const batch = batchOf(candidate("big", 1, 73_646));
	assert.equal(fitBatch(batch, 40_000), undefined);
	assert.deepEqual(fitBatch(batch, 40_000, true)?.candidates.map((entry) => entry.blockId), ["big"]);
});

test("an empty batch never reaches the budget slicer", () => {
	assert.equal(fitBatch({ candidates: [], tokens: 0 }, 40_000), undefined);
});
