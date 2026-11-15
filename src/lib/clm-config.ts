import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Runtime configuration for both hosts.
 *
 * The plugin used to read ~25 `CLM_*` environment variables. They were invisible
 * after launch, could not be A/B tested without restarting the host, and mixed
 * host-level switches with per-endpoint calibration. The same knobs now live in
 * one JSON file, resolved per session:
 *
 *  1. the user file: `$XDG_CONFIG_HOME/oh-my-clm/config.json`, or
 *     `~/.config/oh-my-clm/config.json` when the variable is unset;
 *  2. the project file: `<cwd>/.oh-my-clm.json`, merged on top of the user file.
 *
 * A project file wins key-by-key. Invalid values never disable the plugin: the
 * parser falls back to the default and reports a warning, so a typo in a budget
 * does not make the mirror or cleanup disappear.
 */

export type ClmIndexMode = "blocks" | "digest";
export type ClmCleanupResultMode = "compact" | "full" | "none";

export interface ClmTriggerConfig {
	/** Usage percentage at which a cleanup candidate is offered; 0 disables. */
	usagePercent: number;
	/**
	 * Completed turns at which a candidate is offered; 0 disables.
	 *
	 * A turn is the coarsest clock the host has: replayed DSH sessions average
	 * 17.5 steps per turn (p50 11, p90 39, max 150), so a turn threshold is a
	 * range, not a point. Prefer {@link completedSteps}.
	 */
	completedTurns: number;
	/** Completed steps (requests) at which a candidate is offered; 0 disables. */
	completedSteps: number;
	/** toolResult share of editable tokens, as a percentage; 0 disables. */
	toolResultSharePercent: number;
	/** Turns since the last applied cleanup; 0 disables. */
	turnsSinceCleanup: number;
	/** Steps (requests) since the last applied cleanup; 0 disables. */
	stepsSinceCleanup: number;
	/** Maximum candidate ranges offered in one payload. */
	maxCandidates: number;
	/** Turns below this estimated size are not candidates. */
	minSavingsTokens: number;
}

export interface ClmCleanupConfig {
	/** How much of the cleanup result the model reads (DSH only). */
	resultMode: ClmCleanupResultMode;
	/** Cached-read price as a percentage of an uncached read (`2` = 1/50). */
	cacheDiscountPercent: number;
	/**
	 * Amortisation horizon of the one-time prefix-break cost, counted in future
	 * requests (steps). `0` keeps {@link paybackTurns} as that many requests —
	 * the conservative reading, because one turn is 11–39 requests and no
	 * session promises to run that long.
	 */
	paybackSteps: number;
	/** Turns the one-time prefix-break cost is amortised over. */
	paybackTurns: number;
	trigger: ClmTriggerConfig;
}

export interface ClmAutoClearConfig {
	/** Write durable clearing records and replace superseded tool results. */
	enabled: boolean;
	/** Append decisions to `CANARY.jsonl` without changing model input. */
	canary: boolean;
	minTokens: number;
	minBlocks: number;
	/** Occupancy percentage at which clearing hands off to host compaction. */
	stopPercent: number;
	/** Cumulative tokens one session may clear. */
	maxTokens: number;
	/**
	 * Free a candidate before the turn boundary when at most this many
	 * model-visible tokens sit after it; `0` disables mid-turn passes.
	 *
	 * A clear breaks the prefix cache at the cleared block, so the one-time cost
	 * is the tail behind it. The budget alone never triggers a pass: each
	 * candidate must also pay for that break within one more request
	 * (`earlyClearPays`). On the default `cacheDiscountPercent: 2` no replayed
	 * in-turn dead block qualifies, so leave this at `0` unless a measured
	 * endpoint with weak cache discount (r ≳ 0.1) asks for it.
	 */
	midTurnSuffixTokens: number;
}

