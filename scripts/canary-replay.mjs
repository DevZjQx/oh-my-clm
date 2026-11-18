#!/usr/bin/env node
/**
 * Replay a stored DSH session log through the clearing canary's selector.
 *
 * The canary decides, at a turn boundary, which tool-result blocks a clearing
 * pass would free. Running the same selector over logs that were already
 * recorded answers two questions without a model call: whether the trigger
 * fires at all in this workload, and how large one tail-rolling batch is, which
 * is what `autoClear.minTokens` / `autoClear.minBlocks` are calibrated on.
 *
 * Usage: node scripts/canary-replay.mjs <session.v4.jsonl.zstd> [...more]
 *        node scripts/canary-replay.mjs --all [--limit N] [--sessions-root DIR]
 *        [--stale-turns N] [--stale-steps N] [--max-age-steps N] [--discount R]
 *        [--payback N]
 *
 * Requires a completed `npm run build:dsh`, because it imports the compiled
 * selector rather than re-implementing it. Stored logs are zstd-compressed, so
 * the `zstd` binary must be on PATH (the plugin itself does not need it).
 *
 * The replay mirrors the live semantics, not just the selector: a batch the gate
 * rejects leaves its candidates pending, so the next boundary decides again with
 * the accumulated set, and only a passing batch retires what it cleared. A
 * replay that consumed on every boundary would under-report exactly the
 * accumulation the small gate exists for.
 *
 * Every passing batch also reports what it would have cost: `suffixTokens` is
 * the one-time re-prefill the plugin itself records, and `net` prices the
 * batch as `r·ΔL − (1−r)·S / N` with the same discount and payback horizon
 * the money channel reads from the config. A batch with a negative net is a
 * quality decision, not a saving; the summary says so instead of adding it
 * into the freed total.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const selectorPath = new URL("../dist/src/features/live-context/auto-clear.js", import.meta.url);
if (!existsSync(selectorPath)) {
	console.error("build the plugin first: npm run build:dsh");
	process.exit(2);
}
const {
	DEFAULT_BATCH_GATE,
	DEFAULT_MAX_AGE_STEPS,
	DEFAULT_STALE_STEPS,
	DEFAULT_STALE_TURNS,
	SupersessionTracker,
	batchNetTokens,
	batchPassesGate,
	parseToolArguments,
} = await import(
	selectorPath.href
);

const DEFAULT_SESSIONS_ROOT = join(homedir(), ".dsh", "sessions");
const REFETCH = ["read", "read_image", "grep", "glob", "web_fetch"];
const SURFACE_EVENT_TYPES = new Set(["system/message", "developer/message", "user/message", "assistant/message", "tool/result"]);

function readEvents(file) {
	let raw;
	try {
		raw = file.endsWith(".zstd")
			? execFileSync("zstd", ["-dc", file], { maxBuffer: 1 << 28 }).toString()
			: execFileSync("cat", [file]).toString();
	} catch (error) {
		const hint = file.endsWith(".zstd")
			? " (reading a .zstd log needs the `zstd` binary: apt install zstd / brew install zstd)"
			: "";
		throw new Error(`cannot read ${file}${hint}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const events = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			// A torn tail line is not a replay failure; earlier events are valid.
		}
	}
	return events;
}

function textOf(content) {
	if (Array.isArray(content)) return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("");
	return "";
}

/** Estimate like the plugin does: 3.5 chars/token, CJK counted per character. */
function estimate(text) {
	let wide = 0;
	for (const char of text) if (/[\u3000-\u9fff\uff00-\uffef]/.test(char)) wide += 1;
	return Math.ceil((wide * 3.5 + (text.length - wide)) / 3.5);
}

/** One boundary's decision: what a live pass would have looked at, and whether it ran. */
function decide(tracker, turn, batches, suffixOf) {
	const batch = tracker.peekBatch(typeof turn === "number" && Number.isSafeInteger(turn) ? turn : undefined);
	if (batch.candidates.length === 0) return;
	const gate = batchPassesGate(batch);
	const suffix = suffixOf(batch);
	batches.push({ turn, gate, suffixTokens: suffix, ...batch });
	// A passing pass is the only thing that clears: retire exactly its candidates,
	// so a rejected batch stays available for the next boundary.
	if (gate) tracker.retire(batch.candidates.map((candidate) => candidate.blockId));
}

/**
 * The model-visible surface as the host sees it: one estimated size per
 * message node, in log order. The plugin computes the same view from
 * `session.surface.nodes` + `snapshotEvents()`; the replay has only the log,
 * which is the stream the surface was built from.
 */
class ReplaySurface {
	#tokens = new Map();
	#nodes = [];

