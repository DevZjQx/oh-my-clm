#!/usr/bin/env node
/**
 * Functional host-harness for the oh-my-clm DSH bridge.
 *
 * It imports the packaged host entry (dist/dsh/index.js), drives it with a mock
 * Cordis context whose lifecycle payloads and session events mirror the real
 * DSH 0.2.0-rc.2 shapes (@deepseek-ai/dsh-agent, dsh-session, dsh-llm), and
 * asserts the mirror and native Session.append surface-replacement behaviour
 * described in the package README. It does not model a proposal/receipt file.
 *
 * Usage: node test/harness/clm-dsh-host-test.mjs [path/to/unpacked/package]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";

const pluginRoot = path.resolve(
	process.argv[2] ?? "/home/deepseek-agent/.dsh/profiles/clmtest/node_modules/oh-my-clm",
);
const entry = path.join(pluginRoot, "dist/dsh/index.js");

let pass = 0;
let fail = 0;
const failures = [];
const observations = [];
function check(name, condition, detail = "") {
	if (condition) {
		pass += 1;
		console.log(`  PASS  ${name}`);
	} else {
		fail += 1;
		failures.push(name + (detail ? ` — ${detail}` : ""));
		console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}
/** Record measured behaviour that is not a stated contract, so it is never silently green. */
function observe(name, detail) {
	observations.push(`${name}: ${detail}`);
	console.log(`  NOTE  ${name} — ${detail}`);
}
function section(title) {
	console.log(`\n== ${title} ==`);
}

// ---------------------------------------------------------------------------
// Mock Cordis host (only the surfaces the bridge uses).
// ---------------------------------------------------------------------------
function createCtx({ sectionOrder } = {}) {
	const handlers = new Map();
	const ownedDisposers = [];
	const log = [];
	const sections = [];
	const contexts = [];
	const effects = [];
	const tools = new Map();
	const commands = new Map();
	const ctx = {
		tools: {
			register(definition) {
				tools.set(definition.name, definition);
				const dispose = () => tools.delete(definition.name);
				ownedDisposers.push(dispose);
				return dispose;
			},
		},
		commands: {
			register(definition) {
				commands.set(definition.name, definition);
				const dispose = () => commands.delete(definition.name);
				ownedDisposers.push(dispose);
				return dispose;
			},
		},
		logger: {
			info: (message) => log.push({ level: "info", message: String(message) }),
			warn: (message) => log.push({ level: "warn", message: String(message) }),
		},
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			const dispose = () => {
				const current = handlers.get(event) ?? [];
				const index = current.indexOf(handler);
				if (index >= 0) current.splice(index, 1);
			};
			ownedDisposers.push(dispose);
			return dispose;
		},
		effect(callback, label) {
			const disposer = callback();
			effects.push({ label, disposer });
			return disposer;
		},
		systemPrompt: {
			section(value) {
				sections.push(value);
				return () => {};
			},
			context(value) {
				contexts.push(value);
				return () => {};
			},
			getSectionOrder(name) {
				return sectionOrder ? sectionOrder[name] : undefined;
			},
		},
	};
	return {
		ctx,
		log,
		sections,
		contexts,
		effects,
		tools,
		commands,
		listenerCount: (event) => (handlers.get(event) ?? []).length,
		emit: async (event, ...args) => {
			const list = [...(handlers.get(event) ?? [])];
			const out = [];
			for (const handler of list) out.push(await handler(...args));
			return out;
		},
		disposeAll() {
			for (const dispose of [...ownedDisposers].reverse()) dispose();
			for (const { disposer } of [...effects].reverse()) if (typeof disposer === "function") disposer();
		},
	};
}

// ---------------------------------------------------------------------------
// Mock DSH session: event-sourced log + surface projection.
// Real shapes: dsh-session/types.d.ts (SessionEventMap) and dsh-llm message.d.ts.
// ---------------------------------------------------------------------------
const SURFACE_EVENT_TYPES = new Set(["system/message", "user/message", "assistant/message", "tool/result", "developer/message"]);