export interface ClmIndexConfig {
	mode: ClmIndexMode;
	previewChars: number;
	headBlocks: number;
	tailBlocks: number;
	maxLines: number;
	/** Re-render at most once per this many completed steps in a turn. */
	refreshSteps: number;
}

export interface ClmContextConfig {
	/** Approximate target for the Pi budget nudge; 0 means no explicit budget. */
	budgetTokens: number;
	/** Window fallback when the host provides none; 0 means unknown. */
	windowTokens: number;
	/** Extra fixed request tokens counted by the shrink-only gate. */
	fixedTokens: number;
	maxBlockChars: number;
	maxMirrorChars: number;
}

export interface ClmConfig {
	version: 1;
	context: ClmContextConfig;
	index: ClmIndexConfig;
	cleanup: ClmCleanupConfig;
	autoClear: ClmAutoClearConfig;
	host: {
		/** Module that owns the host's ignorable plugin-record seam. */
		pluginRecordModule: string;
	};
}

export const DEFAULT_CLM_CONFIG: ClmConfig = {
	version: 1,
	context: {
		budgetTokens: 0,
		windowTokens: 0,
		fixedTokens: 0,
		maxBlockChars: 12_000,
		maxMirrorChars: 96_000,
	},
	index: {
		mode: "digest",
		previewChars: 64,
		headBlocks: 12,
		tailBlocks: 40,
		maxLines: 40,
		refreshSteps: 4,
	},
	cleanup: {
		resultMode: "compact",
		cacheDiscountPercent: 2,
		paybackSteps: 0,
		paybackTurns: 10,
		trigger: {
			usagePercent: 0,
			completedTurns: 0,
			completedSteps: 0,
			toolResultSharePercent: 0,
			turnsSinceCleanup: 0,
			stepsSinceCleanup: 0,
			maxCandidates: 3,
			minSavingsTokens: 0,
		},
	},
	autoClear: {
		enabled: false,
		canary: false,
		minTokens: 1_200,
		minBlocks: 2,
		stopPercent: 60,
		maxTokens: 40_000,
		midTurnSuffixTokens: 0,
	},
	host: {
		pluginRecordModule: "@deepseek-ai/dsh-session",
	},
};

export interface LoadedClmConfig {
	readonly config: ClmConfig;
	/** Files that contributed to this config, in merge order. */
	readonly sources: readonly string[];
	/** Recoverable file/type problems; the affected key kept its fallback. */
	readonly warnings: readonly string[];
}

/**
 * User-level config file.
 *
 * `XDG_CONFIG_HOME` is honoured when it is absolute, per the XDG base directory
 * spec; otherwise the file sits under `~/.config`. This is a *location* seam,
 * not a plugin switch: no config value is read from the environment, and the
 * suite points the variable at a temporary directory so a developer's own
 * config cannot change a test's outcome.
 */
export function userConfigPath(): string {
	const configured = process.env.XDG_CONFIG_HOME;
	const base = configured !== undefined && path.isAbsolute(configured)
		? configured
		: path.join(os.homedir(), ".config");
	return path.join(base, "oh-my-clm", "config.json");
}

/** Project-level config file, honoured for the session's working directory. */
export function projectConfigPath(cwd: string): string {
	return path.join(cwd, ".oh-my-clm.json");
}

function cloneDefaults(): ClmConfig {
	return {
		version: 1,
		context: { ...DEFAULT_CLM_CONFIG.context },
		index: { ...DEFAULT_CLM_CONFIG.index },
		cleanup: { ...DEFAULT_CLM_CONFIG.cleanup, trigger: { ...DEFAULT_CLM_CONFIG.cleanup.trigger } },
		autoClear: { ...DEFAULT_CLM_CONFIG.autoClear },
		host: { ...DEFAULT_CLM_CONFIG.host },
	};
}

