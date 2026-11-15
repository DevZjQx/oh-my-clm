/**
 * The only safe way for this plugin to put a record in a session log.
 *
 * `Session.append()` has no way to mark an event `ignorable`, and the host's
 * persistence reader refuses a stored log that contains an event type it does
 * not know (`dsh-session-persistence`: `validateStoredEvents` throws
 * `SessionFormatUnsupportedError` unless `event.ignorable === true`). A plugin
 * type written with `append()` therefore produces a session that cannot be
 * reopened after a restart — the plugin would brick the user's transcript to
 * save tokens.
 *
 * `appendPluginRecord(session, type, data)` is the host's seam for exactly this
 * case: it commits `ignorable: true` with a `plugin:`-namespaced type, which a
 * reader that does not recognize it retains and skips. It lives in
 * `@deepseek-ai/dsh-session`, which the plugin does not import statically: a
 * profile install resolves the plugin's own dependencies, not the host's, so a
 * static import would fail to load the plugin in the very profile it ships to.
 *
 * Resolution is therefore dynamic and optional, and the caller must treat
 * "no writer" as "this host cannot record the decision" — never fall back to
 * `append()`. That fallback is what turned a token optimisation into an
 * unopenable session.
 *
 * A bare `import("@deepseek-ai/dsh-session")` is not enough on a real profile:
 * the plugin lives in `~/.dsh/profiles/<name>/node_modules/<plugin>`, while the
 * host package lives in the DSH installation
 * (`~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/...`). Node resolves
 * a bare specifier from the importing file, so the import fails and a profile
 * that has clearing enabled silently latches `unrecordable`. The host's own
 * entry point is the one anchor that is always on the same resolution path as
 * the running session: `process.argv[1]` is `.../@deepseek-ai/dsh/lib/bin.js`,
 * whose ancestor `node_modules` owns the exact `dsh-session` copy the session
 * was built from. Resolution tries, in order:
 *
 * 1. the specifier as given (a `file:` URL or absolute path also works);
 * 2. from the host entry points (`process.argv`);
 * 3. from global module roots, for launchers that drop the entry from `argv`.
 *
 * The last step is a fallback, not a guess: every candidate is a real Node
 * resolution, and the resolved module must expose a callable
 * `appendPluginRecord`. `host.pluginRecordModule` overrides the specifier so
 * the harness (and an unusual host layout) can point at its own seam.
 */

import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Host module (or config override) that owns the ignorable plugin-record seam. */
export const PLUGIN_RECORD_MODULE = "@deepseek-ai/dsh-session";

/**
 * Structural shape of the host's writer. Declared locally so the plugin keeps
 * its single dependency direction and stays testable without a host instance.
 */
export type PluginRecordWriter = (session: unknown, type: string, data: unknown) => unknown;

/**
 * A resolved seam plus an optional identity check.
 *
 * `appendPluginRecord` calls a private method on the `Session` class
 * (`commitPluginRecord = (session, type, data) => session.#appendRecord(...)`),
 * so a second copy of the package would throw on the private brand. When the
 * module exports `Session`, comparing prototypes proves the seam belongs to the
 * same copy that built this session; a mismatch is reported instead of being
 * buried in a rejected append.
 */
export interface PluginRecordSeam {
	readonly write: PluginRecordWriter;
	/** True when the module's `Session` class owns `session`; absent when the module does not export one. */
	readonly owns?: (session: unknown) => boolean;
}