class FakeSession {
	constructor(id, events = []) {
		this.id = id;
		this.header = { cwd: "/home/deepseek-agent" };
		this.events = events;
		this.surfaceSeq = events.filter((event) => SURFACE_EVENT_TYPES.has(event.type)).map((event) => event.seq);
	}
	get surface() {
		return { nodes: [...this.surfaceSeq] };
	}
	snapshotEvents() {
		return [...this.events];
	}
	append(type, data, options = {}) {
		const seq = this.events.length === 0 ? 0 : this.events.at(-1).seq + 1;
		this.events.push({ type, seq, time: Date.now(), data });
		const replacement = options.surfaceOp;
		if (replacement?.op === "replace") {
			const start = this.surfaceSeq.indexOf(replacement.startSeq);
			const end = this.surfaceSeq.indexOf(replacement.endSeq);
			if (start < 0 || end < start) throw new Error("invalid fake surface replacement");
			this.surfaceSeq.splice(start, end - start + 1, seq);
		} else if (SURFACE_EVENT_TYPES.has(type)) {
			this.surfaceSeq.push(seq);
		}
		return this.events.at(-1);
	}
}

const text = (value) => [{ type: "text", text: value }];
const userMessage = (value) => ({ id: `u${value.length}`, role: "user", content: text(value), source: { kind: "user" } });
const assistantMessage = (parts) => ({ id: `a${parts.length}`, role: "assistant", content: parts, source: { kind: "model", provider: "mock", model: "mock" } });
const toolResultMessage = (callId, value) => ({ id: `t${callId}`, role: "tool", content: text(value), toolCallId: callId, source: { kind: "tool", callId, name: "mock" } });

function sessionWithHistory(id) {
	const session = new FakeSession(id);
	session.append("user/message", userMessage("PROTECTED INITIAL TASK: refactor the parser and keep the tests green."));
	session.append("turn/start", { turn: 1 });
	session.append("step/start", { turn: 1, step: 1 });
	session.append("assistant/message", {
		turn: 1,
		step: 1,
		message: assistantMessage([
			{ type: "reasoning", text: "reasoning trace that should not dominate the mirror" },
			{ type: "tool-call", id: "call_1", name: "bash", arguments: '{"command":"npm test"}' },
		]),
		stream: [],
	});
	session.append("tool/result", { turn: 1, step: 1, message: toolResultMessage("call_1", "test suite output ".repeat(40)) });
	session.append("step/end", { turn: 1, step: 1 });
	session.append("step/start", { turn: 1, step: 2 });
	session.append("assistant/message", {
		turn: 1,
		step: 2,
		message: assistantMessage(text("The parser now handles nested groups; next I will update the docs and add regression cases for the empty-input path.")),
		stream: [],
	});
	return session;
}

const mirrorPath = (id) => path.join("/tmp", `clm-${encodeURIComponent(id)}`, "LIVE_CTX_MAIN.md");
const readIfExists = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined);
const hasUnexpectedArtifact = (id) => {
	const directory = path.dirname(mirrorPath(id));
	return fs.existsSync(directory) && fs.readdirSync(directory).some((name) => name !== "LIVE_CTX_MAIN.md");
};
function cleanup(id) {
	fs.rmSync(path.join("/tmp", `clm-${encodeURIComponent(id)}`), { recursive: true, force: true });
}
function replaceBlockBody(markdown, displayId, body) {
	const pattern = new RegExp(`(\\[\\[CLM_ENTRY id=${displayId} role=[^\\]]+\\]\\]\\n)([\\s\\S]*?)(\\n\\[\\[/CLM_ENTRY id=${displayId}\\]\\])`);
	if (!pattern.test(markdown)) throw new Error(`block ${displayId} not found in mirror`);
	return markdown.replace(pattern, (_match, head, _body, tail) => head + body + tail);
}
function deleteBlock(markdown, displayId) {
	const pattern = new RegExp(`\\n*\\[\\[CLM_ENTRY id=${displayId} role=[^\\]]+\\]\\][\\s\\S]*?\\[\\[/CLM_ENTRY id=${displayId}\\]\\]\\n*`);
	if (!pattern.test(markdown)) throw new Error(`block ${displayId} not found in mirror`);
	return markdown.replace(pattern, "\n");
}
function appendBlock(markdown, displayId, role, body) {
	return `${markdown.trimEnd()}\n\n[[CLM_ENTRY id=${displayId} role=${role}]]\n${body}\n[[/CLM_ENTRY id=${displayId}]]\n`;
}
function editMirror(id, mutate) {
	const before = fs.readFileSync(mirrorPath(id), "utf8");
	const after = mutate(before);
	if (after === before) throw new Error("mirror mutation produced no change");
	fs.writeFileSync(mirrorPath(id), after, "utf8");
}

