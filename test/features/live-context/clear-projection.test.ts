import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	CLEAR_EVENT_TYPE,
	CLEAR_LABEL_MAX_CHARS,
	CLEAR_PLACEHOLDER_MAX_CHARS,
	CLEAR_PLACEHOLDER_PREFIX,
	CLEAR_PLACEHOLDER_V1_PREFIX,
	CLEAR_VERSION,
	clearPlaceholder,
	clearPlaceholderV1,
	clearProjection,
	compactTokens,
} from "../../../src/features/live-context/clear-projection.ts";

/**
 * A body the pointer has to be able to shrink. The projection refuses a clear
 * that would leave the model reading more text than it read before.
 */
const bodyText = Array.from({ length: 12 }, (_, index) => `line ${index + 1} of the tool result body`).join("\n");

const originalMessage = {
	id: "m-7",
	role: "tool",
	toolCallId: "call_7",
	isError: false,
	source: { kind: "tool", callId: "call_7" },
	content: [{ type: "text", text: bodyText }],
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

/** The pointer a writer stores with the decision; the projection prefers it. */
const pointer = clearPlaceholder("read /a.ts:1-3", 3_400);

const event = {
	seq: 12,
	type: CLEAR_EVENT_TYPE,
	data: { v: CLEAR_VERSION, targets: [{ seq: 7, label: "read /a.ts:1-3", tokens: 3_400, text: pointer }] },
};

/** A record written before the pointer carried its text. */
const legacyEvent = { seq: 12, type: CLEAR_EVENT_TYPE, data: { v: CLEAR_VERSION, targets: [{ seq: 7, label: "read /a.ts:1-3", tokens: 3_400 }] } };

test("placeholder is one line, names the tool and the size, and starts with the marker", () => {
	const text = clearPlaceholder("read /a.ts:1-3", 3_400);
	assert.equal(
		text,
		"[set aside to save space · read /a.ts:1-3 · you read its 3.4k tok in full at the time and wrote your later replies from it · re-read before editing]",
	);
	assert.equal(text.includes("\n"), false);
	assert.equal(text.startsWith(CLEAR_PLACEHOLDER_PREFIX), true);
});

/**
 * gnosh's pop receipt tells the model what to do next ("view a file before you
 * edit it"), not whether it feels like it. The placeholder is this project's
 * receipt: the instruction belongs under every cleared block because it binds to
 * the block's own target, while what the clear left behind is the same fact for
 * all of them and belongs in the per-turn index header, written once instead of
 * repeated under every block the model has to skim.
 */
test("the placeholder carries the clearing receipt, not just an invitation", () => {
	const text = clearPlaceholder("read /a.ts:1-3", 3_400);
	assert.match(text, /re-read before editing/);
	assert.doesNotMatch(text, /re-read if needed/);
	assert.doesNotMatch(text, /the user still sees/, "a per-turn fact is not repeated per block");
	assert.equal(text.includes("\n"), false);
});

/**
 * A pointer a model reads as "this call returned nothing" makes it disown the
 * answers it built on the result — a larger loss than the tokens the clear
 * saved. The line therefore says the result was there, that it was read, and
 * that it was set aside; it never says the output was cleared.
 */
test("the pointer says the result was read and set aside, not that it came back empty", () => {
	const text = clearPlaceholder("read /a.ts:1-3", 3_400);
	assert.match(text, /set aside to save space/);
	assert.match(text, /you read its 3\.4k tok in full at the time/);
	assert.match(text, /wrote your later replies from it/);
	assert.doesNotMatch(text, /\bcleared\b/, "a model takes 'cleared' to mean the call returned nothing");
	assert.doesNotMatch(text, /no longer available/);
	assert.doesNotMatch(text, /returned nothing/);
});

/**
 * A record that stores its text must replay to exactly those bytes, whatever the
 * running build's renderer says; a record that carries none is the v1 format and
 * replays through the frozen v1 renderer. Either way the model-visible copy of a
 * decided block cannot move when this file's wording changes.
 */
test("a stored pointer replays verbatim and a v1 record keeps the frozen wording", () => {
	const pinned = "[set aside to save space · read /a.ts:1-3 · an earlier build's sentence]";
	const stored = {
		...event,
		data: { v: CLEAR_VERSION, targets: [{ seq: 7, label: "read /a.ts:1-3", tokens: 3_400, text: pinned }] },
	};
	const storedMessage = clearProjection.project(stored, context()).get(7) as Record<string, unknown>;
	assert.deepEqual(storedMessage.content, [{ type: "text", text: pinned }]);

	const legacyMessage = clearProjection.project(legacyEvent, context()).get(7) as Record<string, unknown>;
	assert.deepEqual(legacyMessage.content, [{ type: "text", text: clearPlaceholderV1("read /a.ts:1-3", 3_400) }]);
	assert.equal(clearPlaceholderV1("read /a.ts:1-3", 3_400), "[cleared 3.4k tok · read /a.ts:1-3 · re-read before editing]");
	assert.equal(clearPlaceholderV1("read /a.ts:1-3", 3_400).startsWith(CLEAR_PLACEHOLDER_V1_PREFIX), true);
});

/**
 * The longest label the projection accepts is the worst case a writer can reach,
 * and the record bound has to leave room for it: a pointer past the bound makes
 * the record throw on replay, which takes the whole session log with it.
 */
test("the longest accepted label still yields a pointer inside the record bound", () => {
	const longest = clearPlaceholder("x".repeat(CLEAR_LABEL_MAX_CHARS), 1_000);
	assert.ok(
		longest.length <= CLEAR_PLACEHOLDER_MAX_CHARS,
		`a ${longest.length}-character pointer exceeds the ${CLEAR_PLACEHOLDER_MAX_CHARS}-character record bound`,
	);
});

/**
 * Every path that rewrites the model-visible copy has to strictly shrink it. A
 * body no longer than the pointer that would replace it is not dead weight —
 * replacing it would add text the model pays for on every later request. The
 * projection owns the check because a replayed record carries the decision, not
 * the body it was originally written against.
 */
test("a body the pointer would not shrink is left visible", () => {
	const pointer = clearPlaceholder("read /a.ts:1-3", 3_400);
	const bodyOf = (text: string) => ({
		...originalMessage,
		content: [{ type: "text", text }],
	});
	const window = (text: string) =>
		context({ events: { 7: { type: "tool/result", seq: 7, data: { message: bodyOf(text) } } } });

	assert.equal(clearProjection.project(event, window("x".repeat(pointer.length))).size, 0, "an equal body does not shrink");
	assert.equal(clearProjection.project(event, window("x".repeat(pointer.length - 1))).size, 0, "a shorter body would grow");
	assert.equal(clearProjection.project(event, window("x".repeat(pointer.length + 1))).size, 1, "a longer body still shrinks");
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
	assert.deepEqual(message.content, [{ type: "text", text: pointer }]);
});

test("the projection rewrites the current message, not the original event body", () => {
	const previouslyProjected = { ...originalMessage, content: [{ type: "text", text: `already shortened by another projection\n${bodyText}` }] };
	const updates = clearProjection.project(event, context({ messages: new Map([[7, previouslyProjected]]) }));
	const message = updates.get(7) as Record<string, unknown>;
	assert.deepEqual(message.content, [{ type: "text", text: pointer }]);
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
		{ name: "text is not a string", data: { v: CLEAR_VERSION, targets: [{ seq: 7, label: "x", tokens: 1, text: 7 }] } },
		{ name: "empty text", data: { v: CLEAR_VERSION, targets: [{ seq: 7, label: "x", tokens: 1, text: "" }] } },
		{ name: "text with a newline", data: { v: CLEAR_VERSION, targets: [{ seq: 7, label: "x", tokens: 1, text: "[set aside\nmore]" }] } },
		{ name: "oversized text", data: { v: CLEAR_VERSION, targets: [{ seq: 7, label: "x", tokens: 1, text: "x".repeat(CLEAR_PLACEHOLDER_MAX_CHARS + 1) }] } },
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
				{ seq: 7, label: "read /a.ts:1-3", tokens: 3_400, text: pointer },
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
			targets: [{ seq: 7, label: "read /a.ts:1-3", tokens: 3_400, text: pointer, keys: ["read\u0000/a.ts"] }],
		},
	};
	const plain = clearProjection.project(event, context());
	const keyed = clearProjection.project(withKeys, context());
	assert.deepEqual([...keyed.keys()], [...plain.keys()]);
	assert.equal(JSON.stringify(keyed.get(7)), JSON.stringify(plain.get(7)));
	assert.equal(JSON.stringify(keyed.get(7)).includes("read\u0000/a.ts"), false);
	assert.equal(CLEAR_VERSION, 1, "an optional field must not need a version bump");
});
