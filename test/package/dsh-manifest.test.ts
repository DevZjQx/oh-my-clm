import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CLM_TEMP_ROOT } from "../../src/lib/clm-paths.ts";

const root = path.resolve(import.meta.dirname, "../..");

function json(file: string): any {
	return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

test("DSH community manifest and official bundle metadata point at the built host", () => {
	const manifest = json("dsh-plugin.json");
	const packageJson = json("package.json");
	const entry = manifest.facets.host.entry as string;
	assert.equal(manifest.manifestVersion, "0.15");
	assert.equal(manifest.name, packageJson.name);
	assert.equal(manifest.version, packageJson.version);
	assert.equal(manifest.facets.host.apiVersion, "v1alpha1");
	assert.match(manifest.id, /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/);
	assert.equal(entry.includes(".."), false);
	assert.equal(fs.existsSync(path.join(root, entry)), true);
	assert.equal(packageJson.dsh.bundle.patch, "./cordis.patch.yml");
	assert.equal(packageJson.icon, "./icon.svg");
	assert.equal(packageJson.exports["./package.json"], "./package.json");
	assert.equal(packageJson.exports["./icon"], "./icon.svg");
	assert.equal(fs.existsSync(path.join(root, "locale/en.json")), true);
	assert.equal(fs.existsSync(path.join(root, "locale/zh.json")), true);
	assert.equal(fs.existsSync(path.join(root, "icon.svg")), true);
});

// P1-6: a declared fs permission scope must describe
// where the plugin actually writes. Artifacts live in the host temp root, so a
// "workspace" scope is a decorative claim that implies isolation it cannot give.
// The DSH-only tarball is staged from a file list. That list silently drifted
// once (auto-clear, clear-projection, plugin-record, context-prompt,
// context-trigger and clm-config were imported but not shipped), so the host
// entry's relative imports must all exist in the built tree before packing.
test("the DSH host entry's relative imports are all present in the build", () => {
	const entry = path.join(root, json("dsh-plugin.json").facets.host.entry as string);
	const importPattern = /(?:from\s*|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
	const visited = new Set<string>();
	const walk = (file: string): void => {
		if (visited.has(file)) return;
		visited.add(file);
		const source = fs.readFileSync(file, "utf8");
		for (const match of source.matchAll(importPattern)) {
			const target = path.resolve(path.dirname(file), match[1] as string);
			assert.equal(fs.existsSync(target), true, `${path.relative(root, target)} is imported but missing`);
			if (target.endsWith(".js")) walk(target);
		}
	};
	walk(entry);
	assert.ok(visited.size >= 10, `only ${visited.size} runtime files reachable from the host entry`);
});

test("plan §3.7 (P1-6): manifest fs scopes match the real artifact root", () => {
	const manifest = json("dsh-plugin.json");
	const workspace = path.resolve(import.meta.dirname, "../..");
	const tempRoot = path.resolve(CLM_TEMP_ROOT);
	const insideWorkspace = tempRoot === workspace || tempRoot.startsWith(workspace + path.sep);
	for (const permission of manifest.permissions as Array<{ name: string; scope: string; reason: string }>) {
		if (!/fs\.(read|write)$/.test(permission.name)) continue;
		assert.ok(
			permission.scope !== "workspace" || insideWorkspace,
			`${permission.name} claims "workspace" scope but artifacts are written under ${CLM_TEMP_ROOT}`,
		);
	}
});
