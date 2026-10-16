import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import extension from "../extensions/clm.ts";

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
	const api = {
		on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
			handlers.set(name, handler);
			return () => undefined;
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
			commands.set(name, options);
		},
	};
	extension(api as any);

	const contextEntries = [
		...projection.entries.map((entry) => entry.sourceEntry),
	];
	const ctx = {
		cwd,
		hasUI: false,
		mode: "print",
		model: undefined,
		getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
		ui: {
			theme: { fg: (_name: string, value: string) => value },
			setStatus: () => undefined,
			notify: () => undefined,
		},
		sessionManager: {
			buildSessionProjection: () => projection,
			getBranch: () => contextEntries,
			getSessionId: () => "test-session",
		},
	};

	await handlers.get("context")?.({}, ctx);
	const mirrorPath = path.join(cwd, ".pi", "clm", "LIVE_CTX_MAIN.md");
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
	await commands.get("clm")?.handler("status", ctx);
});

test("session resume rebuilds the live mirror before the next model request", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-resume-"));
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
	};
	extension(api as any);
	const ctx = {
		cwd,
		hasUI: false,
		mode: "tui",
		model: undefined,
		getContextUsage: () => undefined,
		ui: { theme: { fg: (_name: string, value: string) => value }, setStatus: () => undefined, notify: () => undefined },
		sessionManager: {
			buildSessionProjection: () => projection,
			getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
			getSessionId: () => "resume-session",
		},
	};
	const mirrorPath = path.join(cwd, ".pi", "clm", "LIVE_CTX_MAIN.md");

	await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
	assert.match(fs.readFileSync(mirrorPath, "utf8"), /Old session answer\./);

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

	const mirror = fs.readFileSync(mirrorPath, "utf8");
	assert.match(mirror, /Resumed session answer\./);
	assert.doesNotMatch(mirror, /Old session answer\./);
});

test("turn_end replaces a tool result that read the live mirror", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-self-read-"));
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
	};
	extension(api as any);
	const ctx = {
		cwd,
		hasUI: false,
		mode: "print",
		model: undefined,
		getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
		ui: { theme: { fg: (_name: string, value: string) => value }, setStatus: () => undefined, notify: () => undefined },
		sessionManager: {
			buildSessionProjection: () => projection,
			getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
			getSessionId: () => "self-read-session",
		},
	};

	await handlers.get("context")?.({}, ctx);
	const result = await handlers.get("turn_end")?.(
		{
			entries: [],
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "self-read", name: "read", arguments: { path: ".pi/clm/LIVE_CTX_MAIN.md" } }],
			},
			toolResults: [
				{
					role: "toolResult",
					toolCallId: "self-read",
					content: [{ type: "text", text: "<!-- pi-clm-v2 -->\\n[[CLM_ENTRY id=old role=assistant]]" }],
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
	assert.deepEqual(edit?.replacement, { content: [{ type: "text", text: "[oh-my-clm] Live mirror read omitted from future context; the mirror is already available at .pi/clm/LIVE_CTX_MAIN.md." }] });
});

test("budget pressure uses an ephemeral nudge instead of a compact command", async () => {
	const previousBudget = process.env.CLM_CONTEXT_BUDGET;
	process.env.CLM_CONTEXT_BUDGET = "100";
	try {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-budget-nudge-"));
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
		};
		extension(api as any);

		const ctx = {
			cwd,
			hasUI: false,
			mode: "print",
			model: undefined,
			getContextUsage: () => undefined,
			ui: { theme: { fg: (_name: string, value: string) => value }, setStatus: () => undefined, notify: () => undefined },
			sessionManager: {
				buildSessionProjection: () => projection,
				getBranch: () => projection.entries.map((entry) => entry.sourceEntry),
				getSessionId: () => "budget-nudge-session",
			},
		};

		await handlers.get("session_start")?.({}, ctx);
		assert.equal(commands.has("clm-compact"), false);
		const result = await handlers.get("context")?.(
			{ messages: [{ role: "user", content: "x".repeat(1_000) }] },
			ctx,
		) as { messages?: Array<{ role: string; content: string }> } | undefined;
		assert.equal(result?.messages?.length, 2);
		assert.match(result?.messages?.at(-1)?.content ?? "", /<pi-clm-budget-nudge>/);
	} finally {
		if (previousBudget === undefined) delete process.env.CLM_CONTEXT_BUDGET;
		else process.env.CLM_CONTEXT_BUDGET = previousBudget;
	}
});
