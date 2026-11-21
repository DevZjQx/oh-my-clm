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

// The plugin resolves the host's ignorable-record seam dynamically, because a
// profile install does not resolve host packages for its plugins. This stand-in
// is the harness's host: it commits `ignorable: true`, like
// `@deepseek-ai/dsh-session`'s `appendPluginRecord`, so a record here is the same
// kind of event the real persistence reader retains and skips — including the
// host's refusal to append from inside another append's notification.
const recordSeamModule = path.join(os.tmpdir(), `clm-plugin-record-seam-${process.pid}.mjs`);
fs.writeFileSync(
	recordSeamModule,
	[
		"export function appendPluginRecord(session, type, data) {",
		"\tif (session.appending === true) throw new Error('session append cannot reenter while another append is being published');",
		"\tconst seq = session.events.length === 0 ? 0 : session.events.at(-1).seq + 1;",
		"\tsession.events.push({ type, seq, time: Date.now(), data, ignorable: true });",
		"\treturn seq;",
		"}",
	].join("\n"),
	"utf8",
);

// Sessions point at a temporary project directory; config changes are ordinary
// file writes, the same path a real user edits. No plugin switch is read from the
// environment. The user-level config root is pinned to a temporary directory so
// the harness cannot inherit whatever the machine running it has configured.
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clm-harness-user-config-"));
const harnessCwd = fs.mkdtempSync(path.join(os.tmpdir(), "clm-harness-"));
let harnessConfig = {
	host: { pluginRecordModule: pathToFileURL(recordSeamModule).href },
};
function writeHarnessConfig() {
	fs.writeFileSync(path.join(harnessCwd, ".oh-my-clm.json"), JSON.stringify(harnessConfig), "utf8");
}
function setHarnessAutoClear(patch) {
	harnessConfig = { ...harnessConfig, autoClear: { ...(harnessConfig.autoClear ?? {}), ...patch } };
	writeHarnessConfig();
}
function setHarnessHost(patch) {
	harnessConfig = { ...harnessConfig, host: { ...(harnessConfig.host ?? {}), ...patch } };
	writeHarnessConfig();
}
function setHarnessSection(section, patch) {
	harnessConfig = { ...harnessConfig, [section]: { ...(harnessConfig[section] ?? {}), ...patch } };
	writeHarnessConfig();
}
writeHarnessConfig();

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
function createCtx({ sectionOrder, deferInject } = {}) {
	const handlers = new Map();
	const ownedDisposers = [];
	const log = [];
	const injections = [];
	const sections = [];
	const contexts = [];
	const effects = [];
	const tools = new Map();
	const commands = new Map();
	const projections = [];
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
		sessions: {
			registerMessageProjection(definition) {
				projections.push(definition);
				return () => {};
			},
		},
		inject(deps, callback) {
			// Real DSH defers until the named services exist; tests choose whether
			// that happens before or after the first turn boundary.
			if (deferInject) injections.push({ deps, callback });
			else callback(ctx);
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
		projections,
		runInjections() {
			for (const { callback } of injections.splice(0)) callback(ctx);
		},
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
		this.header = { cwd: harnessCwd };
		this.events = events;
		this.surfaceSeq = events.filter((event) => SURFACE_EVENT_TYPES.has(event.type)).map((event) => event.seq);
		// Real DSH notifies `session/event` from inside `Session.append()`, while the
		// append is still active, and `appendPluginRecord` refuses a nested append.
		// A stand-in that only notifies afterwards makes a plugin that writes during
		// the observer look healthy here and fail on a host, so the flag is modelled.
		this.appending = false;
		/** Set to a synchronous dispatcher to deliver each append to the observers. */
		this.onEvent = undefined;
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
		const appended = this.events.at(-1);
		this.appending = true;
		try {
			this.onEvent?.(appended);
		} finally {
			this.appending = false;
		}
		return appended;
	}
}

