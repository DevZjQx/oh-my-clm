#!/usr/bin/env node
/**
 * Enforce the one-way dependency rule for this repository.
 *
 * Layers, from the bottom up:
 *
 *   src/lib/**                        shared, domain-free infrastructure
 *   src/features/<feature>/**         one business domain per folder
 *   extensions/**, dsh/**             host adapters (Pi, DeepSeek Harness)
 *   test/**                           tests may import every layer
 *
 * Allowed imports:
 *   - shared   -> shared
 *   - feature  -> shared, its own files
 *   - host     -> shared, features
 *   - test     -> anything
 *
 * Everything else is a violation. Features must not import each other: compose
 * them in a host adapter, or lift the shared piece into src/lib. src/lib must
 * stay domain-free so it can be reused by every feature.
 *
 * Run with: npm run check (wired into the check script) or directly:
 *   node scripts/check-boundaries.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATTERN = /\.(?:ts|mts|cts|js|mjs)$/;
const IMPORT_PATTERN = /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g;

function walk(directory) {
	const files = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...walk(fullPath));
		else if (SOURCE_PATTERN.test(entry.name)) files.push(fullPath);
	}
	return files;
}

function relativeId(file) {
	return path.relative(root, file).split(path.sep).join("/");
}

function layerOf(file) {
	const id = relativeId(file);
	if (id.startsWith("src/lib/")) return { kind: "shared", id };
	const feature = /^src\/features\/([^/]+)\//.exec(id);
	if (feature) return { kind: "feature", id: feature[1] };
	if (id.startsWith("src/")) return { kind: "shared", id };
	if (id.startsWith("extensions/") || id.startsWith("dsh/")) return { kind: "host", id: id.split("/")[0] };
	if (id.startsWith("test/")) return { kind: "test", id };
	return { kind: "other", id };
}

function importsOf(file) {
	const files = [];
	const source = fs.readFileSync(file, "utf8");
	for (const match of source.matchAll(IMPORT_PATTERN)) {
		const specifier = match[1];
		if (!specifier.startsWith(".")) continue;
		files.push(path.resolve(path.dirname(file), specifier));
	}
	return files;
}

function violation(importer, target) {
	if (importer.kind === "other" || importer.kind === "test") return undefined;
	if (target.kind === "other") return undefined;
	if (importer.kind === "shared") {
		return target.kind === "shared" ? undefined : `shared module imports ${target.kind} "${target.id}"`;
	}
	if (importer.kind === "feature") {
		if (target.kind === "shared") return undefined;
		if (target.kind === "host") return `feature imports host adapter "${target.id}"`;
		if (target.kind === "test") return "feature imports a test file";
		if (target.id !== importer.id) return `feature "${importer.id}" imports feature "${target.id}"`;
		return undefined;
	}
	if (importer.kind === "host") {
		return target.kind === "test" ? "host adapter imports a test file" : undefined;
	}
	return undefined;
}

const problems = [];
const rootSources = ["src", "extensions", "dsh", "test"].flatMap((directory) => {
	const absolute = path.join(root, directory);
	return fs.existsSync(absolute) ? walk(absolute) : [];
});

let checkedImports = 0;
for (const file of rootSources) {
	const importer = layerOf(file);
	for (const target of importsOf(file)) {
		checkedImports += 1;
		const reason = violation(importer, layerOf(target));
		if (reason) problems.push(`${relativeId(file)}: ${reason}`);
	}
}

// Barrel files hide ownership; import the concrete module instead.
if (fs.existsSync(path.join(root, "src"))) {
	for (const file of walk(path.join(root, "src"))) {
		if (path.basename(file) === "index.ts") problems.push(`${relativeId(file)}: barrel index file (import the concrete module instead)`);
		if (/export\s+\*\s+from/.test(fs.readFileSync(file, "utf8"))) {
			problems.push(`${relativeId(file)}: \`export * from\` re-export (import the concrete module instead)`);
		}
	}
}

if (problems.length > 0) {
	console.error("Module boundary violations:");
	for (const problem of problems) console.error(`  - ${problem}`);
	console.error(`\n${problems.length} violation(s). See docs/project-structure.md for the import rules.`);
	process.exitCode = 1;
} else {
	const files = new Set(rootSources);
	console.log(
		`Module boundaries OK: ${files.size} files, ${checkedImports} relative imports, layers shared -> features -> hosts.`,
	);
}