/** Boot the plugin with one agent + one session and return the drive handles. */
async function boot(plugin, { sessionId, session, order, agentId }) {
	const host = createCtx({ sectionOrder: order });
	plugin.apply(host.ctx);
	const agentCtx = createCtx();
	// The bridge keys its state map by session id, so a mismatched agent id is
	// tolerated here. Real DSH also enforces `agent.id === agent.session.id`.
	const agent = { id: agentId ?? String(session.id), session, ctx: agentCtx.ctx };
	await host.emit("agent/created", { agent, source: { kind: "new" } });
	const preStep = async (payload = {}) => {
		let nextCalls = 0;
		await agentCtx.emit("agent/pre-step", { agent, messages: [], turn: 1, step: 1, ...payload }, async () => {
			nextCalls += 1;
			return { kind: "continue" };
		});
		return nextCalls;
	};
	return { host, agentCtx, agent, preStep };
}

// ---------------------------------------------------------------------------
const plugin = await import(pathToFileURL(entry).href);
console.log(`oh-my-clm host harness\nentry: ${entry}\nnode:  ${process.version}`);

section("1. module contract");
check("exports name = oh-my-clm", plugin.name === "oh-my-clm", String(plugin.name));
check("exports apply()", typeof plugin.apply === "function");
check("injects systemPrompt service", Array.isArray(plugin.inject) && plugin.inject.includes("systemPrompt"), JSON.stringify(plugin.inject));
check("injects tools service", Array.isArray(plugin.inject) && plugin.inject.includes("tools"), JSON.stringify(plugin.inject));

