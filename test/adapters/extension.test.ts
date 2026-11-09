import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sessionMirrorPath } from "../../src/lib/clm-paths.ts";
import extension from "../../extensions/clm.ts";

test("extension mirrors a projection and emits persistent context edits at turn_end", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-"));
	const projection = {
		entries: [
			{
				sourceEntry: { id: "task", type: "message" },
				messages: [{ role: "user", content: "Keep the repository task." }],
			},
			{
				sourceEntry: { id: "assistant-1", type: "message" },
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "text", text: "I inspected the repository." },
							{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
						],
					},
				],
			},
			{
				sourceEntry: { id: "tool-1", type: "message" },
				messages: [
					{
						role: "toolResult",
						toolCallId: "call-1",
						content: [{ type: "text", text: "Large output" }],
						isError: false,
					},
				],
			},
		],
		messages: [],
	};
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const tools = new Map<string, any>();
	const api = {
		on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
			handlers.set(name, handler);
			return () => undefined;
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
			commands.set(name, options);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
	};
	extension(api as any);

	const contextEntries = [
		...projection.entries.map((entry) => entry.sourceEntry),
	];
	const sessionId = "test-session";
	let notified = "";
	const ctx = {
		cwd,
		hasUI: true,
		mode: "print",
		model: undefined,
		getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
		ui: {
			notify: (message: string) => { notified = message; },
		},
		sessionManager: {
			buildSessionProjection: () => projection,
			getBranch: () => contextEntries,
			getSessionId: () => sessionId,
		},
	};

	const beforeStart = { systemPromptOptions: {} as Record<string, string> };
	await handlers.get("before_agent_start")?.(beforeStart, ctx);
	const prompt = beforeStart.systemPromptOptions.appendSystemPrompt ?? "";
	assert.ok(prompt.includes(sessionMirrorPath(sessionId)));
	assert.match(prompt, /cleanup/);
	// Rewriting a tool-call block is the cheapest way to fold a tool turn: the
	// paired result leaves with it, so the fact goes in that block's body.
	assert.match(prompt, /also omits its tool result/);
	// "step" is the unit that matters: Pi commits at the end of each step, so the
	// cheapest fold window is the previous step of the same user turn. "turn"
	// reads as the whole user turn and closes that window.
	assert.match(prompt, /from the step you are still producing/);
	assert.doesNotMatch(prompt, /rewrite the turn you are still in/);
	// Same standard as the DSH section: the schema owns the API, so parameter
	// names, env switches, and repeated protocol detail stay out of the prompt.
	assert.doesNotMatch(prompt, /blockIds|skipRoles|CLM_EMPTY|CLM_CONTEXT_BUDGET|CLM_MAX_BLOCK_CHARS|CLM_MAX_MIRROR_CHARS|patch\.json/);
	assert.ok(prompt.length <= 1000, `Pi live-context prompt grew to ${prompt.length} chars`);

	await handlers.get("context")?.({}, ctx);
	const mirrorPath = sessionMirrorPath(sessionId);
	assert.equal(fs.existsSync(path.join(cwd, ".pi", "clm", "LIVE_CTX_MAIN.md")), false);
	const mirror = fs.readFileSync(mirrorPath, "utf8");
	assert.match(mirror, /CLM_ENTRY id=1 role=assistant/);
	assert.match(mirror, /CLM_ENTRY id=2 role=toolResult/);
	assert.doesNotMatch(mirror, /CLM_ENTRY id=task/);

	const edited = mirror
		.replace("I inspected the repository.\nread {\"path\":\"README.md\"}", "The repository was inspected.")
		.replace(/\n\n\[\[CLM_ENTRY id=2 role=toolResult\]\][\s\S]*$/, "\n");
	fs.writeFileSync(mirrorPath, edited, "utf8");

	const result = await handlers.get("turn_end")?.({ entries: [] }, ctx) as { entries: Array<Record<string, unknown>> };
	assert.ok(result);
	assert.ok(result.entries.some((entry) => entry.type === "context_edit" && entry.targetId === "assistant-1"));
	assert.ok(result.entries.some((entry) => entry.type === "context_edit" && entry.targetId === "tool-1" && entry.replacement === null));

	assert.ok(commands.has("clm"));
	assert.ok(tools.has("cleanup"));
	assert.equal(tools.get("cleanup")?.executionMode, "sequential");
	await commands.get("clm")?.handler("status", ctx);
	assert.ok(notified.includes(mirrorPath));
});

// docs/plan.md §5.1 / case 10 (red): the Pi appendix must carry the same
// "when to clean" trigger condition as DSH, and must not simultaneously tell
// the model to "do not read or print the file" and to "rewrite only from a
// complete current body" — you cannot rewrite a body you never read (I-7).
// Both are currently true of the appendix, so these assertions are expected
// to fail until §5.1 is implemented.
test("plan §5.1 (case 10, Pi): appendix states when to clean and drops the self-read contradiction", () => {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	const api = {
		on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
			handlers.set(name, handler);
			return () => undefined;
		},
		registerCommand: () => undefined,
		registerTool: () => undefined,
	};
	extension(api as any);
	const beforeStart = { systemPromptOptions: {} as Record<string, string> };
	const ctx = {
		cwd: fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-")),
		hasUI: false,
		mode: "print",
		model: undefined,
		getContextUsage: () => undefined,
		ui: { notify: () => undefined },
		sessionManager: { getSessionId: () => "plan-5-1-pi" },
	};
	handlers.get("before_agent_start")?.(beforeStart, ctx);
	const prompt = beforeStart.systemPromptOptions.appendSystemPrompt ?? "";
	assert.match(
		prompt,
		/(?:sub-question|subtask|子任务|收到清理候选|cleanup candidate|complet\w+ (?:a )?(?:sub)?task|at .{0,24}boundar\w*|(?:when|once|after) .{0,80}cleanup)/i,
		"Pi appendix must carry an explicit cleanup trigger condition (§5.1)",
	);
	const selfReadContradiction =
		/do not read or print the file/i.test(prompt) &&
		/rewrite only from a (?:block's )?complete current body/i.test(prompt);
	assert.equal(
		selfReadContradiction,
		false,
		"Pi appendix must not forbid reading the file while requiring a complete current body (§5.1 / I-7)",
	);
	assert.ok(prompt.length <= 1000, `Pi live-context prompt grew to ${prompt.length} chars`);
});

