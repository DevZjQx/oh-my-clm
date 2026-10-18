#!/usr/bin/env node
/**
 * Build the DSH-only npm tarball.
 *
 * The repository is also a Pi package, so the normal `npm pack` contains the
 * Pi extension, sources, and development-facing files. DSH's plugin manager
 * only needs the host entry and its runtime assets; this script stages that
 * smaller package and packs it as a normal npm tarball. Host packages remain
 * optional peers so the plugin never installs a second copy into the profile.
 *
 * Usage:
 *   npm run build:dsh:plugin
 *   node scripts/build-dsh-plugin.mjs ./artifacts
 *   node scripts/build-dsh-plugin.mjs --output ./artifacts/plugin.tgz
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = path.join(root, "dsh-clm");
const dshRuntimeFiles = [
	"dist/dsh/index.js",
	"dist/src/clm-files.js",
	"dist/src/clm-paths.js",
	"dist/src/context-cleanup.js",
	"dist/src/context-format.js",
	"dist/src/dsh-bridge.js",
];
const packageFiles = ["README.md", "dsh-plugin.json", "cordis.patch.yml", "dist", "locale", "icon.svg"];
const dshRuntimePeerDependencies = {
	"@deepseek-ai/dsh-tools": "0.2.0-rc.2",
};

function usage() {
	console.log(`Usage: node scripts/build-dsh-plugin.mjs [output-dir | output-file.tgz]

Builds the DSH-only plugin tarball. The default output is:
  ${path.relative(root, defaultOutput)}/<name>-<version>.tgz

--output <path> and --output=<path> are also accepted.`);
}

function parseOutputArgument(args) {
	if (args.length === 0) return defaultOutput;
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		usage();
		process.exit(0);
	}
	if (args[0] === "--output" || args[0] === "--out-dir") {
		if (args.length !== 2) throw new Error(`${args[0]} requires a path`);
		return args[1];
	}
	if (args.length === 1 && args[0].startsWith("--output=")) {
		const value = args[0].slice("--output=".length);
		if (!value) throw new Error("--output requires a path");
		return value;
	}
	if (args.length !== 1 || args[0].startsWith("-")) {
		throw new Error("expected one output directory/file, or --output <path>");
	}
	return args[0];
}

function readJson(relativePath) {
	return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function run(command, args, cwd) {
	const executable = process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
	const result = spawnSync(executable, args, { cwd, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} exited with status ${result.status ?? "unknown"}`);
	}
}

function copyFile(relativePath, destinationRoot) {
	const source = path.join(root, relativePath);
	const destination = path.join(destinationRoot, relativePath);
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.copyFileSync(source, destination);
}

function assertBuildInputs(manifest, packageJson) {
	if (manifest.name !== packageJson.name || manifest.version !== packageJson.version) {
		throw new Error("dsh-plugin.json and package.json metadata differ");
	}
	const entry = manifest.facets?.host?.entry;
	if (entry !== "dist/dsh/index.js") {
		throw new Error(`unexpected DSH host entry: ${String(entry)}`);
	}
	for (const relativePath of dshRuntimeFiles) {
		if (!fs.existsSync(path.join(root, relativePath))) {
			throw new Error(`built DSH runtime file is missing: ${relativePath}`);
		}
	}
	for (const relativePath of ["README.md", "dsh-plugin.json", "cordis.patch.yml", "icon.svg", "locale/en.json", "locale/zh.json"]) {
		if (!fs.existsSync(path.join(root, relativePath))) {
			throw new Error(`DSH package resource is missing: ${relativePath}`);
		}
	}
}

function artifactName(packageJson) {
	const packageName = packageJson.name.replace(/^@/, "").replaceAll("/", "-");
	return `${packageName}-${packageJson.version}.tgz`;
}

function createStagingPackage(stageRoot, packageJson) {
	for (const relativePath of ["README.md", "dsh-plugin.json", "cordis.patch.yml", "icon.svg"]) {
		copyFile(relativePath, stageRoot);
	}
	fs.cpSync(path.join(root, "locale"), path.join(stageRoot, "locale"), { recursive: true });
	for (const relativePath of dshRuntimeFiles) copyFile(relativePath, stageRoot);

	const stagedPackageJson = { ...packageJson };
	// These fields describe the combined Pi package or the development tree;
	// keeping them out prevents a DSH install from pulling unrelated packages.
	for (const field of ["pi", "scripts", "devDependencies", "dependencies"]) {
		delete stagedPackageJson[field];
	}
	stagedPackageJson.keywords = ["dsh-plugin", "context-management", "clm"];
	// The host normally already supplies dsh-tools through the DSH bundles. Keep
	// it as an optional peer for compatibility checks without installing a second
	// module copy into the profile (the scheduler is keyed by a module-local Symbol).
	stagedPackageJson.peerDependencies = { ...dshRuntimePeerDependencies };
	stagedPackageJson.peerDependenciesMeta = Object.fromEntries(
		Object.keys(dshRuntimePeerDependencies).map((name) => [name, { optional: true }]),
	);
	stagedPackageJson.main = "./dist/dsh/index.js";
	stagedPackageJson.exports = {
		".": "./dist/dsh/index.js",
		"./locale/*.json": "./locale/*.json",
		"./icon": "./icon.svg",
	};
	stagedPackageJson.files = packageFiles;
	fs.writeFileSync(path.join(stageRoot, "package.json"), `${JSON.stringify(stagedPackageJson, null, 2)}\n`);
}

function main() {
	const outputArgument = parseOutputArgument(process.argv.slice(2));
	const requestedOutput = path.resolve(root, outputArgument);
	const outputIsFile = requestedOutput.toLowerCase().endsWith(".tgz");
	const outputDirectory = outputIsFile ? path.dirname(requestedOutput) : requestedOutput;
	const packageJson = readJson("package.json");
	const manifest = readJson("dsh-plugin.json");
	const outputFile = outputIsFile ? requestedOutput : path.join(outputDirectory, artifactName(packageJson));

	console.log("Building DSH host runtime...");
	run("npm", ["run", "build:dsh"], root);
	run(process.execPath, ["scripts/check-dsh-package.mjs"], root);
	assertBuildInputs(manifest, packageJson);

	const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-dsh-package-"));
	const packRoot = outputIsFile
		? fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-dsh-output-"))
		: outputDirectory;
	try {
		createStagingPackage(stageRoot, packageJson);
		fs.mkdirSync(outputDirectory, { recursive: true });
		fs.mkdirSync(packRoot, { recursive: true });
		if (fs.existsSync(outputFile)) fs.rmSync(outputFile, { force: true });

		console.log("Packing DSH plugin...");
		run("npm", ["pack", "--ignore-scripts", "--pack-destination", packRoot], stageRoot);
		const packedFile = path.join(packRoot, artifactName(packageJson));
		if (!fs.existsSync(packedFile)) throw new Error(`npm pack did not produce ${path.basename(packedFile)}`);
		if (path.resolve(packedFile) !== path.resolve(outputFile)) {
			fs.copyFileSync(packedFile, outputFile);
			fs.rmSync(packedFile, { force: true });
		}
	} finally {
		fs.rmSync(stageRoot, { recursive: true, force: true });
		if (outputIsFile) fs.rmSync(packRoot, { recursive: true, force: true });
	}

	console.log(`DSH plugin package written to ${path.relative(root, outputFile) || outputFile}`);
}

try {
	main();
} catch (error) {
	console.error(`DSH plugin build failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