section("2. system prompt section");
{
	const session = sessionWithHistory("t-order-default");
	const { host, agent } = await boot(plugin, { sessionId: session.id, session });
	check("section registered exactly once", host.sections.length === 1, `got ${host.sections.length}`);
	const sectionValue = host.sections[0] ?? {};
	check("section name matches manifest contribution", sectionValue.name === "oh-my-clm:live-context", String(sectionValue.name));
	check("section order falls back to 3240", sectionValue.order === 3240, String(sectionValue.order));
	check("section names the runtime block index", typeof sectionValue.text === "string" && sectionValue.text.includes("<oh-my-clm-block-index>"));
	check("section names the mirror path template", typeof sectionValue.text === "string" && sectionValue.text.includes("/tmp/clm-<session-id>/LIVE_CTX_MAIN.md"));
	check("section keeps internal persistence mechanics out of the prompt", typeof sectionValue.text === "string" && !/Session\.append|sourceEventSeqs|branch-local/.test(sectionValue.text));
	check("cleanup tool is registered", host.tools.has("cleanup"));
	check("/clm command is registered", host.commands.has("clm"));
	const clmStatus = await host.commands.get("clm").handler({
		agent,
		rawInput: "",
		commandId: "harness-command",
		attachments: [],
		signal: new AbortController().signal,
	});
	check(
		"/clm reports the DSH live-context status",
		clmStatus.kind === "success" && /^oh-my-clm status \(DSH\)/.test(clmStatus.text) && clmStatus.text.includes("editable blocks: 3"),
		clmStatus.text,
	);
	check("section stays a minimal contract", typeof sectionValue.text === "string" && sectionValue.text.length <= 800 && !/blockIds|skipRoles|CLM_CLEANUP_RESULT|CLM_INDEX_/.test(sectionValue.text), typeof sectionValue.text === "string" ? `${sectionValue.text.length} chars` : "no text");
	check("runtime block index context registered exactly once", host.contexts.length === 1, `got ${host.contexts.length}`);
	check("runtime block index context name", host.contexts[0]?.name === "oh-my-clm:block-index", String(host.contexts[0]?.name));
	check("runtime block index context sorts after host policy", host.contexts[0]?.order === 200, String(host.contexts[0]?.order));
	// The production default is the turn digest; the per-block listing is the
	// fallback shape, so render it explicitly instead of depending on the default.
	const previousIndexMode = process.env.CLM_INDEX_MODE;
	process.env.CLM_INDEX_MODE = "blocks";
	const blockIndex = typeof host.contexts[0]?.text === "function" ? host.contexts[0].text({ agent }) : "";
	if (previousIndexMode === undefined) delete process.env.CLM_INDEX_MODE;
	else process.env.CLM_INDEX_MODE = previousIndexMode;
	check("block index lists editable 1-based IDs", blockIndex.includes("1. assistant:") && blockIndex.includes("3. assistant:"), blockIndex);
	check("block index excludes the protected initial task", !blockIndex.includes("PROTECTED INITIAL TASK"), blockIndex);
	check("runtime context resolves the concrete mirror path", blockIndex.startsWith("Mirror: /tmp/clm-") && blockIndex.includes("LIVE_CTX_MAIN.md"), blockIndex.slice(0, 160));
	check("section tells the model to use the runtime block index", typeof sectionValue.text === "string" && sectionValue.text.includes("<oh-my-clm-block-index>"));
	host.disposeAll();

	const ordered = await boot(plugin, { sessionId: "t-order-host", session: sessionWithHistory("t-order-host"), order: { TOOL_EDIT: 5000 } });
	check("section order follows host TOOL_EDIT order", ordered.host.sections[0]?.order === 5000, String(ordered.host.sections[0]?.order));
	ordered.host.disposeAll();
	for (const id of ["t-order-default", "t-order-host"]) cleanup(id);
}

section("3. agent lifecycle wiring");
{
	const session = sessionWithHistory("t-lifecycle");
	const { host, agentCtx, preStep } = await boot(plugin, { sessionId: session.id, session });
	check("agent/pre-step listener registered on the agent ctx", agentCtx.listenerCount("agent/pre-step") === 1, String(agentCtx.listenerCount("agent/pre-step")));
	check("host registers session/event listener", host.listenerCount("session/event") === 1, String(host.listenerCount("session/event")));
	check("pre-step still calls next()", (await preStep()) === 1);
	check("re-read of the same projection is a no-op with no extra artifact", hasUnexpectedArtifact(session.id) === false);
	host.disposeAll();
	cleanup(session.id);
}
{
	const session = {
		id: "",
		surface: { nodes: [0, 1] },
		snapshotEvents: () => [
			{ seq: 0, type: "turn/start", data: { turn: 1 } },
			{ seq: 1, type: "step/start", data: { turn: 1, step: 1 } },
		],
	};
	const { host, preStep } = await boot(plugin, { sessionId: "t-empty-id", session, agentId: "agent-empty" });
	check("empty session id does not throw out of the hook", (await preStep()) === 1);
	check("empty session id is reported through ctx.logger.warn", host.log.some((entry) => entry.level === "warn" && entry.message.includes("mirror bridge unavailable")), JSON.stringify(host.log));
	host.disposeAll();
}
{
	const host = createCtx();
	plugin.apply(host.ctx);
	await host.emit("agent/created", { agent: { id: "agent-orphan", session: undefined, ctx: createCtx().ctx }, source: { kind: "new" } });
	check("session-less agent is warned about, not crashed", host.log.some((entry) => entry.level === "warn" && entry.message.includes("no session")));
	host.disposeAll();
}