test("Pi cleanup removes selected mirror spans in one tool execution", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-cleanup-tool-"));
	const sessionId = "cleanup-tool-session";
	const projection = {
		entries: [
			{ sourceEntry: { id: "task", type: "message" }, messages: [{ role: "user", content: "Keep the task." }] },
			{ sourceEntry: { id: "anchor", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: "Anchor block." }] }] },
			{ sourceEntry: { id: "noise", type: "message" }, messages: [{ role: "user", content: "Self-referential noise." }] },
			{ sourceEntry: { id: "fact", type: "message" }, messages: [{ role: "user", content: "Retain this fact." }] },
		],
		messages: [],
	};
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	const tools = new Map<string, any>();
	const api = {
		on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
			handlers.set(name, handler);
			return () => undefined;
		},
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand: () => undefined,
	};
	extension(api as any);
	const ctx = {
		cwd,
		hasUI: false,
		mode: "print",
		model: undefined,
		getContextUsage: () => undefined,
		ui: { notify: () => undefined },
		sessionManager: {
			buildSessionProjection: () => projection,
			getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
			getSessionId: () => sessionId,
		},
	};

	await handlers.get("session_start")?.({}, ctx);
	await handlers.get("context")?.({ messages: [] }, ctx);
	const tool = tools.get("cleanup");

	// The read-only drill-down answers from the projection and changes nothing.
	const listed = await tool.execute("cleanup-list-1", { list: "1-3" }, undefined, undefined, ctx);
	assert.equal(listed.isError, false);
	assert.equal(listed.structuredContent?.status, "listed");
	assert.match(listed.content?.[0]?.text ?? "", /^<oh-my-clm-block-list>\nRead-only rows for IDs 1-3; nothing was removed\./);
	assert.match(listed.structuredContent?.rows ?? "", /\n2\. user: Self-referential noise\./);
	assert.match(fs.readFileSync(sessionMirrorPath(sessionId), "utf8"), /Self-referential noise/);

	const result = await tool.execute("cleanup-1", { blockIds: [2] }, undefined, undefined, ctx);
	assert.equal(result.isError, false);
	assert.deepEqual(result.structuredContent?.removedBlockIds, [2]);
	const mirrorPath = sessionMirrorPath(sessionId);
	const mirror = fs.readFileSync(mirrorPath, "utf8");
	assert.match(mirror, /CLM_ENTRY id=1 role=assistant/);
	assert.doesNotMatch(mirror, /Self-referential noise/);
	assert.match(mirror, /Retain this fact/);

	const turnEnd = await handlers.get("turn_end")?.({ entries: [] }, ctx) as { entries: Array<Record<string, unknown>> };
	assert.ok(turnEnd.entries.some((entry) => entry.type === "context_edit" && entry.targetId === "noise" && entry.replacement === null));
});

test("Pi cleanup refreshes a mirror that predates the current assistant message", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-cleanup-refresh-"));
	const sessionId = "cleanup-refresh-session";
	const projection = {
		entries: [
			{ sourceEntry: { id: "task", type: "message" }, messages: [{ role: "user", content: "Keep the task." }] },
			{ sourceEntry: { id: "anchor", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: "Anchor block." }] }] },
			{ sourceEntry: { id: "noise", type: "message" }, messages: [{ role: "user", content: "Stale tool noise." }] },
		],
		messages: [],
	};
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	const tools = new Map<string, any>();
	const api = {
		on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
			handlers.set(name, handler);
			return () => undefined;
		},
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand: () => undefined,
	};
	extension(api as any);
	const ctx = {
		cwd,
		hasUI: false,
		mode: "print",
		model: undefined,
		getContextUsage: () => undefined,
		ui: { notify: () => undefined },
		sessionManager: {
			buildSessionProjection: () => projection,
			getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
			getSessionId: () => sessionId,
		},
	};

	await handlers.get("session_start")?.({}, ctx);
	await handlers.get("context")?.({ messages: [] }, ctx);
	const mirrorPath = sessionMirrorPath(sessionId);
	assert.doesNotMatch(fs.readFileSync(mirrorPath, "utf8"), /Cleaning up the noise/);

	// Pi appends the assistant message that carries the cleanup tool call after
	// the request-time mirror write. The file is therefore one message behind the
	// projection when the tool runs; cleanup must re-render instead of rejecting.
	projection.entries.push({
		sourceEntry: { id: "assistant-now", type: "message" },
		messages: [{ role: "assistant", content: [{ type: "text", text: "Cleaning up the noise now." }] }],
	});

	const tool = tools.get("cleanup");
	const result = await tool.execute("cleanup-refresh-1", { blockIds: [2] }, undefined, undefined, ctx);
	assert.equal(result.isError, false);
	assert.equal(result.structuredContent?.status, "applied");
	assert.deepEqual(result.structuredContent?.removedBlockIds, [2]);
	const mirror = fs.readFileSync(mirrorPath, "utf8");
	assert.doesNotMatch(mirror, /Stale tool noise/);
	assert.match(mirror, /Cleaning up the noise now/);
});

test("Pi cleanup keeps an uncommitted mirror edit instead of re-rendering over it", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-cleanup-guard-"));
	const sessionId = "cleanup-guard-session";
	const projection = {
		entries: [
			{ sourceEntry: { id: "task", type: "message" }, messages: [{ role: "user", content: "Keep the task." }] },
			{ sourceEntry: { id: "anchor", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: "Anchor block." }] }] },
			{ sourceEntry: { id: "noise", type: "message" }, messages: [{ role: "user", content: "Stale tool noise." }] },
		],
		messages: [],
	};
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	const tools = new Map<string, any>();
	const api = {
		on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
			handlers.set(name, handler);
			return () => undefined;
		},
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand: () => undefined,
	};
	extension(api as any);
	const ctx = {
		cwd,
		hasUI: false,
		mode: "print",
		model: undefined,
		getContextUsage: () => undefined,
		ui: { notify: () => undefined },
		sessionManager: {
			buildSessionProjection: () => projection,
			getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
			getSessionId: () => sessionId,
		},
	};

	await handlers.get("session_start")?.({}, ctx);
	await handlers.get("context")?.({ messages: [] }, ctx);
	const mirrorPath = sessionMirrorPath(sessionId);
	const mirror = fs.readFileSync(mirrorPath, "utf8");
	const edited = mirror.replace("Anchor block.", "Anchor block, model-edited.");
	assert.notEqual(edited, mirror);
	fs.writeFileSync(mirrorPath, edited);

	// The file no longer equals the last render, so cleanup must plan against the
	// on-disk text instead of refreshing the mirror and dropping the edit.
	const result = await tools.get("cleanup").execute("cleanup-guard-1", { blockIds: [2] }, undefined, undefined, ctx);
	assert.equal(result.structuredContent?.status, "applied");
	const after = fs.readFileSync(mirrorPath, "utf8");
	assert.doesNotMatch(after, /Stale tool noise/);
	assert.match(after, /Anchor block, model-edited\./);
});

