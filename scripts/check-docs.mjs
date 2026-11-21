#!/usr/bin/env node
/**
 * Keep user-facing docs to current contracts.
 *
 * Docs rot when they accumulate history and rationale that already live
 * somewhere else. The rules are:
 *
 *   1. Release history belongs to `git log`. A feature doc or the README must
 *      not narrate an old version or a previous design.
 *   2. Design rationale belongs to the source comment that owns the behavior.
 *      Docs point at that file instead of copying its prose.
 *
 * This checker enforces the mechanical half: no release version, no
 * retrospective wording, no "why" chapter, and no long sentence copied
 * verbatim from a source comment. The judgment half is in AGENTS.md.
 *
 * Run with: npm run check (wired into the check script) or directly:
 *   node scripts/check-docs.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC_PATTERN = /\.md$/;
const SOURCE_PATTERN = /\.(?:ts|mts|cts)$/;
const HISTORY_PATTERN = /(?:\bpreviously\b|\bused to\b|\bwas removed\b|\bhas been removed\b|\bold implementation\b|曾|早期|以前|此前|后来|旧版|旧实现|原实现|本版|实测)/;
const RATIONALE_HEADING_PATTERN = /^#{1,6}\s.*(?:为什么|历史|背景|变更|演进)/;
const COPIED_PROSE_MIN_CHARS = 50;

function walk(directory) {
	const files = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...walk(fullPath));
		else if (DOC_PATTERN.test(entry.name)) files.push(fullPath);
	}
	return files;
}

function walkSources(directory) {
	const files = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...walkSources(fullPath));
		else if (SOURCE_PATTERN.test(entry.name)) files.push(fullPath);
	}
	return files;
}

function relativeId(file) {
	return path.relative(root, file).split(path.sep).join("/");
}

// The only version a doc may not name is the one being shipped, so the version
// list comes from package.json (the release itself). History has no file to
// read: `git log` is the record.
function releaseVersions() {
	const packageVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
	return typeof packageVersion === "string" ? [packageVersion] : [];
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commentCorpus() {
	const comments = [];
	for (const file of [...walkSources(path.join(root, "src")), ...walkSources(path.join(root, "extensions")), ...walkSources(path.join(root, "dsh"))]) {
		const source = fs.readFileSync(file, "utf8");
		for (const match of source.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)) {
			comments.push(match[0].replace(/^\s*\/\*+|\*+\/\s*$|^\s*\/\/|\s*\*\s?/gm, " "));
		}
	}
	return comments.map(normalize).join(" \n ");
}

function normalize(value) {
	return value.replace(/\s+/g, " ").trim();
}

function docProse(lines) {
	const prose = [];
	let fenced = false;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trimStart().startsWith("```")) {
			fenced = !fenced;
			continue;
		}
		if (!fenced) prose.push({ line: index + 1, text: line });
	}
	return prose;
}

const versions = releaseVersions();
const versionPattern = versions.length === 0 ? undefined : new RegExp(`\\b(?:${versions.map(escapeRegExp).join("|")})\\b`);
const comments = commentCorpus();
const docs = [path.join(root, "README.md"), ...walk(path.join(root, "docs"))];
const problems = [];

for (const file of docs) {
	const id = relativeId(file);
	const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
	for (const { line: lineNumber, text } of docProse(lines)) {
		if (RATIONALE_HEADING_PATTERN.test(text)) {
			problems.push(`${id}:${lineNumber}: rationale/revision heading; keep "why" in the source comment or git log`);
		}
		if (versionPattern === undefined) continue;
		const version = versionPattern.exec(text);
		if (version !== null) {
			problems.push(`${id}:${lineNumber}: release version "${version[0]}"; history belongs to git log`);
		}
		const history = HISTORY_PATTERN.exec(text);
		if (history !== null) {
			problems.push(`${id}:${lineNumber}: retrospective wording "${history[0]}"; history belongs to git log`);
		}
	}
	for (const { line: lineNumber, text } of docProse(lines)) {
		for (const sentence of text.split(/[。！？!?]/)) {
			const normalized = normalize(sentence);
			if (normalized.length < COPIED_PROSE_MIN_CHARS) continue;
			if (comments.includes(normalized)) {
				problems.push(`${id}:${lineNumber}: prose is copied from a source comment; link to the file instead`);
			}
		}
	}
}

if (problems.length > 0) {
	throw new Error(`docs duplicate code comments or git history:\n  ${problems.join("\n  ")}`);
}
console.log(`docs ok: ${docs.length} files, no release versions, retrospective wording, or copied comment prose`);
