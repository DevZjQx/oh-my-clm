import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	DEFAULT_CLM_CONFIG,
	loadClmConfig,
	parseClmConfig,
	projectConfigPath,
	userConfigPath,
} from "../../src/lib/clm-config.ts";

// The loader reads the user-level file from the ambient home directory, so pin
// it to a temporary root before any test runs: a developer's own config must not
// decide whether the suite passes.
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clm-config-user-"));

test("the user config file follows the XDG base directory, absolute only", () => {
	const previous = process.env.XDG_CONFIG_HOME;
	try {
		process.env.XDG_CONFIG_HOME = "/tmp/xdg-root";
		assert.equal(userConfigPath(), "/tmp/xdg-root/oh-my-clm/config.json");
		// A relative value is ignored, per the spec: the fallback is the home root.
		process.env.XDG_CONFIG_HOME = "relative/dir";
		assert.equal(userConfigPath(), path.join(os.homedir(), ".config", "oh-my-clm", "config.json"));
		delete process.env.XDG_CONFIG_HOME;
		assert.equal(userConfigPath(), path.join(os.homedir(), ".config", "oh-my-clm", "config.json"));
	} finally {
		if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = previous;
	}
});

test("a user config file is merged under the project file", () => {
	const previous = process.env.XDG_CONFIG_HOME;
	const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clm-config-user-merge-"));
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clm-config-project-merge-"));
	try {
		process.env.XDG_CONFIG_HOME = userRoot;
		fs.mkdirSync(path.join(userRoot, "oh-my-clm"), { recursive: true });
		fs.writeFileSync(
			userConfigPath(),
			JSON.stringify({ context: { budgetTokens: 111 }, index: { mode: "blocks" } }),
			"utf8",
		);
		fs.writeFileSync(projectConfigPath(cwd), JSON.stringify({ context: { budgetTokens: 222 } }), "utf8");
		const loaded = loadClmConfig(cwd);
		assert.deepEqual(loaded.sources, [userConfigPath(), projectConfigPath(cwd)]);
		// The project file wins on the key it names, and only that key.
		assert.equal(loaded.config.context.budgetTokens, 222);
		assert.equal(loaded.config.index.mode, "blocks");
	} finally {
		if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = previous;
		fs.rmSync(userRoot, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("config defaults leave cleanup disabled and digest as the index shape", () => {
	const config = loadClmConfig(fs.mkdtempSync(path.join(os.tmpdir(), "clm-config-default-"))).config;
	assert.deepEqual(config, DEFAULT_CLM_CONFIG);
	assert.equal(config.autoClear.enabled, false);
	assert.equal(config.autoClear.canary, false);
	assert.equal(config.index.mode, "digest");
	assert.equal(config.cleanup.cacheDiscountPercent, 2);
});

test("a project config file overrides only the keys it names", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clm-config-project-"));
	try {
		fs.writeFileSync(projectConfigPath(cwd), JSON.stringify({
			context: { budgetTokens: 32_000 },
			cleanup: { trigger: { usagePercent: 70 } },
			autoClear: { enabled: true },
		}), "utf8");
		const loaded = loadClmConfig(cwd);
		assert.deepEqual(loaded.warnings, []);
		assert.deepEqual(loaded.sources, [projectConfigPath(cwd)]);
		assert.equal(loaded.config.context.budgetTokens, 32_000);
		assert.equal(loaded.config.context.maxBlockChars, DEFAULT_CLM_CONFIG.context.maxBlockChars);
		assert.equal(loaded.config.cleanup.trigger.usagePercent, 70);
		assert.equal(loaded.config.cleanup.trigger.maxCandidates, DEFAULT_CLM_CONFIG.cleanup.trigger.maxCandidates);
		assert.equal(loaded.config.autoClear.enabled, true);
		assert.equal(loaded.config.autoClear.minTokens, DEFAULT_CLM_CONFIG.autoClear.minTokens);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("invalid values fall back per key and report where the typo is", () => {
	const parsed = parseClmConfig({
		context: { budgetTokens: "many", maxBlockChars: 0 },
		index: { mode: "compact" },
		cleanup: { resultMode: "verbose", trigger: { usagePercent: 120 } },
		autoClear: { enabled: "yes", minBlocks: 1.5 },
		host: { pluginRecordModule: "" },
	}, DEFAULT_CLM_CONFIG, "test.json");
	assert.equal(parsed.config.context.budgetTokens, DEFAULT_CLM_CONFIG.context.budgetTokens);
	assert.equal(parsed.config.context.maxBlockChars, DEFAULT_CLM_CONFIG.context.maxBlockChars);
	assert.equal(parsed.config.index.mode, "digest");
	assert.equal(parsed.config.cleanup.resultMode, "compact");
	assert.equal(parsed.config.cleanup.trigger.usagePercent, 100, "percentages clamp rather than reject");
	assert.equal(parsed.config.autoClear.enabled, false);
	assert.equal(parsed.config.autoClear.minBlocks, DEFAULT_CLM_CONFIG.autoClear.minBlocks);
	assert.equal(parsed.config.host.pluginRecordModule, DEFAULT_CLM_CONFIG.host.pluginRecordModule);
	assert.ok(parsed.warnings.some((warning) => warning.includes("context.budgetTokens")));
	assert.ok(parsed.warnings.some((warning) => warning.includes("index.mode")));
	assert.ok(parsed.warnings.some((warning) => warning.includes("cleanup.resultMode")));
	assert.ok(parsed.warnings.some((warning) => warning.includes("autoClear.enabled")));
	assert.ok(parsed.warnings.some((warning) => warning.includes("host.pluginRecordModule")));
});

test("a malformed file is ignored with a warning instead of disabling the plugin", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clm-config-broken-"));
	try {
		fs.writeFileSync(projectConfigPath(cwd), "{ not json", "utf8");
		const loaded = loadClmConfig(cwd);
		assert.deepEqual(loaded.config, DEFAULT_CLM_CONFIG);
		assert.equal(loaded.sources.length, 0);
		assert.ok(loaded.warnings.some((warning) => warning.includes("invalid JSON")));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("unknown keys are ignored for forward compatibility", () => {
	const parsed = parseClmConfig({
		version: 1,
		future: { anything: true },
		context: { budgetTokens: 1_000, futureNested: 1 },
	}, DEFAULT_CLM_CONFIG, "future.json");
	assert.equal(parsed.config.context.budgetTokens, 1_000);
	assert.deepEqual(parsed.warnings, []);
});
