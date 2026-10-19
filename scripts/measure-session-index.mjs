#!/usr/bin/env node
/**
 * Measure the block-index cost that the DSH bridge actually paid, from the
 * recorded session logs rather than from a synthetic fixture.
 *
 * The bridge contributes its block index through `systemPrompt.context()`,
 * which DSH turns into a `source.kind === "runtime-context"` user message.
 * DSH appends a new snapshot whenever the rendered text changes and never
 * removes older ones, so the snapshot count and byte total are the real cost
 * of the index design. This script reports that cost, the step gap between
 * snapshots (a working `CLM_INDEX_REFRESH_STEPS=4` throttle shows gaps of 4),
 * and the shape of every real `cleanup` call.
 *
 * Usage:
 *   node scripts/measure-session-index.mjs
 *   node scripts/measure-session-index.mjs --project .
 *   node scripts/measure-session-index.mjs --json
 *   node scripts/measure-session-index.mjs --root ~/.dsh/sessions
 *
 * Read-only: it never writes to the session store.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import {
	buildBlockDigestUnits,
	buildMirrorRecords,
	renderBlockDigest,
	renderBlockIndex,
} from "../src/features/live-context/context-format.ts";

const INDEX_OPEN = "<oh-my-clm-block-index>";
const INDEX_CLOSE = "</oh-my-clm-block-index>";

function parseArgs(argv) {
	const args = { root: path.join(homedir(), ".dsh", "sessions"), project: undefined, json: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--json") args.json = true;
		else if (arg === "--root") args.root = path.resolve(argv[++i] ?? "");
		else if (arg === "--project") args.project = path.resolve(argv[++i] ?? "");
		else if (arg === "--help" || arg === "-h") {
			console.log("usage: measure-session-index.mjs [--root DIR] [--project DIR] [--json]");
			process.exit(0);
		}
	}
	return args;
}

/** DSH escapes a cwd into the project directory name: `/a/b` -> `--a-b--`. */
function projectDirName(cwd) {
	return `--${cwd.replace(/^\/+|\/+$/g, "").replace(/\//g, "-")}--`;
}

function sessionFiles(root, project) {
	const dirs = [];
	if (project !== undefined) {
		const candidate = path.join(root, projectDirName(project));
		if (existsSync(candidate)) dirs.push(candidate);
	} else {
		for (const entry of readdirSync(root)) {
			const full = path.join(root, entry);
			if (statSync(full).isDirectory()) dirs.push(full);
		}
	}
	const files = [];
	for (const dir of dirs) {
		for (const entry of readdirSync(dir)) {
			const full = path.join(dir, entry);
			if (!statSync(full).isDirectory()) continue;
			for (const name of ["session.v4.jsonl.zstd", "session.jsonl.zstd"]) {
				const file = path.join(full, name);
				if (existsSync(file)) files.push(file);
			}
		}
	}
	return files;
}

function readEvents(file) {
	const text = file.endsWith(".zstd")
		? zstdDecompressSync(readFileSync(file)).toString("utf8")
		: readFileSync(file, "utf8");
	return text
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
}

function messageText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part?.text === "string" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
}

function eventMessage(event) {
	if (event.type === "user/message") return event.data;
	return event.data?.message;
}

function isSurfaceMessage(type) {
	return type === "system/message"
		|| type === "developer/message"
		|| type === "user/message"
		|| type === "assistant/message"
		|| type === "tool/result";
}

/**
 * Rebuild the bridge's projection view from the append-only log: keep the
 * events that are still on the active surface and convert them into the
 * provenance shape `buildMirrorRecords` expects. The bridge additionally
 * drops `source.kind === "runtime-context"` messages; the same filter runs
 * here so the measured block count matches what the model saw.
 */
function surfaceEntries(events) {
	const shadowed = new Set();
	for (const event of events) {
		const op = event.surfaceOp ?? event.data?.surfaceOp;
		if (op?.op !== "replace") continue;
		for (let seq = op.startSeq; seq <= op.endSeq; seq += 1) shadowed.add(seq);
	}
	const entries = [];
	for (const event of events) {
		if (!isSurfaceMessage(event.type) || shadowed.has(event.seq)) continue;
		const message = eventMessage(event);
		if (!message) continue;
		if (message.source?.kind === "runtime-context") continue;
		entries.push({
			sourceEntry: { id: `dsh:${String(event.seq)}`, type: "message" },
			messages: [message],
		});
	}
	return entries;
}

/**
 * Count how often the rendered digest text changes while the surface grows.
 * DSH appends a runtime-context snapshot only when the text differs, so this
 * replay is the predicted snapshot count for digest mode. A turn-stable digest
 * changes once per completed unit instead of once per step.
 */
function digestRenderCount(entries) {
	let renders = 0;
	let previous;
	for (let index = 1; index <= entries.length; index += 1) {
		const text = renderBlockDigest(buildMirrorRecords(entries.slice(0, index)));
		if (text !== previous) {
			renders += 1;
			previous = text;
		}
	}
	return renders;
}

function cleanupCalls(events) {
	const calls = [];
	for (const event of events) {
		if (event.type !== "tool/call") continue;
		const message = eventMessage(event) ?? event.data;
		if (message?.name !== "cleanup") continue;
		const raw = message.arguments ?? message.input ?? event.data?.arguments;
		let parsed = raw;
		if (typeof raw === "string") {
			try {
				parsed = JSON.parse(raw);
			} catch {
				parsed = undefined;
			}
		}
		calls.push({
			blockIds: Array.isArray(parsed?.blockIds) ? parsed.blockIds : [],
			hasRange: Array.isArray(parsed?.ranges) || parsed?.from !== undefined,
		});
	}
	return calls;
}