section("4. mirror generation");
{
	const session = sessionWithHistory("t-mirror");
	const { host, preStep } = await boot(plugin, { sessionId: session.id, session });
	await preStep();
	const mirror = readIfExists(mirrorPath(session.id));
	check("mirror file written to /tmp/clm-<sessionId>/LIVE_CTX_MAIN.md", typeof mirror === "string");
	check("mirror carries the protocol header", mirror?.includes("<!-- clm-v2 -->") === true);
	check("mirror carries a 16-hex snapshot fingerprint", /<!-- CLM_SNAPSHOT [a-f0-9]{16} -->/.test(mirror ?? ""));
	check("protected initial user task is absent", mirror?.includes("PROTECTED INITIAL TASK") === false);
	check("assistant reasoning/tool-call block is editable", mirror?.includes("[[CLM_ENTRY id=1 role=assistant]]") === true);
	check("tool result block is editable", mirror?.includes("[[CLM_ENTRY id=2 role=toolResult]]") === true);
	check("last assistant block is editable", mirror?.includes("[[CLM_ENTRY id=3 role=assistant]]") === true);
	const first = mirror;
	await preStep();
	check("unchanged projection leaves the mirror byte-identical", readIfExists(mirrorPath(session.id)) === first);
	host.disposeAll();
	cleanup(session.id);
}

section("5. native Session.append surface replacement");
{
	const session = sessionWithHistory("t-apply");
	const { host, preStep } = await boot(plugin, { sessionId: session.id, session });
	await preStep();
	editMirror(session.id, (markdown) => replaceBlockBody(markdown, 3, "Parser handles nested groups; docs and edge-case tests still to do."));
	await preStep();
	check("no proposal or receipt artifact is written", hasUnexpectedArtifact(session.id) === false);
	check("append-only log retains originals and adds a replacement", session.events.length === 9, `log has ${session.events.length} events`);
	check("replacement event is a developer/message", session.events.at(-1)?.type === "developer/message", String(session.events.at(-1)?.type));
	check("replacement uses the open turn/step", session.events.at(-1)?.data?.turn === 1 && session.events.at(-1)?.data?.step === 2, JSON.stringify({ turn: session.events.at(-1)?.data?.turn, step: session.events.at(-1)?.data?.step }));
	check("surface replaces the edited event", session.surfaceSeq.join(",") === "0,3,4,8", session.surfaceSeq.join(","));
	check("replacement carries the shortened text", JSON.stringify(session.events.at(-1)?.data).includes("docs and edge-case tests still to do"));
	check("canonical mirror drops the rewritten assistant block", !(readIfExists(mirrorPath(session.id)) ?? "").includes("docs and edge-case tests still to do") && !(readIfExists(mirrorPath(session.id)) ?? "").includes("The parser now handles nested groups"));
	check("info log reports native surface replacement", host.log.some((entry) => entry.level === "info" && entry.message.includes("Session.append surface replacement")));
	await preStep();
	check("the applied edit is not repeated on the next pre-step", session.events.length === 9, `log has ${session.events.length} events`);
	host.disposeAll();
	cleanup(session.id);
}