test("Pi cleanup explains a mirror that an earlier edit already moved this step", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-cleanup-order-"));
	const sessionId = "cleanup-order-session";
	const projection = {
		entries: [
			{ sourceEntry: { id: "task", type: "message" }, messages: [{ role: "user", content: "Keep the task." }] },
			{ sourceEntry: { id: "anchor", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: "Anchor block." }] }] },
			{ sourceEntry: { id: "noise", type: "message" }, messages: [{ role: "user", content: "Stale tool noise." }] },
		],
		messages: [] as unknown[],
	};
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	const tools = new Map<string, any>();
	const api = {
		on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
			handlers.set(name, handler);
			return () => undefined;
		},
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand: () => undefined,
	};
	extension(api as any);
	const ctx = {
		cwd,
		hasUI: false,
		mode: "print",
		model: undefined,
		getContextUsage: () => undefined,
		ui: { notify: () => undefined },
		sessionManager: {
			buildSessionProjection: () => projection,
			getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
			getSessionId: () => sessionId,
		},
	};

	await handlers.get("session_start")?.({}, ctx);
	await handlers.get("context")?.({ messages: [] }, ctx);
	const mirrorPath = sessionMirrorPath(sessionId);
	const mirror = fs.readFileSync(mirrorPath, "utf8");
	fs.writeFileSync(mirrorPath, mirror.replace("Anchor block.", "Anchor block, model-edited."));

	// The mirror edit is now uncommitted and Pi has appended this turn's assistant
	// message, so the file's snapshot can no longer match the live projection.
	// Cleanup cannot reconcile that safely; it must say so instead of "stale".
	projection.entries.push({
		sourceEntry: { id: "turn-assistant", type: "message" },
		messages: [{ role: "assistant", content: [{ type: "text", text: "Working on it." }] }],
	});
	const result = await tools.get("cleanup").execute("cleanup-order-1", { blockIds: [2] }, undefined, undefined, ctx);
	assert.equal(result.structuredContent?.status, "rejected");
	assert.equal(result.isError, true);
	assert.match(result.structuredContent?.reason ?? "", /at most one cleanup per step/);
	assert.match(result.structuredContent?.reason ?? "", /before any mirror edit/);
	const after = fs.readFileSync(mirrorPath, "utf8");
	assert.match(after, /Anchor block, model-edited\./);
	assert.match(after, /Stale tool noise/);
});

test("session resume rebuilds the live mirror before the next model request", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-resume-"));
	let sessionId = "resume-session-old";
	let projection = {
		entries: [
			{
				sourceEntry: { id: "task", type: "message" },
				messages: [{ role: "user", content: "Keep the task." }],
			},
			{
				sourceEntry: { id: "assistant-old", type: "message" },
				messages: [{ role: "assistant", content: [{ type: "text", text: "Old session answer." }] }],
			},
		],
		messages: [],
	};
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	const api = {
		on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
			handlers.set(name, handler);
			return () => undefined;
		},
		registerCommand: () => undefined,
		registerTool: () => undefined,
	};
	extension(api as any);
	const ctx = {
		cwd,
		hasUI: false,
		mode: "tui",
		model: undefined,
		getContextUsage: () => undefined,
		ui: { notify: () => undefined },
		sessionManager: {
			buildSessionProjection: () => projection,
			getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
			getSessionId: () => sessionId,
		},
	};
	const oldMirrorPath = sessionMirrorPath(sessionId);

	await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
	assert.match(fs.readFileSync(oldMirrorPath, "utf8"), /Old session answer\./);

	sessionId = "resume-session-new";
	projection = {
		entries: [
			{
				sourceEntry: { id: "task", type: "message" },
				messages: [{ role: "user", content: "Keep the task." }],
			},
			{
				sourceEntry: { id: "assistant-resumed", type: "message" },
				messages: [{ role: "assistant", content: [{ type: "text", text: "Resumed session answer." }] }],
			},
		],
		messages: [],
	};
	await handlers.get("session_start")?.({ type: "session_start", reason: "resume", previousSessionFile: "old.jsonl" }, ctx);

	const mirrorPath = sessionMirrorPath(sessionId);
	const mirror = fs.readFileSync(mirrorPath, "utf8");
	assert.match(mirror, /Resumed session answer\./);
	assert.doesNotMatch(mirror, /Old session answer\./);
	assert.match(fs.readFileSync(oldMirrorPath, "utf8"), /Old session answer\./);
});

test("turn_end replaces a tool result that read the live mirror", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-self-read-"));
	const sessionId = "self-read-session";
	const mirrorPath = sessionMirrorPath(sessionId);
	const projection = {
		entries: [
			{
				sourceEntry: { id: "task", type: "message" },
				messages: [{ role: "user", content: "Keep the repository task." }],
			},
		],
		messages: [],
	};
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	const api = {
		on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
			handlers.set(name, handler);
			return () => undefined;
		},
		registerCommand: () => undefined,
		registerTool: () => undefined,
	};
	extension(api as any);
	const ctx = {
		cwd,
		hasUI: false,
		mode: "print",
		model: undefined,
		getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
		ui: { notify: () => undefined },
		sessionManager: {
			buildSessionProjection: () => projection,
			getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
			getSessionId: () => sessionId,
		},
	};

	await handlers.get("context")?.({}, ctx);
	const result = await handlers.get("turn_end")?.(
		{
			entries: [],
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "self-read", name: "read", arguments: { path: mirrorPath } }],
			},
			toolResults: [
				{
					role: "toolResult",
					toolCallId: "self-read",
					content: [{ type: "text", text: "<!-- clm-v2 -->\\n[[CLM_ENTRY id=old role=assistant]]" }],
					isError: false,
				},
			],
			toolResultEntryIds: ["tool-self-read"],
			messageEntryId: "assistant-self-read",
		},
		ctx,
	) as { entries: Array<Record<string, unknown>> };

	assert.ok(result.entries.some((entry) => entry.type === "context_edit" && entry.targetId === "tool-self-read"));
	const edit = result.entries.find((entry) => entry.type === "context_edit" && entry.targetId === "tool-self-read");
	assert.deepEqual(edit?.replacement, { content: [{ type: "text", text: `[oh-my-clm] Live mirror read omitted from future context; the mirror is already available at ${mirrorPath}.` }] });
});

test("budget pressure uses an ephemeral nudge instead of a compact command", async () => {
	const previousBudget = process.env.CLM_CONTEXT_BUDGET;
	process.env.CLM_CONTEXT_BUDGET = "100";
	try {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-budget-nudge-"));
		const sessionId = "budget-nudge-session";
		const projection = {
			entries: [
				{
					sourceEntry: { id: "task", type: "message" },
					messages: [{ role: "user", content: "Keep the task." }],
				},
				{
					sourceEntry: { id: "old-answer", type: "message" },
					messages: [{ role: "assistant", content: [{ type: "text", text: "An old answer." }] }],
				},
			],
			messages: [],
		};
		const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
		const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
		const api = {
			on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
				handlers.set(name, handler);
				return () => undefined;
			},
			registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
				commands.set(name, options);
			},
			registerTool: () => undefined,
		};
		extension(api as any);

		const ctx = {
			cwd,
			hasUI: false,
			mode: "print",
			model: undefined,
			getContextUsage: () => undefined,
			ui: { notify: () => undefined },
			sessionManager: {
				buildSessionProjection: () => projection,
				getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
				getSessionId: () => sessionId,
			},
		};

		await handlers.get("session_start")?.({}, ctx);
		assert.equal(commands.has("clm-compact"), false);
		const result = await handlers.get("context")?.(
			{ messages: [{ role: "user", content: "x".repeat(1_000) }] },
			ctx,
		) as { messages?: Array<{ role: string; content: string }> } | undefined;
		assert.equal(result?.messages?.length, 2);
		assert.equal(result?.messages?.at(-1)?.role, "system");
		const nudgeText = result?.messages?.at(-1)?.content ?? "";
		assert.match(nudgeText, /<pi-clm-budget-nudge>/);
		// Since §5.3 the nudge rides along with the task instead of claiming the
		// whole turn, so it must not read as a stop order.
		assert.doesNotMatch(nudgeText, /context-only turn/i);
		assert.doesNotMatch(nudgeText, /do no task work/i);
		assert.match(nudgeText, /cleanup/);
		// The nudge names the tool, not the mirror path or protocol the system
		// prompt already carries; it is re-injected on every pressured request.
		assert.ok(!nudgeText.includes(sessionMirrorPath(sessionId)));
		assert.doesNotMatch(nudgeText, /CLM_SNAPSHOT|CLM_ENTRY/);
	} finally {
		if (previousBudget === undefined) delete process.env.CLM_CONTEXT_BUDGET;
		else process.env.CLM_CONTEXT_BUDGET = previousBudget;
	}
});

