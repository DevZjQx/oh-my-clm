import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const manifest = readJson("dsh-plugin.json");
const packageJson = readJson("package.json");

if (manifest.manifestVersion !== "0.15") throw new Error("dsh-plugin.json must use manifestVersion 0.15");
if (typeof manifest.$schema !== "string" || !/^https?:\/\//.test(manifest.$schema)) throw new Error("DSH manifest must declare an absolute schema URI");
if (manifest.name !== packageJson.name || manifest.version !== packageJson.version) throw new Error("DSH manifest/package metadata differ");
if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/.test(manifest.id)) throw new Error("invalid DSH manifest id");
if (manifest.facets?.host?.apiVersion !== "v1alpha1") throw new Error("DSH host apiVersion must be v1alpha1");
if (!Array.isArray(manifest.permissions) || manifest.permissions.some((permission) => typeof permission?.name !== "string" || typeof permission?.scope !== "string")) {
  throw new Error("DSH permissions must declare names and scopes");
}
const entry = manifest.facets?.host?.entry;
if (typeof entry !== "string" || entry.startsWith("/") || entry.includes("..")) throw new Error("invalid DSH host entry");
if (!fs.existsSync(path.join(root, entry))) throw new Error(`DSH host entry is missing: ${entry}`);
if (packageJson.dsh?.bundle?.patch !== "./cordis.patch.yml") throw new Error("package.json must expose the official DSH bundle patch");
if (packageJson.devDependencies?.["@deepseek-ai/dsh-tools"] !== "0.2.0-rc.2") throw new Error("package.json must pin the DSH tool schema runtime for builds");
if (packageJson.icon !== "./icon.svg") throw new Error("package.json must declare ./icon.svg as its display icon");
// Keywords drive npm search for both the Pi package and the DSH tarball that
// scripts/build-dsh-plugin.mjs derives from them; guard the shape here so a typo
// surfaces before a release instead of after a publish nobody can edit.
if (!Array.isArray(packageJson.keywords) || packageJson.keywords.length === 0) {
  throw new Error("package.json must declare search keywords");
}
if (packageJson.keywords.some((keyword) => typeof keyword !== "string" || !/^[a-z0-9][a-z0-9.+-]*$/.test(keyword))) {
  throw new Error("package.json keywords must be lowercase single-token strings");
}
if (new Set(packageJson.keywords).size !== packageJson.keywords.length) {
  throw new Error("package.json keywords must be unique");
}
if (!packageJson.keywords.includes("pi-package")) {
  throw new Error('package.json keywords must keep the "pi-package" host marker');
}
// DSH reads `<pkg>/package.json` through the exports map; without this entry the
// manifest is unreachable and the plugin silently falls back to the default icon.
if (packageJson.exports?.["./package.json"] !== "./package.json") throw new Error('package.json must export "./package.json" for DSH display metadata');
if (packageJson.exports?.["./icon"] !== "./icon.svg") throw new Error('package.json must export "./icon"');
if (!fs.existsSync(path.join(root, "cordis.patch.yml"))) throw new Error("cordis.patch.yml is missing");
for (const resource of ["icon.svg", "locale/en.json", "locale/zh.json"]) {
  if (!fs.existsSync(path.join(root, resource))) throw new Error(`DSH display resource is missing: ${resource}`);
}
console.log(`DSH package check passed: ${entry}`);