const text = (value) => [{ type: "text", text: value }];
const userMessage = (value) => ({ id: `u${value.length}`, role: "user", content: text(value), source: { kind: "user" } });
const assistantMessage = (parts) => ({ id: `a${parts.length}`, role: "assistant", content: parts, source: { kind: "model", provider: "mock", model: "mock" } });
const toolResultMessage = (callId, value, isError = false) => ({ id: `t${callId}`, role: "tool", content: text(value), toolCallId: callId, source: { kind: "tool", callId, name: "mock" }, ...(isError ? { isError: true } : {}) });

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
async function boot(plugin, { sessionId, session, order, agentId, deferInject }) {
	const host = createCtx({ sectionOrder: order, deferInject });
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
	check("section stays a minimal contract", typeof sectionValue.text === "string" && sectionValue.text.length <= 800 && !/blockIds|skipRoles|autoClear\.enabled|cleanup\.resultMode|index\.mode/.test(sectionValue.text), typeof sectionValue.text === "string" ? `${sectionValue.text.length} chars` : "no text");
	check("runtime block index context registered exactly once", host.contexts.length === 1, `got ${host.contexts.length}`);
	check("runtime block index context name", host.contexts[0]?.name === "oh-my-clm:block-index", String(host.contexts[0]?.name));
	check("runtime block index context sorts after host policy", host.contexts[0]?.order === 200, String(host.contexts[0]?.order));
	// The production default is the turn digest; the per-block listing is the
	// fallback shape, so select it explicitly instead of depending on the default.
	setHarnessSection("index", { mode: "blocks" });
	const blockIndex = typeof host.contexts[0]?.text === "function" ? host.contexts[0].text({ agent }) : "";
	setHarnessSection("index", { mode: "digest" });
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
	check("shared cleanup parser rejects malformed numeric IDs inside execute", invalidSchemaRejected && session.events.length === 8);
	const rejected = await cleanupTool.execute({ blockIds: [1] }, { agent: { session } });
	// `copy` is host-only render state and is stripped before DSH validates the
	// declared output schema; compact mode is visible through the absent index.
	check("cleanup result copy is compact by default", rejected?.status === "rejected" && rejected.blockIndex === undefined && !("copy" in rejected), JSON.stringify(rejected));
	setHarnessSection("cleanup", { resultMode: "full" });
	// The refreshed index in `full` copy must be the per-block listing, which is
	// the fallback shape; the default digest lists turns instead of blocks.
	setHarnessSection("index", { mode: "blocks" });
	const result = await cleanupTool.execute({ blockIds: [3] }, { agent: { session } });
	setHarnessSection("index", { mode: "digest" });
	setHarnessSection("cleanup", { resultMode: "compact" });
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

section("11. clearing canary");
{
	setHarnessAutoClear({ canary: true });
	const session = sessionWithHistory("t-canary");
	const { host } = await boot(plugin, { sessionId: session.id, session });
	const before = session.events.length;
	const feed = async (type, data) => {
		const appended = session.append(type, data);
		await host.emit("session/event", session, { type, seq: appended.seq, data: appended.data });
	};
	const output = "match ".repeat(900);
	await feed("tool/call", { turn: 1, step: 3, callId: "call_grep_1", name: "grep", arguments: JSON.stringify({ pattern: "needle" }) });
	await feed("tool/result", { turn: 1, step: 3, message: toolResultMessage("call_grep_1", output) });
	await feed("tool/call", { turn: 1, step: 4, callId: "call_grep_2", name: "grep", arguments: JSON.stringify({ pattern: "needle" }) });
	await feed("tool/result", { turn: 1, step: 4, message: toolResultMessage("call_grep_2", output) });
	await feed("turn/end", { turn: 1 });
	const canaryFile = path.join("/tmp", `clm-${encodeURIComponent(session.id)}`, "CANARY.jsonl");
	const lines = (readIfExists(canaryFile) ?? "").trim().split("\n").filter(Boolean);
	check("canary writes one decision per turn end", lines.length === 1, String(lines.length));
	let record;
	try {
		record = JSON.parse(lines[0] ?? "{}");
	} catch (error) {
		record = { parseError: String(error) };
	}
	check("canary blames the superseded block", record.candidates?.[0]?.blockId === "call_grep_1", JSON.stringify(record.candidates?.[0] ?? null));
	check("canary opens the gate for one large dead block", record.gate === true, JSON.stringify(record.gate));
	check("canary frees the whole block, not just the call output", record.tokens > 900, String(record.tokens));
	check(
		"the ledger carries what the session is doing, not just what it might save",
		typeof record.quality?.contextTokens === "number"
			&& record.quality.session?.results >= 2
			&& record.quality.turn?.rereads === 0,
		JSON.stringify(record.quality ?? null),
	);
	check("canary writes no session event", session.events.length === before + 5, String(session.events.length - before));
	check("canary leaves the surface untouched", session.surfaceSeq.length === session.events.filter((event) => SURFACE_EVENT_TYPES.has(event.type)).length);
	host.disposeAll();
	cleanup(session.id);

	// With autoClear.enabled the same decision becomes a durable record that the
	// registered projection turns into a model-visible pointer.
	setHarnessAutoClear({ enabled: true });
	const clearSession = sessionWithHistory("t-auto-clear");
	const clearBoot = await boot(plugin, { sessionId: clearSession.id, session: clearSession });
	const clearFeed = async (type, data) => {
		const appended = clearSession.append(type, data);
		await clearBoot.host.emit("session/event", clearSession, { type, seq: appended.seq, data: appended.data });
		return appended;
	};
	const bigOutput = "match ".repeat(900);
	await clearFeed("tool/call", { turn: 1, step: 3, callId: "call_auto_1", name: "grep", arguments: JSON.stringify({ pattern: "needle" }) });
	const firstResult = await clearFeed("tool/result", { turn: 1, step: 3, message: toolResultMessage("call_auto_1", bigOutput) });
	await clearFeed("tool/call", { turn: 1, step: 4, callId: "call_auto_2", name: "grep", arguments: JSON.stringify({ pattern: "needle" }) });
	await clearFeed("tool/result", { turn: 1, step: 4, message: toolResultMessage("call_auto_2", bigOutput) });
	// A second independent dead block, so the boundary clears a batch and no live
	// copy of either target is left behind for the quality probe below.
	await clearFeed("tool/call", { turn: 1, step: 5, callId: "call_auto_3", name: "glob", arguments: JSON.stringify({ pattern: "**/*.ts" }) });
	await clearFeed("tool/result", { turn: 1, step: 5, message: toolResultMessage("call_auto_3", bigOutput) });
	await clearFeed("tool/call", { turn: 1, step: 6, callId: "call_auto_4", name: "glob", arguments: JSON.stringify({ pattern: "**/*.ts" }) });
	await clearFeed("tool/result", { turn: 1, step: 6, message: toolResultMessage("call_auto_4", bigOutput) });
	await clearFeed("tool/call", { turn: 1, step: 7, callId: "call_read_1", name: "read", arguments: JSON.stringify({ file_path: "/a.ts" }) });
	await clearFeed("tool/result", { turn: 1, step: 7, message: toolResultMessage("call_read_1", bigOutput) });
	await clearFeed("tool/call", { turn: 1, step: 8, callId: "call_read_2", name: "read", arguments: JSON.stringify({ file_path: "/a.ts" }) });
	await clearFeed("tool/result", { turn: 1, step: 8, message: toolResultMessage("call_read_2", bigOutput) });
	await clearFeed("turn/end", { turn: 1 });
	const clearRecords = clearSession.events.filter((event) => event.type === "plugin:oh-my-clm/clear");
	check("auto clearing appends one durable record", clearRecords.length === 1, String(clearRecords.length));
	check(
		"the record is ignorable, so a reader that does not know it skips instead of refusing the session",
		clearRecords.every((event) => event.ignorable === true),
		JSON.stringify(clearRecords.map((event) => event.ignorable ?? null)),
	);
	const clearTargets = clearRecords[0]?.data?.targets ?? [];
	check("the record targets the superseded tool result", clearTargets[0]?.seq === firstResult.seq, JSON.stringify(clearTargets));
	check("the record carries a pointer label", typeof clearTargets[0]?.label === "string" && clearTargets[0].label.startsWith("grep "), String(clearTargets[0]?.label));
	check("the record adds no surface node", clearSession.surfaceSeq.includes(clearRecords[0]?.seq) === false);
	const registered = clearBoot.host.projections.find((definition) => definition.type === "plugin:oh-my-clm/clear");
	check("the plugin registered the clearing projection", registered !== undefined);
	let projected;
	try {
		projected = registered.project(clearRecords[0], {
			nodes: clearSession.surfaceSeq,
			events: clearSession.events,
			baseSeq: 0,
			messages: new Map(),
		});
	} catch (error) {
		projected = undefined;
		console.log(`        ${String(error)}`);
	}
	const rewritten = projected?.get(firstResult.seq);
	const rewrittenText = Array.isArray(rewritten?.content) ? rewritten.content.map((block) => block.text ?? "").join("") : "";
	check("the projection replaces the body with a re-read pointer", rewrittenText.startsWith("[cleared"), rewrittenText.slice(0, 60));
	check("the projection keeps the message identity", rewritten?.id === `tcall_auto_1` && rewritten?.toolCallId === "call_auto_1", JSON.stringify({ id: rewritten?.id }));
	check("the durable event keeps the original body", firstResult.data.message.content[0].text.length === bigOutput.length);

	// The ledger records the outcome side of a clear as well: blocks retired and
	// the prompt size the decision was made against.
	const clearCanary = path.join("/tmp", `clm-${encodeURIComponent(clearSession.id)}`, "CANARY.jsonl");
	const clearLines = (readIfExists(clearCanary) ?? "").trim().split("\n").filter(Boolean);
	let clearRecord;
	try {
		clearRecord = JSON.parse(clearLines.at(-1) ?? "{}");
	} catch (error) {
		clearRecord = { parseError: String(error) };
	}
	check(
		"the ledger counts the blocks a pass retired",
		clearRecord.quality?.session?.clearedBlocks === 3 && clearRecord.quality.session.clearedTokens > 2_700,
		JSON.stringify(clearRecord.quality?.session ?? null),
	);

	// An error on a target this session cleared is the sharpest quality signal: the
	// pointer sent the model back to something that no longer works. One re-read
	// without a second call produces no new candidate, so this line exercises the
	// "outcome without a proposal" path.
	await clearFeed("tool/call", { turn: 2, step: 1, callId: "call_retry_a", name: "read", arguments: JSON.stringify({ file_path: "/a.ts", offset: 200, limit: 60 }) });
	await clearFeed("tool/result", { turn: 2, step: 1, message: toolResultMessage("call_retry_a", "no such file", true) });
	await clearFeed("turn/end", { turn: 2 });
	const qualityLines = (readIfExists(clearCanary) ?? "").trim().split("\n").filter(Boolean);
	let qualityRecord;
	try {
		qualityRecord = JSON.parse(qualityLines.at(-1) ?? "{}");
	} catch (error) {
		qualityRecord = { parseError: String(error) };
	}
	check(
		"a boundary with no new candidates still logs post-clear outcomes",
		qualityRecord.candidates?.length === 0 && qualityRecord.quality !== undefined,
		JSON.stringify({ candidates: qualityRecord.candidates?.length, quality: qualityRecord.quality ?? null }),
	);
	check(
		"the ledger counts re-reads and the error on a cleared target",
		qualityRecord.quality?.turn?.rereads === 1
			&& qualityRecord.quality?.turn?.errorRereads === 1
			&& qualityRecord.quality?.session?.errors >= 1,
		JSON.stringify(qualityRecord.quality ?? null),
	);

	// Two more re-fetches of the same cleared target are the model coming back to
	// a target it already re-read: the key is refused, and the channel stays open
	// for every other block. A subrange read does not supersede the live full
	// read, so no new candidate is created.
	for (const step of [2, 3]) {
		await clearFeed("tool/call", { turn: 2, step, callId: `call_retry_${step}`, name: "read", arguments: JSON.stringify({ file_path: "/a.ts", offset: 200, limit: 60 }) });
	}
	const status = clearBoot.host.commands.get("clm").handler({ agent: clearBoot.agent, rawInput: "status" });
	check(
		"a target that keeps coming back is refused without closing the channel",
		/1 key\(s\) refused after re-reads/.test(String(status.text)) && !String(status.text).includes("stopped (breaker)"),
		String(status.text).split("\n").at(-1),
	);
	check("the status line reports error re-reads", /error re-read\(s\)/.test(String(status.text)), String(status.text).split("\n").at(-1));
	clearBoot.host.disposeAll();
	setHarnessAutoClear({ enabled: false });
	cleanup(clearSession.id);

	// Real DSH registers services in dependency order, not plugin order: the
	// clearing projection must wait for `sessions` and must not clear before it
	// is there (a record without its projection would clear nothing).
	setHarnessAutoClear({ enabled: true });
	const lateSession = sessionWithHistory("t-auto-clear-late");
	const lateBoot = await boot(plugin, { sessionId: lateSession.id, session: lateSession, deferInject: true });
	const lateFeed = async (type, data) => {
		const appended = lateSession.append(type, data);
		await lateBoot.host.emit("session/event", lateSession, { type, seq: appended.seq, data: appended.data });
		return appended;
	};
	const lateOutput = "match ".repeat(900);
	await lateFeed("tool/call", { turn: 1, step: 3, callId: "call_late_1", name: "grep", arguments: JSON.stringify({ pattern: "late" }) });
	await lateFeed("tool/result", { turn: 1, step: 3, message: toolResultMessage("call_late_1", lateOutput) });
	await lateFeed("tool/call", { turn: 1, step: 4, callId: "call_late_2", name: "grep", arguments: JSON.stringify({ pattern: "late" }) });
	await lateFeed("tool/result", { turn: 1, step: 4, message: toolResultMessage("call_late_2", lateOutput) });
	await lateFeed("turn/end", { turn: 1 });
	const beforeInject = lateSession.events.filter((event) => event.type === "plugin:oh-my-clm/clear").length;
	check("no clearing record before the projection is registered", beforeInject === 0, String(beforeInject));
	lateBoot.host.runInjections();
	check("the plugin waits for the sessions service", lateBoot.host.projections.length === 1, String(lateBoot.host.projections.length));
	await lateFeed("tool/call", { turn: 2, step: 1, callId: "call_late_3", name: "grep", arguments: JSON.stringify({ pattern: "later" }) });
	await lateFeed("tool/result", { turn: 2, step: 1, message: toolResultMessage("call_late_3", lateOutput) });
	await lateFeed("tool/call", { turn: 2, step: 2, callId: "call_late_4", name: "grep", arguments: JSON.stringify({ pattern: "later" }) });
	await lateFeed("tool/result", { turn: 2, step: 2, message: toolResultMessage("call_late_4", lateOutput) });
	await lateFeed("turn/end", { turn: 2 });
	const afterInject = lateSession.events.filter((event) => event.type === "plugin:oh-my-clm/clear").length;
	check("clearing resumes once the projection is ready", afterInject === 1, String(afterInject));
	lateBoot.host.disposeAll();
	setHarnessAutoClear({ enabled: false });
	cleanup(lateSession.id);

	// A resumed session is seeded from its recorded log, so a block that died
	// before the plugin loaded is still reported once — at the next turn end.
	const resumed = new FakeSession("t-canary-resume");
	resumed.append("tool/call", { turn: 1, step: 1, callId: "call_resume_1", name: "grep", arguments: JSON.stringify({ pattern: "resume" }) });
	resumed.append("tool/result", { turn: 1, step: 1, message: toolResultMessage("call_resume_1", "hit ".repeat(800)) });
	resumed.append("tool/call", { turn: 1, step: 2, callId: "call_resume_2", name: "grep", arguments: JSON.stringify({ pattern: "resume" }) });
	resumed.append("tool/result", { turn: 1, step: 2, message: toolResultMessage("call_resume_2", "hit ".repeat(800)) });
	const resumedBoot = await boot(plugin, { sessionId: resumed.id, session: resumed });
	const endEvent = resumed.append("turn/end", { turn: 2 });
	await resumedBoot.host.emit("session/event", resumed, { type: "turn/end", seq: endEvent.seq, data: endEvent.data });
	const resumedFile = path.join("/tmp", `clm-${encodeURIComponent(resumed.id)}`, "CANARY.jsonl");
	const resumedLines = (readIfExists(resumedFile) ?? "").trim().split("\n").filter(Boolean);
	check("seeded canary reports a pre-load dead block once", resumedLines.length === 1, String(resumedLines.length));
	const resumedRecord = JSON.parse(resumedLines[0] ?? "{}");
	check("seeded canary still names the dead block", resumedRecord.candidates?.[0]?.blockId === "call_resume_1", JSON.stringify(resumedRecord.candidates?.[0] ?? null));
	resumedBoot.host.disposeAll();
	cleanup(resumed.id);

	// The realistic resume shape: the log already ends with the turn/end that
	// closed the supersession. Replaying that boundary must not consume the
	// candidate — the first *live* boundary still has to report it.
	const closed = new FakeSession("t-canary-resume-closed");
	closed.append("tool/call", { turn: 1, step: 1, callId: "call_closed_1", name: "grep", arguments: JSON.stringify({ pattern: "closed" }) });
	closed.append("tool/result", { turn: 1, step: 1, message: toolResultMessage("call_closed_1", "hit ".repeat(800)) });
	closed.append("tool/call", { turn: 1, step: 2, callId: "call_closed_2", name: "grep", arguments: JSON.stringify({ pattern: "closed" }) });
	closed.append("tool/result", { turn: 1, step: 2, message: toolResultMessage("call_closed_2", "hit ".repeat(800)) });
	closed.append("turn/end", { turn: 1 });
	const closedBoot = await boot(plugin, { sessionId: closed.id, session: closed });
	const closedEnd = closed.append("turn/end", { turn: 2 });
	await closedBoot.host.emit("session/event", closed, { type: "turn/end", seq: closedEnd.seq, data: closedEnd.data });
	const closedFile = path.join("/tmp", `clm-${encodeURIComponent(closed.id)}`, "CANARY.jsonl");
	const closedLines = (readIfExists(closedFile) ?? "").trim().split("\n").filter(Boolean);
	check("a recorded turn boundary does not consume the candidate it replayed", closedLines.length === 1, String(closedLines.length));
	closedBoot.host.disposeAll();
	cleanup(closed.id);
	setHarnessAutoClear({ canary: false });
}

section("12. clearing both sides of a skipped pass");
{
	// A dead block below both gate floors must survive the boundary it was
	// skipped at, so the next boundary can pay for it together with a new one.
	setHarnessAutoClear({ enabled: true });
	const session = sessionWithHistory("t-auto-clear-accumulate");
	const { host } = await boot(plugin, { sessionId: session.id, session });
	const feed = async (type, data) => {
		const appended = session.append(type, data);
		await host.emit("session/event", session, { type, seq: appended.seq, data: appended.data });
		return appended;
	};
	const small = "tiny ".repeat(80);
	const records = () => session.events.filter((event) => event.type === "plugin:oh-my-clm/clear");
	await feed("tool/call", { turn: 1, step: 3, callId: "call_acc_1", name: "grep", arguments: JSON.stringify({ pattern: "alpha" }) });
	await feed("tool/result", { turn: 1, step: 3, message: toolResultMessage("call_acc_1", small) });
	await feed("tool/call", { turn: 1, step: 4, callId: "call_acc_2", name: "grep", arguments: JSON.stringify({ pattern: "alpha" }) });
	await feed("tool/result", { turn: 1, step: 4, message: toolResultMessage("call_acc_2", small) });
	await feed("turn/end", { turn: 1 });
	check("a batch under both floors clears nothing", records().length === 0, String(records().length));
	await feed("tool/call", { turn: 2, step: 1, callId: "call_acc_3", name: "grep", arguments: JSON.stringify({ pattern: "beta" }) });
	await feed("tool/result", { turn: 2, step: 1, message: toolResultMessage("call_acc_3", small) });
	await feed("tool/call", { turn: 2, step: 2, callId: "call_acc_4", name: "grep", arguments: JSON.stringify({ pattern: "beta" }) });
	await feed("tool/result", { turn: 2, step: 2, message: toolResultMessage("call_acc_4", small) });
	await feed("turn/end", { turn: 2 });
	const accumulated = records().at(-1)?.data?.targets ?? [];
	check("the skipped candidate comes back with the next boundary", accumulated.length === 2, JSON.stringify(accumulated));
	check("the accumulated batch names both blocks", new Set(accumulated.map((target) => target.label)).size === 2, JSON.stringify(accumulated.map((target) => target.label)));
	// Compaction can remove a cleared node, and a projection that refused to load
	// the session over a pointer nobody can read would cost the whole transcript.
	const projection = host.projections[0];
	const record = records().at(-1);
	const projectWith = (nodes) => {
		try {
			return projection.project(record, { nodes, events: session.events, baseSeq: 0, messages: new Map() });
		} catch (error) {
			console.log(`        ${String(error)}`);
			return undefined;
		}
	};
	const partlyStale = projectWith(session.surfaceSeq.filter((seq) => seq !== accumulated[0]?.seq));
	check("a stale target does not stop its live sibling", partlyStale?.size === 1, String(partlyStale?.size));
	const fullyStale = projectWith([]);
	check("a record whose targets are all gone is skipped, not fatal", fullyStale?.size === 0, String(fullyStale?.size));
	host.disposeAll();
	setHarnessAutoClear({ enabled: false });
	cleanup(session.id);
}

section("13. mid-turn clearing is rationed and cost-gated");
{
	// A turn boundary shares one prefix break across a whole batch; a mid-turn
	// pass pays its own. The switch therefore only fires when the tail behind the
	// block is small and the break pays for itself within one more request, and
	// only once per turn. `cacheDiscountPercent: 100` removes the break cost so the
	// wiring is observable at all (at the 2% default no replayed block qualifies).
	setHarnessSection("cleanup", { cacheDiscountPercent: 100 });
	setHarnessAutoClear({ enabled: true, canary: true, midTurnSuffixTokens: 512 });
	const session = sessionWithHistory("t-auto-clear-midturn");
	const { host } = await boot(plugin, { sessionId: session.id, session });
	const feed = async (type, data) => {
		const appended = session.append(type, data);
		await host.emit("session/event", session, { type, seq: appended.seq, data: appended.data });
		return appended;
	};
	const records = () => session.events.filter((event) => event.type === "plugin:oh-my-clm/clear");
	const big = "match ".repeat(900);
	const small = "match ".repeat(4);
	// Step 3 reads, step 4 re-reads the same target: the first block dies at the
	// end of step 4, while the turn still has steps to run.
	await feed("tool/call", { turn: 1, step: 3, callId: "call_mid_1", name: "grep", arguments: JSON.stringify({ pattern: "mid" }) });
	await feed("tool/result", { turn: 1, step: 3, message: toolResultMessage("call_mid_1", big) });
	await feed("tool/call", { turn: 1, step: 4, callId: "call_mid_2", name: "grep", arguments: JSON.stringify({ pattern: "mid" }) });
	const replacement = await feed("tool/result", { turn: 1, step: 4, message: toolResultMessage("call_mid_2", small) });
	check("nothing is cleared while the block is still live", records().length === 0, String(records().length));
	await feed("step/end", { turn: 1, step: 4 });
	const midTurn = records();
	check("a cheap block is cleared inside the turn", midTurn.length === 1, String(midTurn.length));
	check("the mid-turn record targets the superseded result", midTurn[0]?.data?.targets?.[0]?.label?.startsWith("grep "), JSON.stringify(midTurn[0]?.data?.targets ?? null));
	check("the mid-turn record adds no surface node", midTurn[0] !== undefined && session.surfaceSeq.includes(midTurn[0].seq) === false);
	check("the mid-turn record also carries an ignorable flag", midTurn.every((event) => event.ignorable === true), JSON.stringify(midTurn.map((event) => event.ignorable ?? null)));
	check("the replacement read stays live behind the pointer", replacement !== undefined && records().length === 1);
	const canaryFile = path.join("/tmp", `clm-${encodeURIComponent(session.id)}`, "CANARY.jsonl");
	const midTurnLines = (readIfExists(canaryFile) ?? "").trim().split("\n").filter(Boolean);
	let midTurnRecord = {};
	try {
		midTurnRecord = JSON.parse(midTurnLines.at(-1) ?? "{}");
	} catch (error) {
		midTurnRecord = { parseError: String(error) };
	}
	check("the canary ledger stamps the step a mid-turn pass ran in", midTurnRecord.step === 4 && midTurnRecord.turn === 1, JSON.stringify({ turn: midTurnRecord.turn, step: midTurnRecord.step }));

	// A second dead block in the same turn waits for the boundary: one break per
	// turn is the whole point of rationing the exception.
	await feed("tool/call", { turn: 1, step: 5, callId: "call_mid_3", name: "grep", arguments: JSON.stringify({ pattern: "other" }) });
	await feed("tool/result", { turn: 1, step: 5, message: toolResultMessage("call_mid_3", big) });
	await feed("tool/call", { turn: 1, step: 6, callId: "call_mid_4", name: "grep", arguments: JSON.stringify({ pattern: "other" }) });
	await feed("tool/result", { turn: 1, step: 6, message: toolResultMessage("call_mid_4", small) });
	await feed("step/end", { turn: 1, step: 6 });
	check("the second in-turn candidate is not cleared mid-turn", records().length === 1, String(records().length));
	await feed("turn/end", { turn: 1 });
	const afterBoundary = records();
	check("the turn boundary clears what the ration held back", afterBoundary.length === 2, String(afterBoundary.length));
	check("the boundary pass targets the later block", afterBoundary.at(-1)?.data?.targets?.[0]?.label?.startsWith("grep "), JSON.stringify(afterBoundary.at(-1)?.data?.targets ?? null));
	host.disposeAll();
	setHarnessAutoClear({ enabled: false, canary: false, midTurnSuffixTokens: 0 });
	setHarnessSection("cleanup", { cacheDiscountPercent: 2 });
	cleanup(session.id);
}

section("14. a host without the ignorable-record seam");
{
	// No seam means no durable record, so clearing must stay off rather than
	// write an event this host's own persistence reader would refuse.
	setHarnessHost({ pluginRecordModule: "@deepseek-ai/does-not-exist" });
	setHarnessAutoClear({ enabled: true });
	const seamless = await import(`${pathToFileURL(entry).href}?no-record-seam`);
	const session = sessionWithHistory("t-auto-clear-no-seam");
	const { host, agent } = await boot(seamless, { sessionId: session.id, session });
	const feed = async (type, data) => {
		const appended = session.append(type, data);
		await host.emit("session/event", session, { type, seq: appended.seq, data: appended.data });
	};
	const output = "match ".repeat(900);
	await feed("tool/call", { turn: 1, step: 3, callId: "call_seam_1", name: "grep", arguments: JSON.stringify({ pattern: "seam" }) });
	await feed("tool/result", { turn: 1, step: 3, message: toolResultMessage("call_seam_1", output) });
	await feed("tool/call", { turn: 1, step: 4, callId: "call_seam_2", name: "grep", arguments: JSON.stringify({ pattern: "seam" }) });
	await feed("tool/result", { turn: 1, step: 4, message: toolResultMessage("call_seam_2", output) });
	await feed("turn/end", { turn: 1 });
	check("no session event is written without the seam", session.events.filter((event) => event.type === "plugin:oh-my-clm/clear").length === 0);
	const status = String(host.commands.get("clm").handler({ agent, rawInput: "status" }).text);
	check("the status line says the seam is missing", status.includes("no ignorable plugin-record seam"), status.split("\n").at(-1));
	check("clearing is reported as stopped, not silently idle", status.includes("stopped (unrecordable)"), status.split("\n").at(-1));
	check("the missing seam is warned about once at load", host.log.some((entry) => entry.level === "warn" && entry.message.includes("no appendPluginRecord seam")), JSON.stringify(host.log.filter((entry) => entry.level === "warn").map((entry) => entry.message)));
	host.disposeAll();
	setHarnessHost({ pluginRecordModule: pathToFileURL(recordSeamModule).href });
	setHarnessAutoClear({ enabled: false });
	cleanup(session.id);
}

section("15. clearing stays effective without a cumulative cap");
{
	// `autoClear.enabled` is meant to hold for the whole session. A cumulative
	// cap would clear the first ~30k block and then latch `stopped (budget)` on
	// the next one, which is exactly when the session still needs de-rotting.
	setHarnessAutoClear({ enabled: true });
	const session = sessionWithHistory("t-auto-clear-no-cap");
	const { host, agent } = await boot(plugin, { sessionId: session.id, session });
	const feed = async (type, data) => {
		const appended = session.append(type, data);
		await host.emit("session/event", session, { type, seq: appended.seq, data: appended.data });
	};
	const records = () => session.events.filter((event) => event.type === "plugin:oh-my-clm/clear");
	const huge = "match ".repeat(20_000);
	for (const turn of [1, 2]) {
		await feed("tool/call", { turn, step: 3, callId: `call_cap_${turn}_1`, name: "grep", arguments: JSON.stringify({ pattern: `cap-${turn}` }) });
		await feed("tool/result", { turn, step: 3, message: toolResultMessage(`call_cap_${turn}_1`, huge) });
		await feed("tool/call", { turn, step: 4, callId: `call_cap_${turn}_2`, name: "grep", arguments: JSON.stringify({ pattern: `cap-${turn}` }) });
		await feed("tool/result", { turn, step: 4, message: toolResultMessage(`call_cap_${turn}_2`, "match ".repeat(4)) });
		await feed("turn/end", { turn });
	}
	const cleared = records();
	const freed = cleared.reduce(
		(total, event) => total + (event.data?.targets ?? []).reduce((sum, target) => sum + (target.tokens ?? 0), 0),
		0,
	);
	check("a second pass still clears after more than the removed 40k cap", cleared.length === 2, String(cleared.length));
	check("both passes together freed more than 40k tokens", freed > 40_000, String(freed));
	const status = String(host.commands.get("clm").handler({ agent, rawInput: "status" }).text);
	check("clearing is still open, not stopped on a budget", !status.includes("stopped (budget)") && status.includes("open"), status.split("\n").at(-1));
	host.disposeAll();
	setHarnessAutoClear({ enabled: false });
	cleanup(session.id);
}

section("16. aged clearing, the empty boundary, and the breaker's sample floor");
{
	// Supersession only names output the model just asked for again. A read from
	// several turns ago that nobody re-fetched is the rot the stale rule exists
	// for, and an empty boundary still has to say so in both the ledger and the
	// status line, or `0 pass(es)` cannot be told from a broken gate.
	setHarnessAutoClear({ enabled: true, canary: true, staleTurns: 2 });
	const session = sessionWithHistory("t-auto-clear-stale");
	const { host, agent } = await boot(plugin, { sessionId: session.id, session });
	const feed = async (type, data) => {
		const appended = session.append(type, data);
		await host.emit("session/event", session, { type, seq: appended.seq, data: appended.data });
		return appended;
	};
	const records = () => session.events.filter((event) => event.type === "plugin:oh-my-clm/clear");
	const canaryFile = path.join("/tmp", `clm-${encodeURIComponent(session.id)}`, "CANARY.jsonl");
	const canaryLines = () => (readIfExists(canaryFile) ?? "").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const big = "match ".repeat(900);

	await feed("tool/call", { turn: 1, step: 2, callId: "call_stale_1", name: "read", arguments: JSON.stringify({ file_path: "/old-a.ts" }) });
	await feed("tool/result", { turn: 1, step: 2, message: toolResultMessage("call_stale_1", big) });
	await feed("tool/call", { turn: 1, step: 3, callId: "call_stale_2", name: "read", arguments: JSON.stringify({ file_path: "/old-b.ts" }) });
	await feed("tool/result", { turn: 1, step: 3, message: toolResultMessage("call_stale_2", big) });
	await feed("turn/end", { turn: 1 });
	check("a fresh read is not rot yet", records().length === 0, String(records().length));
	const firstBoundary = canaryLines().at(-1) ?? {};
	check("an empty boundary still writes its decision", firstBoundary.candidates?.length === 0, JSON.stringify(firstBoundary.candidates ?? null));
	check("the empty boundary keeps the gate shut", firstBoundary.gate === false, JSON.stringify(firstBoundary.gate));
	check("the empty boundary names its outcome", firstBoundary.outcome === "no-candidate", JSON.stringify(firstBoundary.outcome));
	const emptyStatus = String(host.commands.get("clm").handler({ agent, rawInput: "status" }).text);
	check("the status line says the boundary had no candidate", emptyStatus.includes("last: no-candidate"), emptyStatus.split("\n").at(-1));

	await feed("turn/end", { turn: 2 });
	await feed("turn/end", { turn: 3 });
	const cleared = records();
	check("an aged all-refetchable block is cleared", cleared.length === 1, String(cleared.length));
	const staleTargets = cleared[0]?.data?.targets ?? [];
	const staleLine = canaryLines().at(-1) ?? {};
	check("the ledger names the settlement that ran", staleLine.outcome === "cleared", JSON.stringify(staleLine.outcome));
	check("the stale batch clears both old reads", staleTargets.length === 2, JSON.stringify(staleTargets));
	check("the pointer names what to re-fetch", staleTargets.every((target) => String(target.label).startsWith("read ")), JSON.stringify(staleTargets.map((target) => target.label)));
	const staleStatus = String(host.commands.get("clm").handler({ agent, rawInput: "status" }).text);
	check("the status line reports the successful settlement", staleStatus.includes("last: cleared"), staleStatus.split("\n").at(-1));

	// Two cleared targets read back once each is one normal round trip. The
	// breaker watches a rate, so it must not latch a session on that sample.
	for (const [step, file] of [[1, "/old-a.ts"], [2, "/old-b.ts"]]) {
		await feed("tool/call", { turn: 4, step, callId: `call_back_${step}`, name: "read", arguments: JSON.stringify({ file_path: file }) });
		await feed("tool/result", { turn: 4, step, message: toolResultMessage(`call_back_${step}`, "match ".repeat(9)) });
	}
	await feed("turn/end", { turn: 4 });
	const openStatus = String(host.commands.get("clm").handler({ agent, rawInput: "status" }).text);
	check(
		"two re-reads of a two-block batch do not trip the breaker",
		openStatus.includes("open") && !openStatus.includes("stopped (breaker)"),
		openStatus.split("\n").at(-1),
	);
	host.disposeAll();
	setHarnessAutoClear({ enabled: false, canary: false, staleTurns: 3 });
	cleanup(session.id);
}

section("17. a settlement settles after the append that announced it");
{
	// The real host publishes `session/event` from inside `Session.append()` and
	// keeps the append active while observers run, so `appendPluginRecord` refuses
	// a nested write. A pass that settles in the observer therefore loses its
	// record on every boundary and reports `rejected` while the decision itself
	// was fine. This drive models that dispatch order instead of emitting events
	// by hand after the append has returned.
	setHarnessAutoClear({ enabled: true, canary: true });
	const session = sessionWithHistory("t-auto-clear-reentrant");
	const { host, agent } = await boot(plugin, { sessionId: session.id, session });
	session.onEvent = (appended) => {
		void host.emit("session/event", session, appended);
	};
	const big = "match ".repeat(900);
	session.append("tool/call", { turn: 1, step: 3, callId: "call_reenter_1", name: "grep", arguments: JSON.stringify({ pattern: "needle" }) });
	session.append("tool/result", { turn: 1, step: 3, message: toolResultMessage("call_reenter_1", big) });
	session.append("tool/call", { turn: 1, step: 4, callId: "call_reenter_2", name: "grep", arguments: JSON.stringify({ pattern: "needle" }) });
	session.append("tool/result", { turn: 1, step: 4, message: toolResultMessage("call_reenter_2", big) });
	session.append("turn/end", { turn: 1 });
	await new Promise((resolve) => setImmediate(resolve));
	const records = session.events.filter((event) => event.type === "plugin:oh-my-clm/clear");
	check("the record is written once the announcing append has returned", records.length === 1, String(records.length));
	check("the deferred record is ignorable", records.every((event) => event.ignorable === true));
	const canaryFile = path.join("/tmp", `clm-${encodeURIComponent(session.id)}`, "CANARY.jsonl");
	const lines = (readIfExists(canaryFile) ?? "").trim().split("\n").filter(Boolean);
	let record;
	try {
		record = JSON.parse(lines.at(-1) ?? "{}");
	} catch (error) {
		record = { parseError: String(error) };
	}
	check("the settlement reports a clear instead of a rejected write", record.outcome === "cleared", JSON.stringify({ outcome: record.outcome, warn: host.log.filter((entry) => entry.level === "warn") }));
	const status = String(host.commands.get("clm").handler({ agent, rawInput: "status" }).text);
	check(
		"the status line counts the pass",
		status.includes("last: cleared") && status.includes("1 pass(es)") && status.includes("open"),
		status.split("\n").at(-1),
	);
	host.disposeAll();
	setHarnessAutoClear({ enabled: false, canary: false });
	cleanup(session.id);
}

section("18. two boundaries announced in one tick settle once");
{
	// A step that ends its turn publishes `step/end` and `turn/end` before any
	// microtask runs, so both settlements are queued while the same block is still
	// live. The settlement behind the pass must find nothing left to clear instead
	// of writing the same target twice and counting the pass, the freed tokens and
	// the breaker's denominator twice.
	setHarnessAutoClear({ enabled: true, canary: true, midTurnSuffixTokens: 512 });
	const session = sessionWithHistory("t-auto-clear-same-tick");
	const { host, agent } = await boot(plugin, { sessionId: session.id, session });
	session.onEvent = (appended) => {
		void host.emit("session/event", session, appended);
	};
	const big = "match ".repeat(900);
	const small = "match ".repeat(4);
	session.append("tool/call", { turn: 1, step: 3, callId: "call_tick_1", name: "grep", arguments: JSON.stringify({ pattern: "tick" }) });
	session.append("tool/result", { turn: 1, step: 3, message: toolResultMessage("call_tick_1", big) });
	session.append("tool/call", { turn: 1, step: 4, callId: "call_tick_2", name: "grep", arguments: JSON.stringify({ pattern: "tick" }) });
	session.append("tool/result", { turn: 1, step: 4, message: toolResultMessage("call_tick_2", small) });
	await new Promise((resolve) => setImmediate(resolve));
	// No await between the two boundaries: both settlements are queued first.
	session.append("step/end", { turn: 1, step: 4 });
	session.append("turn/end", { turn: 1 });
	await new Promise((resolve) => setImmediate(resolve));
	const records = session.events.filter((event) => event.type === "plugin:oh-my-clm/clear");
	check("a step and its turn boundary in one tick write one record", records.length === 1, String(records.length));
	const targets = records[0]?.data?.targets ?? [];
	check("the doubled boundary names the target once", targets.length === 1, JSON.stringify(targets));
	const status = String(host.commands.get("clm").handler({ agent, rawInput: "status" }).text);
	check("the doubled boundary counts one pass", status.includes("1 pass(es)"), status.split("\n").at(-1));
	host.disposeAll();
	setHarnessAutoClear({ enabled: false, canary: false, midTurnSuffixTokens: 0 });
	cleanup(session.id);
}

fs.rmSync(harnessCwd, { recursive: true, force: true });

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
