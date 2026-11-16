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
 *        [--stale-turns N]
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
const { DEFAULT_BATCH_GATE, DEFAULT_STALE_TURNS, SupersessionTracker, batchPassesGate, parseToolArguments } = await import(
	selectorPath.href
);

const DEFAULT_SESSIONS_ROOT = join(homedir(), ".dsh", "sessions");
const REFETCH = ["read", "read_image", "grep", "glob", "web_fetch"];

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
function decide(tracker, turn, batches) {
	const batch = tracker.peekBatch(typeof turn === "number" && Number.isSafeInteger(turn) ? turn : undefined);
	if (batch.candidates.length === 0) return;
	const gate = batchPassesGate(batch);
	batches.push({ turn, gate, ...batch });
	// A passing pass is the only thing that clears: retire exactly its candidates,
	// so a rejected batch stays available for the next boundary.
	if (gate) tracker.retire(batch.candidates.map((candidate) => candidate.blockId));
}

/** Feed one session's events through the selector exactly as the host bridge does. */
function replay(file) {
	const tracker = new SupersessionTracker({ staleTurns });
	const callSeqs = new Map();
	const batches = [];
	for (const event of readEvents(file)) {
		const seq = event.seq;
		const data = event.data ?? {};
		if (typeof seq !== "number") continue;
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
			decide(tracker, data.turn, batches);
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
if (!sessionsRoot) {
	console.error("--sessions-root needs a directory");
	process.exit(2);
}
const valueOptions = new Set(["--limit", "--sessions-root", "--stale-turns"]);
const positional = args.filter((arg, index) =>
	!arg.startsWith("--") && !valueOptions.has(args[index - 1] ?? ""),
);
const files = args.includes("--all") ? allSessionFiles(sessionsRoot).slice(0, limit) : positional;

let totals = { sessions: files.length, withCandidates: 0, batches: 0, passing: 0, tokens: 0, maxBatch: 0 };
const rows = [];
for (const entry of files) {
	const file = typeof entry === "string" ? entry : entry.file;
	const batches = replay(file);
	// Tokens are what clearing would actually free: only passing batches run.
	const cleared = batches.filter((batch) => batch.gate);
	const tokens = cleared.reduce((total, batch) => total + batch.tokens, 0);
	const passing = cleared.length;
	const maxBatch = cleared.reduce((max, batch) => Math.max(max, batch.tokens), 0);
	totals.withCandidates += batches.length > 0 ? 1 : 0;
	totals.batches += batches.length;
	totals.passing += passing;
	totals.tokens += tokens;
	totals.maxBatch = Math.max(totals.maxBatch, maxBatch);
	rows.push({
		session: file.replace(sessionsRoot + "/", "").replace("/session.v4.jsonl.zstd", ""),
		batches: batches.length,
		passing,
		tokens,
		maxBatch,
	});
}

for (const row of rows) {
	console.log(
		`${String(row.batches).padStart(2)} boundaries  ${String(row.passing).padStart(2)} pass  ${String(row.tokens).padStart(7)} tok  max ${String(row.maxBatch).padStart(6)}  ${row.session}`,
	);
}
console.log(
	`\n${totals.sessions} sessions · ${totals.withCandidates} with candidates · ${totals.batches} batches · ${totals.passing} pass the gate ` +
		`(${DEFAULT_BATCH_GATE.minTokens} tok / ${DEFAULT_BATCH_GATE.minBlocks} blocks) · ${totals.tokens} tokens · largest batch ${totals.maxBatch}`,
);
