import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

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
	assert.equal(fs.existsSync(path.join(root, "locale/en.json")), true);
	assert.equal(fs.existsSync(path.join(root, "locale/zh.json")), true);
	assert.equal(fs.existsSync(path.join(root, "icon.svg")), true);
});