test("an empty assistant message does not warn on an unchanged mirror", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-empty-message-"));
	const sessionId = "empty-message-session";
	const projection = {
		entries: [
			{ sourceEntry: { id: "task", type: "message" }, messages: [{ role: "user", content: "Keep the task." }] },
			{ sourceEntry: { id: "answer", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: "A real answer." }] }] },
			// Pi appends an aborted or errored assistant turn as `content: []`; it
			// renders as an empty CLM_ENTRY and must not look like a deletion.
			{ sourceEntry: { id: "aborted", type: "message" }, messages: [{ role: "assistant", content: [] }] },
		],
		messages: [],
	};
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	const notifications: Array<{ message: string; type?: string }> = [];
	const api = {
		on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
			handlers.set(name, handler);
			return () => undefined;
		},
		registerTool: () => undefined,
		registerCommand: () => undefined,
	};
	extension(api as any);
	const ctx = {
		cwd,
		hasUI: true,
		mode: "print",
		model: undefined,
		getContextUsage: () => undefined,
		ui: { notify: (message: string, type?: string) => { notifications.push({ message, type }); } },
		sessionManager: {
			buildSessionProjection: () => projection,
			getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
			getSessionId: () => sessionId,
		},
	};

	await handlers.get("session_start")?.({}, ctx);
	await handlers.get("context")?.({ messages: [] }, ctx);
	const result = await handlers.get("turn_end")?.({ entries: [] }, ctx);
	assert.equal(result, undefined, "an unchanged mirror must be a noop");
	assert.deepEqual(notifications, [], "no warning for an empty canonical message");
});

test("Pi tells the model when a mirror edit was rejected", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-reject-"));
	const sessionId = "reject-notice-session";
	const projection = {
		entries: [
			{ sourceEntry: { id: "task", type: "message" }, messages: [{ role: "user", content: "Keep the task." }] },
			{ sourceEntry: { id: "anchor", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: "Anchor block." }] }] },
		],
		messages: [],
	};
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	const notifications: string[] = [];
	const api = {
		on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
			handlers.set(name, handler);
			return () => undefined;
		},
		registerTool: () => undefined,
		registerCommand: () => undefined,
	};
	extension(api as any);
	const ctx = {
		cwd,
		hasUI: true,
		mode: "print",
		model: undefined,
		getContextUsage: () => undefined,
		ui: { notify: (message: string) => { notifications.push(message); } },
		sessionManager: {
			buildSessionProjection: () => projection,
			getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
			getSessionId: () => sessionId,
		},
	};

	await handlers.get("session_start")?.({}, ctx);
	await handlers.get("context")?.({ messages: [] }, ctx);
	const mirrorPath = sessionMirrorPath(sessionId);
	const stale = fs.readFileSync(mirrorPath, "utf8").replace(/CLM_SNAPSHOT [a-f0-9]{16}/, "CLM_SNAPSHOT 0000000000000000");
	fs.writeFileSync(mirrorPath, stale, "utf8");

	await handlers.get("turn_end")?.({ entries: [] }, ctx);
	assert.ok(notifications.some((message) => /rejected/i.test(message)));

	const next = await handlers.get("context")?.({ messages: [] }, ctx) as { messages: Array<{ content: unknown }> } | undefined;
	assert.ok(next, "the rejected edit must be reported on the next request");
	const notice = next.messages.map((message) => String(message.content)).find((content) => content.includes("<pi-clm-edit-notice>"));
	assert.ok(notice, "expected an edit notice message");
	assert.match(notice, /rejected/);
	// This reason already ends in a period; the notice must not double it.
	assert.match(notice, /rejected: The mirror snapshot is stale; refresh it before editing context\. The mirror was restored/);
	assert.ok(!String(notice).includes(".."), "the notice must not end a reason with two periods");
	// The notice is one-shot: an unchanged request no longer carries it.
	const after = await handlers.get("context")?.({ messages: [] }, ctx) as { messages: unknown[] } | undefined;
	assert.equal(after, undefined);
});

test("Pi gives a reason without a period a sentence break in the edit notice", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-reject-plain-"));
	const sessionId = "reject-notice-plain-session";
	const projection = {
		entries: [
			{ sourceEntry: { id: "task", type: "message" }, messages: [{ role: "user", content: "Keep the task." }] },
			{ sourceEntry: { id: "anchor", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: "Anchor block." }] }] },
		],
		messages: [],
	};
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	const api = {
		on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
			handlers.set(name, handler);
			return () => undefined;
		},
		registerTool: () => undefined,
		registerCommand: () => undefined,
	};
	extension(api as any);
	const ctx = {
		cwd,
		hasUI: true,
		mode: "print",
		model: undefined,
		getContextUsage: () => undefined,
		ui: { notify: () => undefined },
		sessionManager: {
			buildSessionProjection: () => projection,
			getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
			getSessionId: () => sessionId,
		},
	};

	await handlers.get("session_start")?.({}, ctx);
	await handlers.get("context")?.({ messages: [] }, ctx);
	const mirrorPath = sessionMirrorPath(sessionId);
	// A block the projection never had: rejected with "Unknown CLM_ENTRY ids are
	// not allowed: 99", a reason with no trailing period.
	fs.writeFileSync(
		mirrorPath,
		fs.readFileSync(mirrorPath, "utf8") + "\n[[CLM_ENTRY id=99 role=assistant]]\nhidden\n[[/CLM_ENTRY id=99]]\n",
		"utf8",
	);

	await handlers.get("turn_end")?.({ entries: [] }, ctx);

	const next = await handlers.get("context")?.({ messages: [] }, ctx) as { messages: Array<{ content: unknown }> } | undefined;
	const notice = next?.messages.map((message) => String(message.content)).find((content) => content.includes("<pi-clm-edit-notice>"));
	assert.ok(notice, "expected an edit notice message");
	// Without normalization this reads "... allowed: 99 The mirror was restored".
	assert.match(notice, /rejected: Unknown CLM_ENTRY ids are not allowed: 99\. The mirror was restored/);
});