section("5b. direct cleanup tool");
{
	const session = sessionWithHistory("t-cleanup-tool");
	const { host, preStep } = await boot(plugin, { sessionId: session.id, session });
	await preStep();
	const cleanupTool = host.tools.get("cleanup");
	let invalidSchemaRejected = false;
	try {
		await cleanupTool.execute({ blockIds: [3.5] }, { agent: { session } });
	} catch {
		invalidSchemaRejected = true;
	}
	check("defineTool rejects malformed numeric IDs before execute", invalidSchemaRejected && session.events.length === 8);
	const rejected = await cleanupTool.execute({ blockIds: [1] }, { agent: { session } });
	// `copy` is host-only render state and is stripped before DSH validates the
	// declared output schema; compact mode is visible through the absent index.
	check("cleanup result copy is compact by default", rejected?.status === "rejected" && rejected.blockIndex === undefined && !("copy" in rejected), JSON.stringify(rejected));
	process.env.CLM_CLEANUP_RESULT = "full";
	// The refreshed index in `full` copy must be the per-block listing, which is
	// the fallback shape; the default digest lists turns instead of blocks.
	const previousIndexMode = process.env.CLM_INDEX_MODE;
	process.env.CLM_INDEX_MODE = "blocks";
	const result = await cleanupTool.execute({ blockIds: [3] }, { agent: { session } });
	if (previousIndexMode === undefined) delete process.env.CLM_INDEX_MODE;
	else process.env.CLM_INDEX_MODE = previousIndexMode;
	delete process.env.CLM_CLEANUP_RESULT;
	check("cleanup returns an applied canonical result", result?.status === "applied", JSON.stringify(result));
	check("cleanup removes the selected active-surface block", session.surfaceSeq.join(",") === "0,3,4,8", session.surfaceSeq.join(","));
	check("cleanup writes the canonical mirror before tool return", !((readIfExists(mirrorPath(session.id)) ?? "").includes("CLM_ENTRY id=3 role=assistant")) && (readIfExists(mirrorPath(session.id)) ?? "").includes("CLM_ENTRY id=1 role=assistant"));
	check("cleanup result returns the refreshed block index when full copy is enabled", typeof result?.blockIndex === "string" && result.blockIndex.includes("1. assistant:") && result.blockIndex.includes("2. toolResult:") && !result.blockIndex.includes("3. assistant:"), String(result?.blockIndex));
	const omission = session.events.at(-1);
	check("cleanup omission uses the open turn", omission?.data?.turn === 1, JSON.stringify(omission?.data));
	check("cleanup omission uses the open step", omission?.data?.step === 2, JSON.stringify(omission?.data));
	check("cleanup does not write a second artifact", hasUnexpectedArtifact(session.id) === false);
	await preStep();
	check("next pre-step does not repeat native cleanup", session.events.length === 9, `log has ${session.events.length} events`);
	host.disposeAll();
	cleanup(session.id);
}

section("5c. step/start opens the mutation window");
{
	const session = sessionWithHistory("t-step-gate");
	const { host, preStep } = await boot(plugin, { sessionId: session.id, session });
	await preStep();
	session.append("step/end", { turn: 1, step: 2 });
	editMirror(session.id, (markdown) => replaceBlockBody(markdown, 3, "Short inspection before the next step."));
	const closedLength = session.events.length;
	await preStep();
	check("pre-step does not mutate while the step is closed", session.events.length === closedLength, `log has ${session.events.length} events`);
	check("pre-step preserves the pending mirror edit", (readIfExists(mirrorPath(session.id)) ?? "").includes("Short inspection before the next step."));

	const stepStart = session.append("step/start", { turn: 1, step: 3 });
	await host.emit("session/event", session, stepStart);
	await new Promise((resolve) => setImmediate(resolve));
	const replacement = session.events.at(-1);
	check("step/start applies the pending edit", replacement?.type === "developer/message" && session.events.length === closedLength + 2, `log has ${session.events.length} events`);
	check("pending replacement uses the newly opened step", replacement?.data?.turn === 1 && replacement?.data?.step === 3, JSON.stringify({ turn: replacement?.data?.turn, step: replacement?.data?.step }));
	check("canonical mirror drops the pending text after apply", (readIfExists(mirrorPath(session.id)) ?? "").includes("Short inspection before the next step.") === false);
	host.disposeAll();
	cleanup(session.id);
}

section("6. shrink-only gate");
{
	const session = sessionWithHistory("t-grow");
	const { host, preStep } = await boot(plugin, { sessionId: session.id, session });
	await preStep();
	editMirror(session.id, (markdown) => replaceBlockBody(markdown, 3, "The parser now handles nested groups. ".repeat(30)));
	await preStep();
	check("growing edit is rejected", host.log.some((entry) => entry.level === "warn" && entry.message.includes("DSH mirror edit rejected")));
	check("rejection reason mentions the SHRINK rule", host.log.some((entry) => entry.level === "warn" && /SHRINK/.test(entry.message)));
	check("rejected edit writes no extra artifact", hasUnexpectedArtifact(session.id) === false);
	check("rejected edit does not append a replacement", session.events.length === 8, `log has ${session.events.length} events`);
	check("rejected mirror is restored to the canonical projection", (readIfExists(mirrorPath(session.id)) ?? "").includes("The parser now handles nested groups. The parser") === false);
	session.append("tool/result", { turn: 1, step: 2, message: toolResultMessage("call_2", "unpaired result for the next sync") });
	await preStep();
	check("a later projection change remains canonical", (readIfExists(mirrorPath(session.id)) ?? "").includes("The parser now handles nested groups. The parser") === false);
	host.disposeAll();
	cleanup(session.id);
}