function cloneConfig(config: ClmConfig): ClmConfig {
	return {
		version: 1,
		context: { ...config.context },
		index: { ...config.index },
		cleanup: { ...config.cleanup, trigger: { ...config.cleanup.trigger } },
		autoClear: { ...config.autoClear },
		host: { ...config.host },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function group(
	value: Record<string, unknown>,
	key: string,
	source: string,
	warnings: string[],
): Record<string, unknown> | undefined {
	const entry = value[key];
	if (entry === undefined) return undefined;
	if (!isRecord(entry)) {
		warnings.push(`${source}: "${key}" must be an object; using its defaults`);
		return undefined;
	}
	return entry;
}

function readNumber(
	value: Record<string, unknown>,
	key: string,
	fallback: number,
	source: string,
	label: string,
	warnings: string[],
	options: { min?: number; max?: number; integer?: boolean } = {},
): number {
	const raw = value[key];
	if (raw === undefined) return fallback;
	if (typeof raw !== "number" || !Number.isFinite(raw)) {
		warnings.push(`${source}: "${label}" must be a finite number; using ${fallback}`);
		return fallback;
	}
	if (options.integer && !Number.isInteger(raw)) {
		warnings.push(`${source}: "${label}" must be an integer; using ${fallback}`);
		return fallback;
	}
	if (options.min !== undefined && raw < options.min) {
		warnings.push(`${source}: "${label}" must be >= ${options.min}; using ${fallback}`);
		return fallback;
	}
	const clamped = options.max !== undefined ? Math.min(options.max, raw) : raw;
	return clamped;
}

function readBoolean(
	value: Record<string, unknown>,
	key: string,
	fallback: boolean,
	source: string,
	label: string,
	warnings: string[],
): boolean {
	const raw = value[key];
	if (raw === undefined) return fallback;
	if (typeof raw !== "boolean") {
		warnings.push(`${source}: "${label}" must be true or false; using ${fallback}`);
		return fallback;
	}
	return raw;
}

function readEnum<T extends string>(
	value: Record<string, unknown>,
	key: string,
	allowed: readonly T[],
	fallback: T,
	source: string,
	label: string,
	warnings: string[],
): T {
	const raw = value[key];
	if (raw === undefined) return fallback;
	if (typeof raw !== "string" || !allowed.includes(raw as T)) {
		warnings.push(`${source}: "${label}" must be one of ${allowed.join(", ")}; using ${fallback}`);
		return fallback;
	}
	return raw as T;
}

function readString(
	value: Record<string, unknown>,
	key: string,
	fallback: string,
	source: string,
	label: string,
	warnings: string[],
): string {
	const raw = value[key];
	if (raw === undefined) return fallback;
	if (typeof raw !== "string" || raw.trim().length === 0) {
		warnings.push(`${source}: "${label}" must be a non-empty string; using ${fallback}`);
		return fallback;
	}
	return raw;
}

/**
 * Apply one parsed JSON document on top of a base config.
 *
 * Exported so tests (and future host integrations) can validate a document
 * without touching disk. Unknown keys are ignored on purpose: forward
 * compatibility matters more than rejecting a newer config on an older plugin.
 */
export function parseClmConfig(
	document: unknown,
	base: ClmConfig = DEFAULT_CLM_CONFIG,
	source = "<memory>",
): { config: ClmConfig; warnings: string[] } {
	const warnings: string[] = [];
	const config = cloneConfig(base);
	if (!isRecord(document)) {
		warnings.push(`${source}: the config root must be an object; using defaults`);
		return { config, warnings };
	}
	const version = document.version;
	if (version !== undefined && version !== 1) {
		warnings.push(`${source}: unsupported "version" ${String(version)}; reading it as version 1`);
	}

	const context = group(document, "context", source, warnings);
	if (context) {
		config.context.budgetTokens = readNumber(context, "budgetTokens", config.context.budgetTokens, source, "context.budgetTokens", warnings, { min: 0 });
		config.context.windowTokens = readNumber(context, "windowTokens", config.context.windowTokens, source, "context.windowTokens", warnings, { min: 0 });
		config.context.fixedTokens = readNumber(context, "fixedTokens", config.context.fixedTokens, source, "context.fixedTokens", warnings, { min: 0 });
		config.context.maxBlockChars = readNumber(context, "maxBlockChars", config.context.maxBlockChars, source, "context.maxBlockChars", warnings, { min: 1 });
		config.context.maxMirrorChars = readNumber(context, "maxMirrorChars", config.context.maxMirrorChars, source, "context.maxMirrorChars", warnings, { min: 1 });
	}

	const index = group(document, "index", source, warnings);
	if (index) {
		config.index.mode = readEnum(index, "mode", ["blocks", "digest"] as const, config.index.mode, source, "index.mode", warnings);
		config.index.previewChars = readNumber(index, "previewChars", config.index.previewChars, source, "index.previewChars", warnings, { min: 1 });
		config.index.headBlocks = readNumber(index, "headBlocks", config.index.headBlocks, source, "index.headBlocks", warnings, { min: 1 });
		config.index.tailBlocks = readNumber(index, "tailBlocks", config.index.tailBlocks, source, "index.tailBlocks", warnings, { min: 1 });
		config.index.maxLines = readNumber(index, "maxLines", config.index.maxLines, source, "index.maxLines", warnings, { min: 1 });
		config.index.refreshSteps = readNumber(index, "refreshSteps", config.index.refreshSteps, source, "index.refreshSteps", warnings, { min: 1 });
	}

	const cleanup = group(document, "cleanup", source, warnings);
	if (cleanup) {
		config.cleanup.resultMode = readEnum(cleanup, "resultMode", ["compact", "full", "none"] as const, config.cleanup.resultMode, source, "cleanup.resultMode", warnings);
		config.cleanup.cacheDiscountPercent = readNumber(cleanup, "cacheDiscountPercent", config.cleanup.cacheDiscountPercent, source, "cleanup.cacheDiscountPercent", warnings, { min: 0, max: 100 });
		config.cleanup.paybackSteps = readNumber(cleanup, "paybackSteps", config.cleanup.paybackSteps, source, "cleanup.paybackSteps", warnings, { min: 0, integer: true });
		config.cleanup.paybackTurns = readNumber(cleanup, "paybackTurns", config.cleanup.paybackTurns, source, "cleanup.paybackTurns", warnings, { min: 1 });
		const trigger = group(cleanup, "trigger", source, warnings);
		if (trigger) {
			config.cleanup.trigger.usagePercent = readNumber(trigger, "usagePercent", config.cleanup.trigger.usagePercent, source, "cleanup.trigger.usagePercent", warnings, { min: 0, max: 100 });
			config.cleanup.trigger.completedTurns = readNumber(trigger, "completedTurns", config.cleanup.trigger.completedTurns, source, "cleanup.trigger.completedTurns", warnings, { min: 0 });
			config.cleanup.trigger.completedSteps = readNumber(trigger, "completedSteps", config.cleanup.trigger.completedSteps, source, "cleanup.trigger.completedSteps", warnings, { min: 0, integer: true });
			config.cleanup.trigger.toolResultSharePercent = readNumber(trigger, "toolResultSharePercent", config.cleanup.trigger.toolResultSharePercent, source, "cleanup.trigger.toolResultSharePercent", warnings, { min: 0, max: 100 });
			config.cleanup.trigger.turnsSinceCleanup = readNumber(trigger, "turnsSinceCleanup", config.cleanup.trigger.turnsSinceCleanup, source, "cleanup.trigger.turnsSinceCleanup", warnings, { min: 0 });
			config.cleanup.trigger.stepsSinceCleanup = readNumber(trigger, "stepsSinceCleanup", config.cleanup.trigger.stepsSinceCleanup, source, "cleanup.trigger.stepsSinceCleanup", warnings, { min: 0, integer: true });
			config.cleanup.trigger.maxCandidates = readNumber(trigger, "maxCandidates", config.cleanup.trigger.maxCandidates, source, "cleanup.trigger.maxCandidates", warnings, { min: 1, integer: true });
			config.cleanup.trigger.minSavingsTokens = readNumber(trigger, "minSavingsTokens", config.cleanup.trigger.minSavingsTokens, source, "cleanup.trigger.minSavingsTokens", warnings, { min: 0 });
		}
	}

	const autoClear = group(document, "autoClear", source, warnings);
	if (autoClear) {
		config.autoClear.enabled = readBoolean(autoClear, "enabled", config.autoClear.enabled, source, "autoClear.enabled", warnings);
		config.autoClear.canary = readBoolean(autoClear, "canary", config.autoClear.canary, source, "autoClear.canary", warnings);
		config.autoClear.minTokens = readNumber(autoClear, "minTokens", config.autoClear.minTokens, source, "autoClear.minTokens", warnings, { min: 0 });
		config.autoClear.minBlocks = readNumber(autoClear, "minBlocks", config.autoClear.minBlocks, source, "autoClear.minBlocks", warnings, { min: 1, integer: true });
		config.autoClear.stopPercent = readNumber(autoClear, "stopPercent", config.autoClear.stopPercent, source, "autoClear.stopPercent", warnings, { min: 0, max: 100 });
		config.autoClear.maxTokens = readNumber(autoClear, "maxTokens", config.autoClear.maxTokens, source, "autoClear.maxTokens", warnings, { min: 1 });
		config.autoClear.midTurnSuffixTokens = readNumber(autoClear, "midTurnSuffixTokens", config.autoClear.midTurnSuffixTokens, source, "autoClear.midTurnSuffixTokens", warnings, { min: 0, integer: true });
	}

	const host = group(document, "host", source, warnings);
	if (host) {
		config.host.pluginRecordModule = readString(host, "pluginRecordModule", config.host.pluginRecordModule, source, "host.pluginRecordModule", warnings);
	}

	return { config, warnings };
}

function readJsonFile(filePath: string, warnings: string[]): unknown | undefined {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		// ENOENT is the normal "no config" case, not a warning.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			warnings.push(`${filePath}: cannot be read (${error instanceof Error ? error.message : String(error)})`);
		}
		return undefined;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		warnings.push(`${filePath}: invalid JSON (${error instanceof Error ? error.message : String(error)}); ignoring this file`);
		return undefined;
	}
}