test("Pi cleanup removes a block while a neighbour body quotes markers", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-quoted-"));
	const sessionId = "quoted-marker-session";
	const quoted = "The mirror said:\n[[CLM_ENTRY id=3 role=user]]\n[[/CLM_ENTRY id=3]]";
	const projection = {
		entries: [
			{ sourceEntry: { id: "task", type: "message" }, messages: [{ role: "user", content: "Keep the task." }] },
			{ sourceEntry: { id: "anchor", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: quoted }] }] },
			{ sourceEntry: { id: "noise", type: "message" }, messages: [{ role: "user", content: "Remove this noise." }] },
		],
		messages: [],
	};
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	const tools = new Map<string, any>();
	const api = {
		on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
			handlers.set(name, handler);
			return () => undefined;
		},
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand: () => undefined,
	};
	extension(api as any);
	const ctx = {
		cwd,
		hasUI: false,
		mode: "print",
		model: undefined,
		getContextUsage: () => undefined,
		ui: { notify: () => undefined },
		sessionManager: {
			buildSessionProjection: () => projection,
			getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
			getSessionId: () => sessionId,
		},
	};

	await handlers.get("session_start")?.({}, ctx);
	await handlers.get("context")?.({ messages: [] }, ctx);
	const mirrorPath = sessionMirrorPath(sessionId);
	assert.match(fs.readFileSync(mirrorPath, "utf8"), /\\\[\[CLM_ENTRY id=3 role=user\]\]/);

	const result = await tools.get("cleanup").execute("cleanup-quoted", { blockIds: [2] }, undefined, undefined, ctx);
	assert.equal(result.isError, false, result.content?.[0]?.text);
	assert.deepEqual(result.structuredContent?.removedBlockIds, [2]);

	const mirror = fs.readFileSync(mirrorPath, "utf8");
	assert.doesNotMatch(mirror, /Remove this noise/);
	assert.match(mirror, /\\\[\[CLM_ENTRY id=3 role=user\]\]/);
	assert.equal(fs.existsSync(mirrorPath), true);
});

// docs/plan.md §3 case 8 / I-1: extension state must be keyed per session. A
// one-shot notice left by session A must not surface in session B's request.
test("plan §3.8 (I-1): interleaved sessions do not share the pending notice", async () => {
	const previousBudget = process.env.CLM_CONTEXT_BUDGET;
	delete process.env.CLM_CONTEXT_BUDGET;
	try {
		const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
		const api = {
			on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
				handlers.set(name, handler);
				return () => undefined;
			},
			registerCommand: () => undefined,
			registerTool: () => undefined,
		};
		extension(api as any);

		const projection = {
			entries: [
				{ sourceEntry: { id: "task", type: "message" }, messages: [{ role: "user", content: "Keep the task." }] },
				{ sourceEntry: { id: "old-answer", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: "An old answer." }] }] },
			],
			messages: [],
		};
		const noticesA: string[] = [];
		const makeCtx = (sessionId: string, hasUI: boolean, collect?: (message: string) => void) => ({
			cwd: fs.mkdtempSync(path.join(os.tmpdir(), `oh-my-clm-ms-${sessionId}-`)),
			hasUI,
			mode: "print",
			model: undefined,
			getContextUsage: () => undefined,
			ui: { notify: collect ?? (() => undefined) },
			sessionManager: {
				buildSessionProjection: () => projection,
				getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
				getSessionId: () => sessionId,
			},
		});
		const ctxA = makeCtx("plan-ms-a", true, (message) => noticesA.push(message));
		const ctxB = makeCtx("plan-ms-b", true);

		await handlers.get("context")?.({ messages: [] }, ctxA);
		// A rejected edit leaves a one-shot notice in the extension state.
		const mirrorPathA = sessionMirrorPath("plan-ms-a");
		fs.writeFileSync(
			mirrorPathA,
			fs.readFileSync(mirrorPathA, "utf8").replace(/CLM_SNAPSHOT [a-f0-9]{16}/, "CLM_SNAPSHOT 0000000000000000"),
			"utf8",
		);
		await handlers.get("turn_end")?.({ entries: [] }, ctxA);
		assert.ok(noticesA.some((message) => /rejected/i.test(message)), "session A should have produced a rejection notice");

		const resultB = await handlers.get("context")?.({ messages: [] }, ctxB) as
			{ messages?: Array<{ role: string; content: string }> } | undefined;
		const leaked = (resultB?.messages ?? []).some((message) => String(message.content).includes("<pi-clm-edit-notice>"));
		assert.equal(leaked, false, "session A's pending notice must not be delivered to session B");
	} finally {
		if (previousBudget === undefined) delete process.env.CLM_CONTEXT_BUDGET;
		else process.env.CLM_CONTEXT_BUDGET = previousBudget;
	}
});

// docs/plan.md §3 case 9 / I-2: the budget nudge needs a stop condition. It is
// synthetic and never written to session history, so its own marker guard can
// never see a previous nudge and it repeats indefinitely without progress.
test("plan §3.9 (I-2): repeated no-progress nudge rounds are bounded", async () => {
	const previousBudget = process.env.CLM_CONTEXT_BUDGET;
	process.env.CLM_CONTEXT_BUDGET = "100";
	try {
		const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
		const api = {
			on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
				handlers.set(name, handler);
				return () => undefined;
			},
			registerCommand: () => undefined,
			registerTool: () => undefined,
		};
		extension(api as any);
		const projection = {
			entries: [
				{ sourceEntry: { id: "task", type: "message" }, messages: [{ role: "user", content: "Keep the task." }] },
				{ sourceEntry: { id: "old-answer", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: "An old answer." }] }] },
			],
			messages: [],
		};
		const ctx = {
			cwd: fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-nudge-loop-")),
			hasUI: false,
			mode: "print",
			model: undefined,
			getContextUsage: () => undefined,
			ui: { notify: () => undefined },
			sessionManager: {
				buildSessionProjection: () => projection,
				getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
				getSessionId: () => "plan-nudge-session",
			},
		};
		await handlers.get("session_start")?.({}, ctx);
		// Each new request sees the same history: the synthetic nudge is not part
		// of it, so `messages.some(contains marker)` can never short-circuit.
		const messages = [{ role: "user", content: "x".repeat(1_000) }];
		let nudges = 0;
		for (let round = 0; round < 5; round += 1) {
			const result = await handlers.get("context")?.({ messages }, ctx) as
				{ messages?: Array<{ role: string; content: string }> } | undefined;
			nudges += (result?.messages ?? []).filter((message) => String(message.content).includes("<pi-clm-budget-nudge>")).length;
		}
		assert.ok(nudges <= 2, `nudge needs a stop condition: emitted ${nudges} times across 5 identical rounds`);
	} finally {
		if (previousBudget === undefined) delete process.env.CLM_CONTEXT_BUDGET;
		else process.env.CLM_CONTEXT_BUDGET = previousBudget;
	}
});