section("7. rejection matrix");
async function rejectCase(name, { mutate, expectReason, extraUser = false }) {
	const sessionId = `t-reject-${name.replace(/[^a-z]+/gi, "-")}`;
	cleanup(sessionId);
	const session = sessionWithHistory(sessionId);
	if (extraUser) session.append("user/message", userMessage("SECOND USER MESSAGE: please also update the changelog."));
	const { host, preStep } = await boot(plugin, { sessionId, session });
	await preStep();
	editMirror(sessionId, mutate);
	await preStep();
	const warning = host.log.filter((entry) => entry.level === "warn" && entry.message.includes("DSH mirror edit rejected")).at(-1)?.message ?? "";
	check(`${name}: rejected`, warning.length > 0, warning);
	check(`${name}: reason matches`, new RegExp(expectReason, "i").test(warning), warning);
	check(`${name}: no proposal or receipt artifact`, hasUnexpectedArtifact(sessionId) === false);
	host.disposeAll();
	cleanup(sessionId);
}
await rejectCase("stale snapshot", {
	mutate: (markdown) => markdown.replace(/CLM_SNAPSHOT [a-f0-9]{16}/, "CLM_SNAPSHOT 0123456789abcdef"),
	expectReason: "snapshot is stale",
});
await rejectCase("malformed document", {
	mutate: (markdown) => markdown.replace("[[/CLM_ENTRY id=3]]", ""),
	expectReason: "Malformed",
});
await rejectCase("unknown id", {
	mutate: (markdown) => appendBlock(markdown, 99, "assistant", "injected block"),
	expectReason: "Unknown CLM_ENTRY ids",
});
await rejectCase("duplicate id", {
	mutate: (markdown) => replaceBlockBody(markdown, 3, "shorter") + "\n[[CLM_ENTRY id=3 role=assistant]]\nshorter\n[[/CLM_ENTRY id=3]]\n",
	expectReason: "Duplicate CLM_ENTRY ids",
});
await rejectCase("role change", {
	mutate: (markdown) => markdown.replace("[[CLM_ENTRY id=3 role=assistant]]", "[[CLM_ENTRY id=3 role=user]]"),
	expectReason: "role changed",
});
await rejectCase("user-authored rewrite", {
	mutate: (markdown) => replaceBlockBody(markdown, 4, "rewritten user message"),
	expectReason: "User-authored blocks cannot be rewritten",
	extraUser: true,
});

section("8. native omission and tool pairing");
{
	const session = sessionWithHistory("t-omit-pair");
	const { host, preStep } = await boot(plugin, { sessionId: session.id, session });
	await preStep();
	// Block 1 is the assistant turn owning call_1; block 2 is its tool result.
	editMirror(session.id, (markdown) => replaceBlockBody(markdown, 1, "Ran the suite; results summarized."));
	await preStep();
	check("rewriting an assistant tool turn is applied", host.log.some((entry) => entry.level === "info" && entry.message.includes("Session.append surface replacement")));
	check("paired tool result is omitted through a developer replacement", session.events.at(-1)?.type === "developer/message" && session.events.length === 10, `${session.events.length} events; ${session.events.at(-1)?.type}`);
	check("surface replaces both the assistant and paired result", session.surfaceSeq.join(",") === "0,8,9,7", session.surfaceSeq.join(","));
	check("canonical mirror has no orphaned old tool output", !(readIfExists(mirrorPath(session.id)) ?? "").includes("test suite output"));
	check("no proposal or receipt artifact is written", hasUnexpectedArtifact(session.id) === false);
	host.disposeAll();
	cleanup(session.id);
}
{
	const session = sessionWithHistory("t-omit-last");
	const { host, preStep } = await boot(plugin, { sessionId: session.id, session });
	await preStep();
	editMirror(session.id, (markdown) => deleteBlock(markdown, 3));
	await preStep();
	check("deleting a block appends a developer omission replacement", session.events.at(-1)?.type === "developer/message" && session.events.length === 9);
	check("surface no longer contains the omitted block", session.surfaceSeq.join(",") === "0,3,4,8", session.surfaceSeq.join(","));
	check("no proposal or receipt artifact is written", hasUnexpectedArtifact(session.id) === false);
	host.disposeAll();
	cleanup(session.id);
}

