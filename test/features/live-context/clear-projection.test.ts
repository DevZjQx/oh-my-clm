import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	CLEAR_EVENT_TYPE,
	CLEAR_PLACEHOLDER_PREFIX,
	CLEAR_VERSION,
	clearPlaceholder,
	clearProjection,
	compactTokens,
} from "../../../src/features/live-context/clear-projection.ts";

const originalMessage = {
	id: "m-7",
	role: "tool",
	toolCallId: "call_7",
	isError: false,
	source: { kind: "tool", callId: "call_7" },
	content: [{ type: "text", text: "line 1\nline 2\nline 3" }],
};

const BASE_SEQ = 3;

/** Build a contiguous event window from `BASE_SEQ`, as the host's fold supplies it. */
function context(overrides: { nodes?: number[]; events?: Record<number, unknown>; messages?: Map<number, unknown> } = {}) {
	const bySeq: Record<number, unknown> = {
		3: { type: "user/message", seq: 3, data: {} },
		7: { type: "tool/result", seq: 7, data: { message: originalMessage } },
		...overrides.events,
	};
	const last = Math.max(...Object.keys(bySeq).map(Number));
	const events: unknown[] = [];
	for (let seq = BASE_SEQ; seq <= last; seq += 1) events.push(bySeq[seq] ?? { type: "turn/start", seq, data: {} });
	return {
		nodes: overrides.nodes ?? [3, 7, 9],
		events,
		baseSeq: BASE_SEQ,
		messages: overrides.messages ?? new Map<number, unknown>(),
	};
}

const event = { seq: 12, type: CLEAR_EVENT_TYPE, data: { v: CLEAR_VERSION, targets: [{ seq: 7, label: "read /a.ts:1-3", tokens: 3_400 }] } };

test("placeholder is one line, names the pointer, and starts with the marker", () => {
	const text = clearPlaceholder("read /a.ts:1-3", 3_400);
	assert.equal(text, "[cleared 3.4k tok · read /a.ts:1-3 · re-read if needed]");
	assert.equal(text.includes("\n"), false);
	assert.equal(text.startsWith(CLEAR_PLACEHOLDER_PREFIX), true);
});

test("compactTokens keeps three significant digits and never invents precision", () => {
	assert.equal(compactTokens(0), "0 tok");
	assert.equal(compactTokens(999), "999 tok");
	assert.equal(compactTokens(1_234), "1.2k tok");
	assert.equal(compactTokens(73_646), "73.6k tok");
	assert.equal(compactTokens(120_000), "120k tok");
	assert.equal(compactTokens(Number.NaN), "? tok");
});

test("a valid decision replaces the body and preserves message identity", () => {
	const updates = clearProjection.project(event, context());
	assert.equal(updates.size, 1);
	const message = updates.get(7) as Record<string, unknown>;
	assert.equal(message.id, "m-7");
	assert.equal(message.role, "tool");
	assert.equal(message.toolCallId, "call_7");
	assert.equal(message.isError, false);
	assert.deepEqual(message.source, { kind: "tool", callId: "call_7" });
	assert.deepEqual(message.content, [{ type: "text", text: clearPlaceholder("read /a.ts:1-3", 3_400) }]);
});

test("the projection rewrites the current message, not the original event body", () => {
	const previouslyProjected = { ...originalMessage, content: [{ type: "text", text: "already shortened by another projection" }] };
	const updates = clearProjection.project(event, context({ messages: new Map([[7, previouslyProjected]]) }));
	const message = updates.get(7) as Record<string, unknown>;
	assert.deepEqual(message.content, [{ type: "text", text: clearPlaceholder("read /a.ts:1-3", 3_400) }]);
});