// P1-1 follow-up: normalizeText() trims trailing whitespace, which sets a
// renderText that hides nothing. That common case must still produce a
// context_edit at turn_end instead of a rejection notice.
test("Pi mirror rewrites a block whose preview was only whitespace-normalized", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-normalized-preview-"));
	const sessionId = "normalized-preview-session";
	const projection = {
		entries: [
			{
				sourceEntry: { id: "task", type: "message" },
				messages: [{ role: "user", content: "Keep the task." }],
			},
			{
				sourceEntry: { id: "answer", type: "message" },
				messages: [{ role: "assistant", content: [{ type: "text", text: "A normal assistant answer.\n" }] }],
			},
		],
		messages: [],
	};
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	const api = {
		on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
			handlers.set(name, handler);
			return () => undefined;
		},
		registerCommand: () => undefined,
		registerTool: () => undefined,
	};
	extension(api as any);
	const ctx = {
		cwd,
		hasUI: false,
		mode: "print",
		model: undefined,
		getContextUsage: () => undefined,
		ui: { notify: () => undefined },
		sessionManager: {
			buildSessionProjection: () => projection,
			getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
			getSessionId: () => sessionId,
		},
	};

	await handlers.get("session_start")?.({}, ctx);
	await handlers.get("context")?.({ messages: [] }, ctx);
	const mirrorPath = sessionMirrorPath(sessionId);
	const mirror = fs.readFileSync(mirrorPath, "utf8");
	assert.doesNotMatch(mirror, /preview truncated|Self-referential/, "nothing was hidden from the model");
	const edited = mirror.replace("A normal assistant answer.", "Short answer.");
	assert.notEqual(edited, mirror);
	fs.writeFileSync(mirrorPath, edited, "utf8");

	const result = await handlers.get("turn_end")?.({ entries: [] }, ctx) as
		{ entries: Array<Record<string, unknown>> } | undefined;
	assert.ok(
		result?.entries.some((entry) => entry.type === "context_edit" && entry.targetId === "answer" && entry.replacement !== null),
		"a fully visible block must still be folded by a model edit",
	);
});

// I-2 follow-up: hitting the nudge cap must not make the loop permanently deaf.
// The "budget pressure is gone" reset has to run before the stop check, so a
// later high-pressure episode gets a fresh budget after a real shrink.
test("plan I-2 follow-up: a low-pressure round resets an exhausted nudge loop", async () => {
	const previousBudget = process.env.CLM_CONTEXT_BUDGET;
	process.env.CLM_CONTEXT_BUDGET = "100000";
	try {
		const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
		const api = {
			on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
				handlers.set(name, handler);
				return () => undefined;
			},
			registerCommand: () => undefined,
			registerTool: () => undefined,
		};
		extension(api as any);
		const projection = {
			entries: [
				{ sourceEntry: { id: "task", type: "message" }, messages: [{ role: "user", content: "Keep the task." }] },
				{ sourceEntry: { id: "a1", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: "An old answer." }] }] },
			],
			messages: [],
		};
		const ctx = {
			cwd: fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-nudge-reset-")),
			hasUI: false,
			mode: "print",
			model: undefined,
			getContextUsage: () => undefined,
			ui: { notify: () => undefined },
			sessionManager: {
				buildSessionProjection: () => projection,
				getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
				getSessionId: () => "nudge-reset-session",
			},
		};
		await handlers.get("session_start")?.({}, ctx);
		const high = [{ role: "user", content: "x".repeat(300_000) }];
		const low: unknown[] = [];
		const countNudges = async (messages: unknown[]) => {
			const result = await handlers.get("context")?.({ messages }, ctx) as
				{ messages?: Array<{ role: string; content: string }> } | undefined;
			return (result?.messages ?? []).filter((message) => String(message.content).includes("<pi-clm-budget-nudge>")).length;
		};

		assert.equal(await countNudges(high), 1, "first high-pressure round nudges");
		assert.equal(await countNudges(high), 1, "second high-pressure round nudges");
		assert.equal(await countNudges(high), 0, "the cap stops a third consecutive nudge");
		assert.equal(await countNudges(low), 0, "a low-pressure round emits no nudge but resets state");
		assert.equal(await countNudges(high), 1, "a later high-pressure episode gets a fresh loop budget");
	} finally {
		if (previousBudget === undefined) delete process.env.CLM_CONTEXT_BUDGET;
		else process.env.CLM_CONTEXT_BUDGET = previousBudget;
	}
});

// docs/plan.md §5.3 / case 12: the Pi nudge must fold into the same request as
// a system line carrying the §5.2 candidate format, and never add a turn or ask
// the model to stop its task work. Since the §5.6 calibration the window is no
// longer a trigger basis, so this fixture fires because its settled turns pay
// for their own prefix break — no CLM_CONTEXT_BUDGET required.
test("plan §5.3 (case 12, Pi): pressure folds a candidate into the same request", async () => {
	const previousBudget = process.env.CLM_CONTEXT_BUDGET;
	delete process.env.CLM_CONTEXT_BUDGET;
	try {
		const projection = {
			entries: [
				{ sourceEntry: { id: "task", type: "message" }, messages: [{ role: "user", content: "Keep the task." }] },
				{ sourceEntry: { id: "u1", type: "message" }, messages: [{ role: "user", content: "First request." }] },
				// Settled turns must be big enough that deleting one saves more than the
				// one-time prefix break costs; a 4-token answer is not worth rewriting.
				{ sourceEntry: { id: "a1", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: `First answer: ${"A".repeat(4_000)}` }] }] },
				{ sourceEntry: { id: "u2", type: "message" }, messages: [{ role: "user", content: "Second request." }] },
				{ sourceEntry: { id: "a2", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: `Second answer: ${"B".repeat(4_000)}` }] }] },
				{ sourceEntry: { id: "u3", type: "message" }, messages: [{ role: "user", content: "The current request." }] },
			],
			messages: [],
		};
		const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
		const api = {
			on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
				handlers.set(name, handler);
				return () => undefined;
			},
			registerCommand: () => undefined,
			registerTool: () => undefined,
		};
		extension(api as any);
		const ctx = {
			cwd: fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-plan-5-3-")),
			hasUI: false,
			mode: "print",
			model: undefined,
			// No env budget: the host window alone must be enough to fire.
			getContextUsage: () => ({ tokens: 92_000, contextWindow: 100_000, percent: 92 }),
			ui: { notify: () => undefined },
			sessionManager: {
				buildSessionProjection: () => projection,
				getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
				getSessionId: () => "plan-5-3-pi",
			},
		};
		await handlers.get("session_start")?.({}, ctx);
		const messages = [
			{ role: "user", content: "First request." },
			{ role: "assistant", content: "First answer." },
			{ role: "user", content: "Second request." },
			{ role: "assistant", content: "Second answer." },
			{ role: "user", content: "The current request." },
		];
		const result = await handlers.get("context")?.({ messages }, ctx) as
			{ messages?: Array<{ role: string; content: string }> } | undefined;

		// Same request, no extra assistant turn, and the history is untouched.
		assert.equal(result?.messages?.length, messages.length + 1);
		assert.deepEqual(result?.messages?.slice(0, messages.length), messages);
		assert.equal(result?.messages?.at(-1)?.role, "system", "the nudge must stay a system-role line (P1-3)");
		const nudgeText = result?.messages?.at(-1)?.content ?? "";
		assert.match(nudgeText, /<pi-clm-budget-nudge>/);
		// The §5.2 payload: visible usage plus a confirmable candidate.
		assert.match(nudgeText, /Usage: 92k\/100k tokens \(92%\)/);
		assert.match(
			nudgeText,
			/Suggested cleanup \(best range pays back: net ~\d+ tok at r = 2%\): cleanup\(\{ ranges: \["\d+(?:-\d+)?"\], skipRoles: \["user"\] \}\)/,
		);
		// The old shape spent a whole turn on the cleanup; the new one folds it
		// into the task, so neither "context-only turn" nor a stop order appears.
		assert.doesNotMatch(nudgeText, /context-only turn/i);
		assert.doesNotMatch(nudgeText, /\bstop\b/i);
		assert.doesNotMatch(nudgeText, /do no task work/i);
		assert.equal(result?.messages?.filter((message) => message.role === "assistant").length, messages.filter((message) => message.role === "assistant").length);
	} finally {
		if (previousBudget === undefined) delete process.env.CLM_CONTEXT_BUDGET;
		else process.env.CLM_CONTEXT_BUDGET = previousBudget;
	}
});