	note(event) {
		if (!SURFACE_EVENT_TYPES.has(event.type)) return;
		const data = event.data ?? {};
		const message = event.type === "user/message"
			? (data && typeof data === "object" ? data : undefined)
			: (data?.message && typeof data.message === "object" ? data.message : undefined);
		if (!message) return;
		this.#tokens.set(event.seq, estimate(textOf(message.content)));
		this.#nodes.push(event.seq);
	}

	/** Model-visible tokens from `seq` (exclusive) to the nodes seen so far. */
	after(seq) {
		const nodes = this.#nodes;
		let low = 0;
		let high = nodes.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if ((nodes[mid] ?? 0) <= seq) low = mid + 1;
			else high = mid;
		}
		let sum = 0;
		for (let index = low; index < nodes.length; index += 1) sum += this.#tokens.get(nodes[index] ?? 0) ?? 0;
		return sum;
	}
}

/**
 * `batchSuffixTokens` at the boundary: the model-visible tail behind the
 * batch's earliest cleared block, minus the bodies the same batch removes.
 * The tail is measured at the boundary — the suffix a live pass would pay is
 * the requests still to come, not the whole log. `undefined` when no
 * candidate names a surface node.
 */
function batchSuffix(surface, batch) {
	const usable = batch.candidates.filter((candidate) => Number.isSafeInteger(candidate.seq) && candidate.seq >= 0);
	if (usable.length === 0) return undefined;
	const earliest = Math.min(...usable.map((candidate) => candidate.seq));
	const behind = surface.after(earliest);
	const removedBehind = usable
		.filter((candidate) => candidate.seq > earliest)
		.reduce((total, candidate) => total + Math.max(0, candidate.tokens), 0);
	return Math.max(0, behind - removedBehind);
}

/** Feed one session's events through the selector exactly as the host bridge does. */
function replay(file) {
	const tracker = new SupersessionTracker({ staleTurns, staleSteps, maxAgeSteps });
	const callSeqs = new Map();
	const batches = [];
	const events = readEvents(file);
	const surface = new ReplaySurface();
	for (const event of events) {
		const seq = event.seq;
		const data = event.data ?? {};
		if (typeof seq !== "number") continue;
		surface.note(event);
		if (event.type === "tool/call" && REFETCH.includes(data.name)) {
			callSeqs.set(data.callId, seq);
			tracker.noteCall({
				name: data.name,
				args: parseToolArguments(data.arguments),
				blockId: data.callId,
				seq,
				blockAge: tracker.resultsSeen,
			});
		} else if (event.type === "tool/ptc-dispatch" && REFETCH.includes(data.name)) {
			tracker.noteCall({
				name: data.name,
				args: data.arguments,
				blockId: data.rootCallId,
				seq,
				blockAge: tracker.resultsSeen,
			});
			tracker.noteOutput(seq, estimate(textOf(data.content)));
		} else if (event.type === "tool/result") {
			const callId = data.message?.toolCallId;
			if (typeof callId !== "string") continue;
			const tokens = estimate(textOf(data.message.content));
			tracker.noteBlockLanding();
			tracker.noteBlockTokens(callId, tokens, seq, typeof data.turn === "number" ? data.turn : undefined);
			const callSeq = callSeqs.get(callId);
			if (callSeq !== undefined) {
				callSeqs.delete(callId);
				tracker.noteOutput(callSeq, tokens);
			}
		} else if (event.type === "turn/end") {
			decide(tracker, data.turn, batches, (batch) => batchSuffix(surface, batch));
		}
	}
	return batches;
}

function allSessionFiles(root) {
	const files = [];
	for (const directory of readdirSync(root)) {
		const inner = join(root, directory);
		for (const child of readdirSync(inner)) {
			const file = join(inner, child, "session.v4.jsonl.zstd");
			if (existsSync(file)) files.push({ file, size: statSync(file).size });
		}
	}
	return files.sort((a, b) => b.size - a.size);
}