/**
 * Load the effective config for a session working directory.
 *
 * Reading on every call is deliberate: `/clm status` and an edited project file
 * should show the new value without restarting the host. The file is tiny, and a
 * cached object would reintroduce the stale-after-launch behaviour this module
 * exists to remove.
 *
 * The user file is read from the ambient home directory, so anything that loads
 * a config on a developer's machine must pin {@link userConfigPath} (the suite
 * and the host harness export `XDG_CONFIG_HOME`) or the result depends on what
 * that developer happens to have configured.
 */
export function loadClmConfig(cwd?: string): LoadedClmConfig {
	const warnings: string[] = [];
	const sources: string[] = [];
	let config = cloneDefaults();

	const userPath = userConfigPath();
	const userDocument = readJsonFile(userPath, warnings);
	if (userDocument !== undefined) {
		const parsed = parseClmConfig(userDocument, config, userPath);
		config = parsed.config;
		warnings.push(...parsed.warnings);
		sources.push(userPath);
	}

	if (cwd && cwd.trim().length > 0) {
		const filePath = projectConfigPath(cwd);
		const document = readJsonFile(filePath, warnings);
		if (document !== undefined) {
			const parsed = parseClmConfig(document, config, filePath);
			config = parsed.config;
			warnings.push(...parsed.warnings);
			sources.push(filePath);
		}
	}

	return { config, sources, warnings };
}