// docs/plan.md §5.3: the stop condition from I-2 stays, but a *progressive*
// round must earn a fresh budget rather than being capped forever. This pins
// the four-piece contract together with the same-request shape.
test("plan §5.3 (case 12, Pi): an offloaded usage line names the step and the loop still stops", async () => {
	const previousBudget = process.env.CLM_CONTEXT_BUDGET;
	process.env.CLM_CONTEXT_BUDGET = "100000";
	try {
		const projection = {
			entries: [
				{ sourceEntry: { id: "task", type: "message" }, messages: [{ role: "user", content: "Keep the task." }] },
				{ sourceEntry: { id: "a1", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: "An old answer." }] }] },
			],
			messages: [],
		};
		const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
		const api = {
			on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
				handlers.set(name, handler);
				return () => undefined;
			},
			registerCommand: () => undefined,
			registerTool: () => undefined,
		};
		extension(api as any);
		const ctx = {
			cwd: fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-plan-5-3-loop-")),
			hasUI: false,
			mode: "print",
			model: undefined,
			getContextUsage: () => undefined,
			ui: { notify: () => undefined },
			sessionManager: {
				buildSessionProjection: () => projection,
				getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
				getSessionId: () => "plan-5-3-loop",
			},
		};
		await handlers.get("session_start")?.({}, ctx);
		const high = [{ role: "user", content: "x".repeat(300_000) }];
		const countNudges = async (messages: unknown[]) => {
			const result = await handlers.get("context")?.({ messages }, ctx) as
				{ messages?: Array<{ role: string; content: string }> } | undefined;
			return (result?.messages ?? []).filter((message) => String(message.content).includes("<pi-clm-budget-nudge>")).length;
		};
		assert.equal(await countNudges(high), 1, "first pressured request folds the candidate in");
		assert.equal(await countNudges(high), 1, "second pressured request still nudges");
		assert.equal(await countNudges(high), 0, "two no-progress rounds stop the loop");
		assert.equal(await countNudges([]), 0, "pressure gone resets state without a nudge");
		assert.equal(await countNudges(high), 1, "a later pressured episode gets a fresh budget");
	} finally {
		if (previousBudget === undefined) delete process.env.CLM_CONTEXT_BUDGET;
		else process.env.CLM_CONTEXT_BUDGET = previousBudget;
	}
});

// Review follow-up: with an explicit CLM_CONTEXT_BUDGET below the host window,
// the decision uses the budget, so the line and the signal must use it too. The
// old copy read "usage 15% ≥ 75%" because the signal divided by the window.
test("plan §5.3 review: an explicit budget below the host window stays self-consistent", async () => {
	const previousBudget = process.env.CLM_CONTEXT_BUDGET;
	process.env.CLM_CONTEXT_BUDGET = "32000";
	try {
		const projection = {
			entries: [
				{ sourceEntry: { id: "task", type: "message" }, messages: [{ role: "user", content: "Keep the task." }] },
				{ sourceEntry: { id: "a1", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: "An old answer." }] }] },
				{ sourceEntry: { id: "u2", type: "message" }, messages: [{ role: "user", content: "A settled request." }] },
				{ sourceEntry: { id: "a2", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: "A settled answer. " + "Y".repeat(50_000) }] }] },
				{ sourceEntry: { id: "u3", type: "message" }, messages: [{ role: "user", content: "The open request." }] },
			],
			messages: [],
		};
		const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
		const api = {
			on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
				handlers.set(name, handler);
				return () => undefined;
			},
			registerCommand: () => undefined,
			registerTool: () => undefined,
		};
		extension(api as any);
		const ctx = {
			cwd: fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-plan-5-3-budget-")),
			hasUI: false,
			mode: "print",
			model: undefined,
			// Exact usage from a 200k window, but the budget is 32k: the trigger is
			// the budget, so every rendered percentage has to use it.
			getContextUsage: () => ({ tokens: 30_000, contextWindow: 200_000, percent: 15 }),
			ui: { notify: () => undefined },
			sessionManager: {
				buildSessionProjection: () => projection,
				getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
				getSessionId: () => "plan-5-3-budget",
			},
		};
		await handlers.get("session_start")?.({}, ctx);
		const result = await handlers.get("context")?.({ messages: [{ role: "user", content: "hi" }] }, ctx) as
			{ messages?: Array<{ role: string; content: string }> } | undefined;
		const nudgeText = result?.messages?.at(-1)?.content ?? "";
		assert.match(nudgeText, /<pi-clm-budget-nudge>/);
		assert.match(nudgeText, /Usage: 30k\/32k tokens \(94%\)/, "the budget is the target, not the window");
		assert.match(nudgeText, /Suggested cleanup \(usage 94% ≥ 75%\)/);
		// A percentage that could not have fired must never be rendered: 15% was the
		// old (window-based) reading of the same 30k tokens.
		assert.doesNotMatch(nudgeText, /usage 15%/);
		assert.doesNotMatch(nudgeText, /usage (?:[0-9]|[1-6][0-9])% ≥ 75%/);
	} finally {
		if (previousBudget === undefined) delete process.env.CLM_CONTEXT_BUDGET;
		else process.env.CLM_CONTEXT_BUDGET = previousBudget;
	}
});

// docs/plan.md §5.6 calibration (2026-11-09, real deepseek-flash session):
// the host window is 1,000,000 tokens and the session sat at 119.5k, i.e. 12%.
// "75% of the window" is unreachable, so the window must stop being the Pi
// trigger basis; a range that pays for its own prefix break should be.
test("plan §5.6 (calibration): a paying candidate nudges without any budget or window pressure", async () => {
	const previous = process.env.CLM_CONTEXT_BUDGET;
	delete process.env.CLM_CONTEXT_BUDGET;
	try {
		const projection = {
			entries: [
				{ sourceEntry: { id: "task", type: "message" }, messages: [{ role: "user", content: "Keep the task." }] },
				{ sourceEntry: { id: "u1", type: "message" }, messages: [{ role: "user", content: "First request." }] },
				{ sourceEntry: { id: "a1", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: `First answer: ${"A".repeat(4_000)}` }] }] },
				{ sourceEntry: { id: "u2", type: "message" }, messages: [{ role: "user", content: "Second request." }] },
				{ sourceEntry: { id: "a2", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: `Second answer: ${"B".repeat(4_000)}` }] }] },
				{ sourceEntry: { id: "u3", type: "message" }, messages: [{ role: "user", content: "The current request." }] },
			],
			messages: [],
		};
		const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
		const api = {
			on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
				handlers.set(name, handler);
				return () => undefined;
			},
			registerCommand: () => undefined,
			registerTool: () => undefined,
		};
		extension(api as any);
		const ctx = {
			cwd: fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-calibration-")),
			hasUI: false,
			mode: "print",
			model: { contextWindow: 1_000_000 },
			// The measured session: 119.5k of a 1M window.
			getContextUsage: () => ({ tokens: 119_494, contextWindow: 1_000_000, percent: 12 }),
			ui: { notify: () => undefined },
			sessionManager: {
				buildSessionProjection: () => projection,
				getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
				getSessionId: () => "calibration-1m",
			},
		};
		await handlers.get("session_start")?.({}, ctx);
		const messages = [
			{ role: "user", content: "First request." },
			{ role: "assistant", content: `First answer: ${"A".repeat(4_000)}` },
			{ role: "user", content: "Second request." },
			{ role: "assistant", content: `Second answer: ${"B".repeat(4_000)}` },
			{ role: "user", content: "The current request." },
		];
		const result = await handlers.get("context")?.({ messages }, ctx) as
			{ messages?: Array<{ role: string; content: string }> } | undefined;
		const nudgeText = result?.messages?.at(-1)?.content ?? "";
		assert.match(nudgeText, /<pi-clm-budget-nudge>/, "a paying range is a trigger on its own");
		assert.match(nudgeText, /Suggested cleanup \(/, "the payload is the candidate, not an open question");
		// No budget was set, so no percentage could have fired: the old copy would
		// have said "usage 12% >= 75%" or stayed silent.
		assert.doesNotMatch(nudgeText, /≥ 75%/);
		assert.doesNotMatch(nudgeText, /usage 12%/);
	} finally {
		if (previous === undefined) delete process.env.CLM_CONTEXT_BUDGET;
		else process.env.CLM_CONTEXT_BUDGET = previous;
	}
});