const args = process.argv.slice(2);
const limitIndex = args.indexOf("--limit");
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 12;
const rootIndex = args.indexOf("--sessions-root");
const sessionsRoot = rootIndex >= 0 ? args[rootIndex + 1] : DEFAULT_SESSIONS_ROOT;
const staleIndex = args.indexOf("--stale-turns");
const staleTurns = staleIndex >= 0 ? Number(args[staleIndex + 1]) : DEFAULT_STALE_TURNS;
if (!Number.isSafeInteger(staleTurns) || staleTurns < 0) {
	console.error("--stale-turns needs a non-negative integer");
	process.exit(2);
}
const staleStepsIndex = args.indexOf("--stale-steps");
const staleSteps = staleStepsIndex >= 0 ? Number(args[staleStepsIndex + 1]) : DEFAULT_STALE_STEPS;
if (!Number.isSafeInteger(staleSteps) || staleSteps < 0) {
	console.error("--stale-steps needs a non-negative integer");
	process.exit(2);
}
const maxAgeIndex = args.indexOf("--max-age-steps");
const maxAgeSteps = maxAgeIndex >= 0 ? Number(args[maxAgeIndex + 1]) : DEFAULT_MAX_AGE_STEPS;
if (!Number.isSafeInteger(maxAgeSteps) || maxAgeSteps < 0) {
	console.error("--max-age-steps needs a non-negative integer (0 = unbounded)");
	process.exit(2);
}
const discountIndex = args.indexOf("--discount");
const discount = discountIndex >= 0 ? Number(args[discountIndex + 1]) : 0.02;
if (!Number.isFinite(discount) || discount < 0 || discount > 1) {
	console.error("--discount needs a fraction in [0, 1]");
	process.exit(2);
}
const paybackIndex = args.indexOf("--payback");
const payback = paybackIndex >= 0 ? Number(args[paybackIndex + 1]) : 10;
if (!Number.isSafeInteger(payback) || payback < 1) {
	console.error("--payback needs a positive integer");
	process.exit(2);
}
if (!sessionsRoot) {
	console.error("--sessions-root needs a directory");
	process.exit(2);
}
const valueOptions = new Set(["--limit", "--sessions-root", "--stale-turns", "--stale-steps", "--max-age-steps", "--discount", "--payback"]);
const positional = args.filter((arg, index) =>
	!arg.startsWith("--") && !valueOptions.has(args[index - 1] ?? ""),
);
const files = args.includes("--all") ? allSessionFiles(sessionsRoot).slice(0, limit) : positional;

let totals = {
	sessions: files.length, withCandidates: 0, batches: 0, passing: 0,
	tokens: 0, maxBatch: 0, suffix: 0, net: 0, priced: 0, unpriced: 0, losing: 0,
};
const rows = [];
for (const entry of files) {
	const file = typeof entry === "string" ? entry : entry.file;
	const batches = replay(file);
	// Tokens are what clearing would actually free: only passing batches run.
	const cleared = batches.filter((batch) => batch.gate);
	const tokens = cleared.reduce((total, batch) => total + batch.tokens, 0);
	// The cost side is priced only where the log could place the batch's suffix;
	// a negative net means the batch buys attention, not tokens.
	const priced = cleared.filter((batch) => batch.suffixTokens !== undefined);
	const nets = priced.map((batch) => batchNetTokens(batch.tokens, batch.suffixTokens, discount, payback));
	const net = nets.reduce((total, value) => total + value, 0);
	const suffix = priced.reduce((total, batch) => total + batch.suffixTokens, 0);
	const losing = nets.filter((value) => value < 0).length;
	const passing = cleared.length;
	const maxBatch = cleared.reduce((max, batch) => Math.max(max, batch.tokens), 0);
	totals.withCandidates += batches.length > 0 ? 1 : 0;
	totals.batches += batches.length;
	totals.passing += passing;
	totals.tokens += tokens;
	totals.suffix += suffix;
	totals.net += net;
	totals.priced += priced.length;
	totals.unpriced += cleared.length - priced.length;
	totals.losing += losing;
	totals.maxBatch = Math.max(totals.maxBatch, maxBatch);
	rows.push({
		session: file.replace(sessionsRoot + "/", "").replace("/session.v4.jsonl.zstd", ""),
		batches: batches.length,
		passing,
		tokens,
		maxBatch,
		suffix,
		net,
		losing,
	});
}

for (const row of rows) {
	console.log(
		`${String(row.batches).padStart(2)} boundaries  ${String(row.passing).padStart(2)} pass  ${String(row.tokens).padStart(7)} tok` +
		`  S ${String(row.suffix).padStart(7)}  net ${String(row.net).padStart(7)}  ${String(row.losing)} losing  ${row.session}`,
	);
}
const ratio = totals.tokens > 0 ? (totals.suffix / totals.tokens).toFixed(1) : "—";
console.log(
	`\n${totals.sessions} sessions · ${totals.withCandidates} with candidates · ${totals.batches} batches · ${totals.passing} pass the gate ` +
		`(${DEFAULT_BATCH_GATE.minTokens} tok / ${DEFAULT_BATCH_GATE.minBlocks} blocks) · ${totals.tokens} tokens · largest batch ${totals.maxBatch}`,
);
console.log(
	`cost: S ${totals.suffix} tokens (${ratio}× the freed ΔL) · net ${totals.net} at r=${discount} / N=${payback} ` +
		`· ${totals.losing}/${totals.priced} priced batches have net < 0` +
		`${totals.unpriced > 0 ? ` · ${totals.unpriced} unpriced (no suffix in the log)` : ""}`,
);