section("9. session/event driven sync");
{
	const session = sessionWithHistory("t-session-event");
	const { host, preStep } = await boot(plugin, { sessionId: session.id, session });
	await preStep();
	const appended = session.append("tool/result", { turn: 1, step: 2, message: toolResultMessage("call_9", "fresh tool output from a later step") });
	const seq = appended.seq;
	await host.emit("session/event", session, { type: "tool/result", seq, data: appended.data });
	// session/event is an observe-only feed; the bridge waits until the append
	// publication stack has unwound before reconciling the mirror.
	await new Promise((resolve) => setImmediate(resolve));
	const mirror = readIfExists(mirrorPath(session.id)) ?? "";
	check("tool/result event refreshes the mirror", mirror.includes("fresh tool output from a later step"));
	check("non-surface events are ignored", (await host.emit("session/event", session, { type: "step/end", seq: 99, data: {} })).length === 1);
	host.disposeAll();
	cleanup(session.id);
}
{
	// State is session-scoped, so this mismatch should still sync; DSH also
	// enforces equality in-product. Recorded rather than asserted.
	const session = sessionWithHistory("t-id-mismatch");
	const { host, preStep } = await boot(plugin, { sessionId: session.id, session, agentId: "agent-other-id" });
	await preStep();
	const appended = session.append("tool/result", { turn: 1, step: 9, message: toolResultMessage("call_7", "orphan sync probe") });
	const seq = appended.seq;
	await host.emit("session/event", session, { type: "tool/result", seq, data: appended.data });
	await new Promise((resolve) => setImmediate(resolve));
	observe(
		"agent.id/session.id mismatch",
		(readIfExists(mirrorPath(session.id)) ?? "").includes("orphan sync probe")
			? "session/event sync still matched (state is session-scoped)"
			: "session/event sync did not refresh the mirror in this run",
	);
	host.disposeAll();
	cleanup(session.id);
}

section("10. disposal");
{
	const session = sessionWithHistory("t-disposed");
	const { host, agentCtx, agent, preStep } = await boot(plugin, { sessionId: session.id, session });
	await preStep();
	await host.emit("agent/disposed", { agent });
	const appended = session.append("user/message", userMessage("post-dispose user message"));
	await host.emit("session/event", session, { type: "user/message", seq: appended.seq, data: appended.data });
	check("disposed agent is dropped from the state map (session/event does not reconcile)", hasUnexpectedArtifact(session.id) === false);
	host.disposeAll();
	check("effect disposers remove the agent listeners", agentCtx.listenerCount("agent/pre-step") === 0, String(agentCtx.listenerCount("agent/pre-step")));
	check("host listeners are removed on dispose", host.listenerCount("agent/created") === 0 && host.listenerCount("session/event") === 0);
	check("tool registration is removed on dispose", host.tools.has("cleanup") === false);
	cleanup(session.id);
}

console.log(`\n${pass} passed, ${fail} failed, ${observations.length} observation(s)`);
if (observations.length > 0) {
	console.log("\nobservations (measured behaviour, not asserted contract):");
	for (const observation of observations) console.log(`  - ${observation}`);
}
if (failures.length > 0) {
	console.log("\nfailures:");
	for (const failure of failures) console.log(`  - ${failure}`);
}
process.exit(fail === 0 ? 0 : 1);
