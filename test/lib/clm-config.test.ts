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

test("a key this version no longer reads is reported instead of vanishing", () => {
	// Unknown keys stay silent, but `autoClear.maxTokens` used to cap a session.
	// A config that still names it must hear that clearing no longer has a cap.
	const parsed = parseClmConfig({ autoClear: { maxTokens: 40_000 } }, DEFAULT_CLM_CONFIG, "removed.json");
	assert.equal("maxTokens" in parsed.config.autoClear, false);
	assert.equal(parsed.warnings.length, 1);
	assert.ok(parsed.warnings[0]?.includes("autoClear.maxTokens"));
});

test("the stale rule has its own turn budget", () => {
	assert.equal(DEFAULT_CLM_CONFIG.autoClear.staleTurns, 3);
	const parsed = parseClmConfig({ autoClear: { staleTurns: 6 } }, DEFAULT_CLM_CONFIG, "stale.json");
	assert.deepEqual(parsed.warnings, []);
	assert.equal(parsed.config.autoClear.staleTurns, 6);
	const bad = parseClmConfig({ autoClear: { staleTurns: 1.5 } }, DEFAULT_CLM_CONFIG, "bad-stale.json");
	assert.equal(bad.config.autoClear.staleTurns, 3);
	assert.ok(bad.warnings.some((warning) => warning.includes("autoClear.staleTurns")));
});

test("step clocks and the request horizon are their own keys, defaulting off", () => {
	assert.equal(DEFAULT_CLM_CONFIG.cleanup.trigger.completedSteps, 0);
	assert.equal(DEFAULT_CLM_CONFIG.cleanup.trigger.stepsSinceCleanup, 0);
	assert.equal(DEFAULT_CLM_CONFIG.cleanup.paybackSteps, 0);
	assert.equal(DEFAULT_CLM_CONFIG.autoClear.midTurnSuffixTokens, 0);

	const parsed = parseClmConfig({
		cleanup: {
			paybackSteps: 40,
			trigger: { completedSteps: 60, stepsSinceCleanup: 25, completedTurns: 2, turnsSinceCleanup: 1 },
		},
		autoClear: { midTurnSuffixTokens: 512 },
	}, DEFAULT_CLM_CONFIG, "steps.json");
	assert.deepEqual(parsed.warnings, []);
	assert.equal(parsed.config.cleanup.paybackSteps, 40);
	assert.equal(parsed.config.cleanup.trigger.completedSteps, 60);
	assert.equal(parsed.config.cleanup.trigger.stepsSinceCleanup, 25);
	// The turn clocks keep working: a config shared with a turn-aware host is not
	// silently rewritten into the step unit.
	assert.equal(parsed.config.cleanup.trigger.completedTurns, 2);
	assert.equal(parsed.config.cleanup.trigger.turnsSinceCleanup, 1);
	assert.equal(parsed.config.autoClear.midTurnSuffixTokens, 512);

	const bad = parseClmConfig({
		cleanup: { paybackSteps: 1.5, trigger: { completedSteps: -1 } },
		autoClear: { midTurnSuffixTokens: "some" },
	}, DEFAULT_CLM_CONFIG, "bad-steps.json");
	const steps = bad.config as typeof bad.config;
	assert.equal(steps.cleanup.paybackSteps, 0, "a fractional request horizon is a typo, not a value");
	assert.equal(steps.cleanup.trigger.completedSteps, 0);
	assert.equal(steps.autoClear.midTurnSuffixTokens, 0);
	assert.ok(bad.warnings.some((warning) => warning.includes("cleanup.paybackSteps")));
	assert.ok(bad.warnings.some((warning) => warning.includes("cleanup.trigger.completedSteps")));
	assert.ok(bad.warnings.some((warning) => warning.includes("autoClear.midTurnSuffixTokens")));
});

/**
 * The step clock is a second aging trigger, not a replacement, so its own
 * default ships off. A clock set past the window's ceiling has no age to fire
 * at, and says so instead of going quiet.
 */