test("every malformed decision throws instead of being skipped", () => {
	const cases: { name: string; data: unknown; ctx?: ReturnType<typeof context> }[] = [
		{ name: "not an object", data: "nope" },
		{ name: "wrong version", data: { v: 99, targets: [{ seq: 7, label: "x", tokens: 1 }] } },
		{ name: "empty targets", data: { v: CLEAR_VERSION, targets: [] } },
		{ name: "target not an object", data: { v: CLEAR_VERSION, targets: [7] } },
		{ name: "negative seq", data: { v: CLEAR_VERSION, targets: [{ seq: -1, label: "x", tokens: 1 }] } },
		{ name: "empty label", data: { v: CLEAR_VERSION, targets: [{ seq: 7, label: "", tokens: 1 }] } },
		{ name: "oversized label", data: { v: CLEAR_VERSION, targets: [{ seq: 7, label: "x".repeat(201), tokens: 1 }] } },
		{ name: "negative tokens", data: { v: CLEAR_VERSION, targets: [{ seq: 7, label: "x", tokens: -1 }] } },
		{ name: "duplicate seq", data: { v: CLEAR_VERSION, targets: [{ seq: 7, label: "x", tokens: 1 }, { seq: 7, label: "y", tokens: 1 }] } },
		{ name: "not a tool result", data: { v: CLEAR_VERSION, targets: [{ seq: 3, label: "x", tokens: 1 }] } },
		{
			name: "empty body",
			data: { v: CLEAR_VERSION, targets: [{ seq: 7, label: "x", tokens: 1 }] },
			ctx: context({ events: { 7: { type: "tool/result", seq: 7, data: { message: { ...originalMessage, content: [{ type: "text", text: "" }] } } } } }),
		},
	];
	for (const { name, data, ctx } of cases) {
		assert.throws(() => clearProjection.project({ seq: 12, type: CLEAR_EVENT_TYPE, data }, ctx ?? context()), name);
	}
});

test("a target compaction removed is skipped, because nothing at that position is visible", () => {
	// The node is gone from the surface: refusing to load the session over a
	// pointer nobody can read would cost the whole transcript.
	const updates = clearProjection.project(event, context({ nodes: [3, 9] }));
	assert.equal(updates.size, 0);
});

test("a target an earlier decision already cleared is skipped, so replay converges", () => {
	const alreadyCleared = { ...originalMessage, content: [{ type: "text", text: clearPlaceholder("read /a.ts", 1) }] };
	const updates = clearProjection.project(event, context({ messages: new Map([[7, alreadyCleared]]) }));
	assert.equal(updates.size, 0);
});

test("a stale target does not stop its live siblings from being cleared", () => {
	const both = {
		seq: 12,
		type: CLEAR_EVENT_TYPE,
		data: {
			v: CLEAR_VERSION,
			targets: [
				{ seq: 8, label: "read /gone.ts", tokens: 900 },
				{ seq: 7, label: "read /a.ts:1-3", tokens: 3_400 },
			],
		},
	};
	const updates = clearProjection.project(both, context());
	assert.deepEqual([...updates.keys()], [7]);
});

test("the projection owns exactly one event type", () => {
	assert.equal(clearProjection.type, "plugin:oh-my-clm/clear");
});

test("a malformed target that is already stale is skipped, not fatal", () => {
	// Order matters: the session has to load, so applicability is decided before
	// the label/tokens checks — a record for a node compaction removed can never
	// be repaired and must not cost the transcript.
	const broken = {
		seq: 12,
		type: CLEAR_EVENT_TYPE,
		data: { v: CLEAR_VERSION, targets: [{ seq: 8, label: "", tokens: -1 }] },
	};
	assert.equal(clearProjection.project(broken, context({ nodes: [3, 7, 9] })).size, 0);
});

/**
 * Selector identity rides along so a resumed session can rebuild its re-read
 * evidence; it must not change the model-visible result at all.
 */
test("target keys are replay metadata and never reach the model", () => {
	const withKeys = {
		...event,
		data: {
			v: CLEAR_VERSION,
			targets: [{ seq: 7, label: "read /a.ts:1-3", tokens: 3_400, keys: ["read\u0000/a.ts"] }],
		},
	};
	const plain = clearProjection.project(event, context());
	const keyed = clearProjection.project(withKeys, context());
	assert.deepEqual([...keyed.keys()], [...plain.keys()]);
	assert.equal(JSON.stringify(keyed.get(7)), JSON.stringify(plain.get(7)));
	assert.equal(JSON.stringify(keyed.get(7)).includes("read\u0000/a.ts"), false);
	assert.equal(CLEAR_VERSION, 1, "an optional field must not need a version bump");
});
