import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
export const DEFAULT_CLM_CONFIG = {
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
        staleTurns: 3,
        minTokens: 1_200,
        minBlocks: 2,
        minSharePercent: 5,
        stopPercent: 60,
        midTurnSuffixTokens: 0,
    },
    host: {
        pluginRecordModule: "@deepseek-ai/dsh-session",
    },
};
/**
 * User-level config file.
 *
 * `XDG_CONFIG_HOME` is honoured when it is absolute, per the XDG base directory
 * spec; otherwise the file sits under `~/.config`. This is a *location* seam,
 * not a plugin switch: no config value is read from the environment, and the
 * suite points the variable at a temporary directory so a developer's own
 * config cannot change a test's outcome.
 */
export function userConfigPath() {
    const configured = process.env.XDG_CONFIG_HOME;
    const base = configured !== undefined && path.isAbsolute(configured)
        ? configured
        : path.join(os.homedir(), ".config");
    return path.join(base, "oh-my-clm", "config.json");
}
/** Project-level config file, honoured for the session's working directory. */
export function projectConfigPath(cwd) {
    return path.join(cwd, ".oh-my-clm.json");
}
function cloneDefaults() {
    return {
        version: 1,
        context: { ...DEFAULT_CLM_CONFIG.context },
        index: { ...DEFAULT_CLM_CONFIG.index },
        cleanup: { ...DEFAULT_CLM_CONFIG.cleanup, trigger: { ...DEFAULT_CLM_CONFIG.cleanup.trigger } },
        autoClear: { ...DEFAULT_CLM_CONFIG.autoClear },
        host: { ...DEFAULT_CLM_CONFIG.host },
    };
}
function cloneConfig(config) {
    return {
        version: 1,
        context: { ...config.context },
        index: { ...config.index },
        cleanup: { ...config.cleanup, trigger: { ...config.cleanup.trigger } },
        autoClear: { ...config.autoClear },
        host: { ...config.host },
    };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function group(value, key, source, warnings) {
    const entry = value[key];
    if (entry === undefined)
        return undefined;
    if (!isRecord(entry)) {
        warnings.push(`${source}: "${key}" must be an object; using its defaults`);
        return undefined;
    }
    return entry;
}
function readNumber(value, key, fallback, source, label, warnings, options = {}) {
    const raw = value[key];
    if (raw === undefined)
        return fallback;
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
function readBoolean(value, key, fallback, source, label, warnings) {
    const raw = value[key];
    if (raw === undefined)
        return fallback;
    if (typeof raw !== "boolean") {
        warnings.push(`${source}: "${label}" must be true or false; using ${fallback}`);
        return fallback;
    }
    return raw;
}
function readEnum(value, key, allowed, fallback, source, label, warnings) {
    const raw = value[key];
    if (raw === undefined)
        return fallback;
    if (typeof raw !== "string" || !allowed.includes(raw)) {
        warnings.push(`${source}: "${label}" must be one of ${allowed.join(", ")}; using ${fallback}`);
        return fallback;
    }
    return raw;
}
function readString(value, key, fallback, source, label, warnings) {
    const raw = value[key];
    if (raw === undefined)
        return fallback;
    if (typeof raw !== "string" || raw.trim().length === 0) {
        warnings.push(`${source}: "${label}" must be a non-empty string; using ${fallback}`);
        return fallback;
    }
    return raw;
}
/**
 * Report a key this version stopped reading.
 *
 * Unknown keys stay silent so a newer config still loads, but a key that used
 * to change behaviour must not disappear quietly: a session that set the old
 * value would run under different rules and never hear about it.
 */
function removedKey(value, key, note, source, label, warnings) {
    if (value[key] === undefined)
        return;
    warnings.push(`${source}: "${label}" is no longer used and is ignored; ${note}`);
}
/**
 * Apply one parsed JSON document on top of a base config.
 *
 * Exported so tests (and future host integrations) can validate a document
 * without touching disk. Unknown keys are ignored on purpose: forward
 * compatibility matters more than rejecting a newer config on an older plugin.
 */
export function parseClmConfig(document, base = DEFAULT_CLM_CONFIG, source = "<memory>") {
    const warnings = [];
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
        config.index.mode = readEnum(index, "mode", ["blocks", "digest"], config.index.mode, source, "index.mode", warnings);
        config.index.previewChars = readNumber(index, "previewChars", config.index.previewChars, source, "index.previewChars", warnings, { min: 1 });
        config.index.headBlocks = readNumber(index, "headBlocks", config.index.headBlocks, source, "index.headBlocks", warnings, { min: 1 });
        config.index.tailBlocks = readNumber(index, "tailBlocks", config.index.tailBlocks, source, "index.tailBlocks", warnings, { min: 1 });
        config.index.maxLines = readNumber(index, "maxLines", config.index.maxLines, source, "index.maxLines", warnings, { min: 1 });
        config.index.refreshSteps = readNumber(index, "refreshSteps", config.index.refreshSteps, source, "index.refreshSteps", warnings, { min: 1 });
    }
    const cleanup = group(document, "cleanup", source, warnings);
    if (cleanup) {
        config.cleanup.resultMode = readEnum(cleanup, "resultMode", ["compact", "full", "none"], config.cleanup.resultMode, source, "cleanup.resultMode", warnings);
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
        removedKey(autoClear, "maxTokens", "clearing has no cumulative token cap", source, "autoClear.maxTokens", warnings);
        config.autoClear.enabled = readBoolean(autoClear, "enabled", config.autoClear.enabled, source, "autoClear.enabled", warnings);
        config.autoClear.canary = readBoolean(autoClear, "canary", config.autoClear.canary, source, "autoClear.canary", warnings);
        config.autoClear.staleTurns = readNumber(autoClear, "staleTurns", config.autoClear.staleTurns, source, "autoClear.staleTurns", warnings, { min: 0, integer: true });
        config.autoClear.minTokens = readNumber(autoClear, "minTokens", config.autoClear.minTokens, source, "autoClear.minTokens", warnings, { min: 0 });
        config.autoClear.minBlocks = readNumber(autoClear, "minBlocks", config.autoClear.minBlocks, source, "autoClear.minBlocks", warnings, { min: 1, integer: true });
        config.autoClear.minSharePercent = readNumber(autoClear, "minSharePercent", config.autoClear.minSharePercent, source, "autoClear.minSharePercent", warnings, { min: 0, max: 100 });
        config.autoClear.stopPercent = readNumber(autoClear, "stopPercent", config.autoClear.stopPercent, source, "autoClear.stopPercent", warnings, { min: 0, max: 100 });
        config.autoClear.midTurnSuffixTokens = readNumber(autoClear, "midTurnSuffixTokens", config.autoClear.midTurnSuffixTokens, source, "autoClear.midTurnSuffixTokens", warnings, { min: 0, integer: true });
    }
    const host = group(document, "host", source, warnings);
    if (host) {
        config.host.pluginRecordModule = readString(host, "pluginRecordModule", config.host.pluginRecordModule, source, "host.pluginRecordModule", warnings);
    }
    return { config, warnings };
}
function readJsonFile(filePath, warnings) {
    let text;
    try {
        text = fs.readFileSync(filePath, "utf8");
    }
    catch (error) {
        // ENOENT is the normal "no config" case, not a warning.
        if (error.code !== "ENOENT") {
            warnings.push(`${filePath}: cannot be read (${error instanceof Error ? error.message : String(error)})`);
        }
        return undefined;
    }
    try {
        return JSON.parse(text);
    }
    catch (error) {
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
export function loadClmConfig(cwd) {
    const warnings = [];
    const sources = [];
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