test("the stale rule has a step budget that ships off", () => {
	assert.equal(DEFAULT_CLM_CONFIG.autoClear.staleSteps, 0);
	const parsed = parseClmConfig({ autoClear: { staleSteps: 12 } }, DEFAULT_CLM_CONFIG, "steps.json");
	assert.equal(parsed.config.autoClear.staleSteps, 12);
	assert.ok(
		parsed.warnings.some((warning) => warning.includes("autoClear.maxAgeSteps")),
		"a clock set past the default ceiling is reported, not silently capped",
	);
	const unbounded = parseClmConfig({ autoClear: { staleSteps: 12, maxAgeSteps: 0 } }, DEFAULT_CLM_CONFIG, "unbounded-steps.json");
	assert.deepEqual(unbounded.warnings, [], "0 leaves the age rule unbounded, so the clock still fires at 12");
	const inside = parseClmConfig({ autoClear: { staleSteps: 3 } }, DEFAULT_CLM_CONFIG, "inside-steps.json");
	assert.deepEqual(inside.warnings, [], "a clock inside the window is the intended shape");
	const bad = parseClmConfig({ autoClear: { staleSteps: -1 } }, DEFAULT_CLM_CONFIG, "bad-steps.json");
	assert.equal(bad.config.autoClear.staleSteps, 0);
	assert.ok(bad.warnings.some((warning) => warning.includes("autoClear.staleSteps")));
});

/**
 * The age window is the rot channel's answer to a batch that costs more than it
 * frees: the floor keeps the hot set out, the ceiling keeps the backlog's
 * session-long suffix out.
 */
test("the rot rule clears inside an age window", () => {
	assert.equal(DEFAULT_CLM_CONFIG.autoClear.minAgeSteps, 2);
	assert.equal(DEFAULT_CLM_CONFIG.autoClear.maxAgeSteps, 4);
	const parsed = parseClmConfig({ autoClear: { minAgeSteps: 3, maxAgeSteps: 8 } }, DEFAULT_CLM_CONFIG, "window.json");
	assert.deepEqual(parsed.warnings, []);
	assert.equal(parsed.config.autoClear.minAgeSteps, 3);
	assert.equal(parsed.config.autoClear.maxAgeSteps, 8);
	const bad = parseClmConfig({ autoClear: { minAgeSteps: 1.5, maxAgeSteps: -2 } }, DEFAULT_CLM_CONFIG, "bad-window.json");
	assert.equal(bad.config.autoClear.minAgeSteps, 2);
	assert.equal(bad.config.autoClear.maxAgeSteps, 4);
	assert.ok(bad.warnings.some((warning) => warning.includes("autoClear.minAgeSteps")));
	assert.ok(bad.warnings.some((warning) => warning.includes("autoClear.maxAgeSteps")));
});

/**
 * The money channel is opt-in: the rot channel's decisions must not change
 * until a config names it, and a typo in the channel falls back to `rot`
 * instead of silently pricing every batch.
 */
test("the clearing channel defaults to rot and takes its money keys", () => {
	assert.equal(DEFAULT_CLM_CONFIG.autoClear.channel, "rot");
	assert.equal(DEFAULT_CLM_CONFIG.autoClear.maxSuffixTokens, 0);
	assert.equal(DEFAULT_CLM_CONFIG.autoClear.minNetTokens, 0);
	const parsed = parseClmConfig({
		autoClear: { channel: "money", maxSuffixTokens: 2_000, minNetTokens: 50 },
	}, DEFAULT_CLM_CONFIG, "money.json");
	assert.deepEqual(parsed.warnings, []);
	assert.equal(parsed.config.autoClear.channel, "money");
	assert.equal(parsed.config.autoClear.maxSuffixTokens, 2_000);
	assert.equal(parsed.config.autoClear.minNetTokens, 50);
	const bad = parseClmConfig({ autoClear: { channel: "profit" } }, DEFAULT_CLM_CONFIG, "bad-channel.json");
	assert.equal(bad.config.autoClear.channel, "rot");
	assert.ok(bad.warnings.some((warning) => warning.includes("autoClear.channel")));
});