export interface PluginRecordResolveOptions {
	/** Entry files to resolve from; defaults to the absolute entries in `process.argv`. */
	readonly hostEntries?: readonly string[];
	/** Extra module roots to probe, each resolved like a global install root. */
	readonly moduleRoots?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function dedupe(values: readonly string[]): string[] {
	return [...new Set(values.filter((value) => value.length > 0))];
}

/** Entries whose directory is on the same resolution path as the running host. */
function hostEntriesFromArgv(): string[] {
	return process.argv.slice(1).filter((arg) => isAbsolute(arg));
}

/** Global roots for launchers that start the host from a wrapper instead of its bin. */
function globalModuleRoots(): string[] {
	const roots: string[] = [];
	const add = (value: string | undefined): void => {
		if (value !== undefined && value.length > 0) roots.push(value);
	};
	try {
		// `<prefix>/bin/node` → `<prefix>/lib/node_modules`.
		const prefix = realpathSync(process.execPath);
		add(join(prefix, "..", "..", "lib", "node_modules"));
	} catch {
		// No executable path to derive from; the explicit roots below still apply.
	}
	add(process.env.HOME === undefined ? undefined : join(process.env.HOME, ".local", "lib", "node_modules"));
	add(process.env.HOME === undefined ? undefined : join(process.env.HOME, ".npm-global", "lib", "node_modules"));
	add("/usr/local/lib/node_modules");
	add("/usr/lib/node_modules");
	return dedupe(roots);
}

/** Import the specifier unless it is a bare specifier that must be resolved first. */
async function importModule(specifier: string): Promise<Record<string, unknown> | undefined> {
	let target = specifier;
	if (isAbsolute(specifier)) target = pathToFileURL(specifier).href;
	try {
		const loaded = (await import(target)) as Record<string, unknown>;
		return isRecord(loaded) ? loaded : undefined;
	} catch {
		// Unresolvable module, or a host that rejects the import: the caller
		// falls through to the next candidate.
		return undefined;
	}
}

function seamOf(loaded: Record<string, unknown> | undefined): PluginRecordSeam | undefined {
	if (loaded === undefined) return undefined;
	const write = loaded.appendPluginRecord;
	if (typeof write !== "function") return undefined;
	const Session = loaded.Session;
	if (typeof Session !== "function") return { write: write as PluginRecordWriter };
	const prototype = (Session as { prototype?: unknown }).prototype;
	return {
		write: write as PluginRecordWriter,
		owns: (session: unknown) => isRecord(session) && Object.getPrototypeOf(session) === prototype,
	};
}

/** Resolve `specifier` from one entry file and import the result. */
async function seamFromEntry(specifier: string, entry: string): Promise<PluginRecordSeam | undefined> {
	let resolved: string;
	try {
		resolved = createRequire(entry).resolve(specifier);
	} catch {
		return undefined;
	}
	try {
		return seamOf(await importModule(resolved));
	} catch {
		return undefined;
	}
}

function isBareSpecifier(specifier: string): boolean {
	return !specifier.startsWith(".") && !specifier.startsWith("file:") && !isAbsolute(specifier);
}

/**
 * Resolve the host's `appendPluginRecord`, or `undefined` when this host does
 * not expose one. Never throws: a host without the seam is a supported host, it
 * just cannot carry a durable clearing decision.
 *
 * @param specifier - module to resolve; defaults to {@link PLUGIN_RECORD_MODULE}.
 * @param options - extra resolution anchors, for tests and unusual host layouts.
 */
export async function resolvePluginRecordWriter(
	specifier: string = PLUGIN_RECORD_MODULE,
	options: PluginRecordResolveOptions = {},
): Promise<PluginRecordSeam | undefined> {
	const direct = seamOf(await importModule(specifier));
	if (direct !== undefined) return direct;
	if (!isBareSpecifier(specifier)) return undefined;

	// `file:`/absolute overrides were already imported directly; a bare specifier
	// needs a real resolution anchor, and the host's own entries are the ones that
	// point at the session's package copy.
	const entries = dedupe([
		...(options.hostEntries ?? hostEntriesFromArgv()),
		...globalModuleRoots().flatMap((root) => [
			join(root, "@deepseek-ai", "dsh", "lib", "bin.js"),
			join(root, "noop.js"),
		]),
		...(options.moduleRoots ?? []).flatMap((root) => [
			join(root, "@deepseek-ai", "dsh", "lib", "bin.js"),
			join(root, "noop.js"),
		]),
	]);
	for (const entry of entries) {
		const seam = await seamFromEntry(specifier, entry);
		if (seam !== undefined) return seam;
	}
	return undefined;
}