// The same 1M-window shape with nothing that pays back must stay silent: at
// r = 0.02 an old settled turn's rent is worth 2%, so breaking its prefix costs
// more than it saves (measured payback 85-1742 turns on the real session).
test("plan §5.6 (calibration): a 1M window with no paying range stays silent", async () => {
	const previous = process.env.CLM_CONTEXT_BUDGET;
	delete process.env.CLM_CONTEXT_BUDGET;
	try {
		const projection = {
			entries: [
				{ sourceEntry: { id: "task", type: "message" }, messages: [{ role: "user", content: "Keep the task." }] },
				{ sourceEntry: { id: "u1", type: "message" }, messages: [{ role: "user", content: "An old request." }] },
				{ sourceEntry: { id: "a1", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: "An old answer." }] }] },
				{ sourceEntry: { id: "u2", type: "message" }, messages: [{ role: "user", content: "A bigger later request." }] },
				{ sourceEntry: { id: "a2", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: "Z".repeat(20_000) }] }] },
				{ sourceEntry: { id: "u3", type: "message" }, messages: [{ role: "user", content: "The current request." }] },
				// The open turn is already large, so every settled range sits under
				// a suffix bigger than the rent it saves.
				{ sourceEntry: { id: "a3", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: "Y".repeat(20_000) }] }] },
			],
			messages: [],
		};
		const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
		const api = {
			on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
				handlers.set(name, handler);
				return () => undefined;
			},
			registerCommand: () => undefined,
			registerTool: () => undefined,
		};
		extension(api as any);
		const ctx = {
			cwd: fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-calibration-quiet-")),
			hasUI: false,
			mode: "print",
			model: { contextWindow: 1_000_000 },
			getContextUsage: () => ({ tokens: 119_494, contextWindow: 1_000_000, percent: 12 }),
			ui: { notify: () => undefined },
			sessionManager: {
				buildSessionProjection: () => projection,
				getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
				getSessionId: () => "calibration-quiet",
			},
		};
		await handlers.get("session_start")?.({}, ctx);
		const messages = [
			{ role: "user", content: "An old request." },
			{ role: "assistant", content: "An old answer." },
			{ role: "user", content: "A bigger later request." },
			{ role: "assistant", content: "Z".repeat(20_000) },
			{ role: "user", content: "The current request." },
			{ role: "assistant", content: "Y".repeat(20_000) },
		];
		const result = await handlers.get("context")?.({ messages }, ctx) as
			{ messages?: Array<{ role: string; content: string }> } | undefined;
		assert.equal(result, undefined, "nothing to confirm means nothing to say");
	} finally {
		if (previous === undefined) delete process.env.CLM_CONTEXT_BUDGET;
		else process.env.CLM_CONTEXT_BUDGET = previous;
	}
});

// docs/plan.md §5.4 / case 13: the Pi landing path is the same relay as
// omission — cleanup rewrites the mirror, then turn_end commits one
// `context_edit` with replacement content instead of `null`.
test("plan §5.4 (case 13, Pi): offload rewrites the mirror body and commits a replace edit", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-offload-"));
	const sessionId = "offload-session";
	const projection = {
		entries: [
			{ sourceEntry: { id: "task", type: "message" }, messages: [{ role: "user", content: "Keep the task." }] },
			{ sourceEntry: { id: "anchor", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: "Anchor block." }] }] },
			{ sourceEntry: { id: "noise", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: "A long stale analysis of an old failure that no longer matters." }] }] },
			{ sourceEntry: { id: "fact", type: "message" }, messages: [{ role: "user", content: "Retain this fact." }] },
		],
		messages: [],
	};
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	const tools = new Map<string, any>();
	const api = {
		on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
			handlers.set(name, handler);
			return () => undefined;
		},
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand: () => undefined,
	};
	extension(api as any);
	const ctx = {
		cwd,
		hasUI: false,
		mode: "print",
		model: undefined,
		getContextUsage: () => undefined,
		ui: { notify: () => undefined },
		sessionManager: {
			buildSessionProjection: () => projection,
			getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
			getSessionId: () => sessionId,
		},
	};
	await handlers.get("session_start")?.({}, ctx);
	await handlers.get("context")?.({ messages: [] }, ctx);

	const result = await tools.get("cleanup")
		.execute("cleanup-offload-1", { offload: [{ blockId: 2, note: "Old failure: fixed in 0.1.13." }] }, undefined, undefined, ctx);
	assert.equal(result.isError, false);
	assert.deepEqual(result.structuredContent?.removedBlockIds, []);
	assert.deepEqual(result.structuredContent?.offloadedBlockIds, [2]);

	const mirrorPath = sessionMirrorPath(sessionId);
	const mirror = fs.readFileSync(mirrorPath, "utf8");
	assert.match(mirror, /\[\[CLM_ENTRY id=2 role=assistant\]\]\n\[offloaded: Old failure: fixed in 0\.1\.13\.\]\n\[\[\/CLM_ENTRY id=2\]\]/);
	assert.doesNotMatch(mirror, /A long stale analysis/);
	assert.match(mirror, /Retain this fact/);
	assert.match(mirror, /CLM_SNAPSHOT/);

	const turnEnd = await handlers.get("turn_end")?.({ entries: [] }, ctx) as { entries: Array<Record<string, unknown>> };
	const edit = turnEnd.entries.find((entry) => entry.type === "context_edit" && entry.targetId === "noise");
	assert.ok(edit, "an offload must commit a context edit, not leave the mirror only");
	assert.deepEqual(edit?.replacement, { content: [{ type: "text", text: "[offloaded: Old failure: fixed in 0.1.13.]" }] });
});