function measure(file) {
	const events = readEvents(file);
	const entries = surfaceEntries(events);
	const records = buildMirrorRecords(entries);
	const editable = records.filter((record) => !record.protected);
	const blockIndex = renderBlockIndex(records);
	const digest = renderBlockDigest(records);
	const digestUnits = buildBlockDigestUnits(records);

	let steps = 0;
	let snapshots = 0;
	let snapshotBytes = 0;
	let maxSnapshotBytes = 0;
	let lastSnapshotStep = null;
	const gaps = {};
	// The index shape is visible in the snapshot text, so a session that switched
	// modes mid-flight can be compared per mode instead of in aggregate.
	const modes = {};
	const lastStepByMode = {};
	for (const event of events) {
		if (event.type === "step/start") steps += 1;
		const message = eventMessage(event);
		if (event.type !== "user/message" || message?.source?.kind !== "runtime-context") continue;
		const text = messageText(message);
		if (!text.includes(INDEX_OPEN)) continue;
		const mode = text.includes("One line per turn") ? "digest" : "blocks";
		const bytes = Buffer.byteLength(text, "utf8");
		const perMode = modes[mode] ?? { snapshots: 0, bytes: 0, maxBytes: 0, gaps: {} };
		perMode.snapshots += 1;
		perMode.bytes += bytes;
		perMode.maxBytes = Math.max(perMode.maxBytes, bytes);
		if (lastStepByMode[mode] !== undefined) {
			const gap = String(steps - lastStepByMode[mode]);
			perMode.gaps[gap] = (perMode.gaps[gap] ?? 0) + 1;
		}
		lastStepByMode[mode] = steps;
		modes[mode] = perMode;

		snapshots += 1;
		snapshotBytes += bytes;
		maxSnapshotBytes = Math.max(maxSnapshotBytes, bytes);
		if (lastSnapshotStep !== null) {
			const gap = String(steps - lastSnapshotStep);
			gaps[gap] = (gaps[gap] ?? 0) + 1;
		}
		lastSnapshotStep = steps;
	}

	return {
		session: path.basename(path.dirname(file)),
		bytes: statSync(file).size,
		steps,
		editable: editable.length,
		snapshots,
		snapshotBytes,
		avgSnapshotBytes: snapshots === 0 ? 0 : Math.round(snapshotBytes / snapshots),
		maxSnapshotBytes,
		gaps,
		modes,
		blocksBytes: Buffer.byteLength(blockIndex, "utf8"),
		digestBytes: Buffer.byteLength(digest, "utf8"),
		digestUnits: digestUnits.filter((unit) => !unit.open).length,
		digestRenders: digestRenderCount(entries),
		openRunBlocks: digestUnits.find((unit) => unit.open)?.records.length ?? 0,
		cleanupCalls: cleanupCalls(events),
	};
}

function pad(value, width) {
	return String(value).padStart(width);
}

function formatTable(rows) {
	const head = [
		"session",
		"steps",
		"blocks",
		"snaps",
		"index bytes",
		"avg",
		"max",
		"blocks idx",
		"digest",
		"units",
		"digest renders",
		"open run",
		"gaps",
		"modes (snaps/bytes)",
		"cleanup calls",
	].map((label) => label.toUpperCase());
	const body = rows.map((row) => [
		row.session.slice(0, 24),
		pad(row.steps, 5),
		pad(row.editable, 6),
		pad(row.snapshots, 5),
		pad(row.snapshotBytes, 11),
		pad(row.avgSnapshotBytes, 6),
		pad(row.maxSnapshotBytes, 6),
		pad(row.blocksBytes, 10),
		pad(row.digestBytes, 6),
		pad(row.digestUnits, 5),
		pad(row.digestRenders, 8),
		pad(row.openRunBlocks, 8),
		Object.entries(row.gaps).map(([gap, count]) => `${gap}x${String(count)}`).join(" ") || "-",
		Object.entries(row.modes).map(([mode, value]) => `${mode} ${String(value.snapshots)}/${String(value.bytes)}`).join(" ") || "-",
		row.cleanupCalls.length === 0 ? "-" : row.cleanupCalls.map((call) => `${String(call.blockIds.length)} ids`).join(", "),
	]);
	const widths = head.map((label, column) =>
		Math.max(label.length, ...body.map((row) => String(row[column] ?? "").length)),
	);
	const line = (cells) => cells.map((cell, column) => String(cell).padEnd(widths[column])).join("  ");
	return [line(head), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join("\n");
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!existsSync(args.root)) {
		console.error(`no session store at ${args.root}`);
		process.exit(1);
	}
	const files = sessionFiles(args.root, args.project);
	if (files.length === 0) {
		console.error(`no sessions found under ${args.root}`);
		process.exit(1);
	}
	const rows = files.map(measure).sort((a, b) => b.snapshotBytes - a.snapshotBytes);
	if (args.json) {
		console.log(JSON.stringify(rows, null, 2));
		return;
	}
	console.log(formatTable(rows));
	const totals = rows.reduce((sum, row) => ({
		snapshots: sum.snapshots + row.snapshots,
		bytes: sum.bytes + row.snapshotBytes,
	}), { snapshots: 0, bytes: 0 });
	console.log(`\ntotal: ${String(totals.snapshots)} index snapshots, ${String(totals.bytes)} bytes`);
	const gappy = rows.filter((row) => Object.keys(row.gaps).some((gap) => gap !== "1"));
	console.log(
		gappy.length === 0
			? "every measured session refreshed the index once per step (throttle never fired)"
			: `sessions with a non-1 step gap: ${gappy.map((row) => row.session).join(", ")}`,
	);
}

main();
