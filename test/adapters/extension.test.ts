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
	// Same standard as the DSH section: the schema owns the API, so parameter
	// names, env switches, and repeated protocol detail stay out of the prompt.
	assert.doesNotMatch(prompt, /blockIds|skipRoles|CLM_EMPTY|CLM_CONTEXT_BUDGET|CLM_MAX_BLOCK_CHARS|CLM_MAX_MIRROR_CHARS|patch\.json/);
	assert.ok(prompt.length <= 900, `Pi live-context prompt grew to ${prompt.length} chars`);

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
		const nudgeText = result?.messages?.at(-1)?.content ?? "";
		assert.match(nudgeText, /<pi-clm-budget-nudge>/);
		assert.match(nudgeText, /context-only turn/);
		// The nudge names the tool, not the mirror path or protocol the system
		// prompt already carries; it is re-injected on every pressured request.
		assert.ok(!nudgeText.includes(sessionMirrorPath(sessionId)));
		assert.doesNotMatch(nudgeText, /CLM_SNAPSHOT|CLM_ENTRY/);
	} finally {
		if (previousBudget === undefined) delete process.env.CLM_CONTEXT_BUDGET;
		else process.env.CLM_CONTEXT_BUDGET = previousBudget;
	}
});
