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
 * `host.pluginRecordModule` overrides the specifier so the host harness can
 * exercise the seam without the host package installed.
 */
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
/** Host module (or config override) that owns the ignorable plugin-record seam. */
export const PLUGIN_RECORD_MODULE = "@deepseek-ai/dsh-session";
/**
 * Resolve the host's `appendPluginRecord`, or `undefined` when this host does
 * not expose one. Never throws: a host without the seam is a supported host, it
 * just cannot carry a durable clearing decision.
 *
 * @param specifier - module to resolve; defaults to {@link PLUGIN_RECORD_MODULE}.
 */
export async function resolvePluginRecordWriter(specifier = PLUGIN_RECORD_MODULE) {
    try {
        const loaded = (await import(__rewriteRelativeImportExtension(specifier)));
        const writer = loaded.appendPluginRecord;
        return typeof writer === "function" ? writer : undefined;
    }
    catch {
        // Unresolvable module, or a host that rejects the import: both mean "no
        // durable record seam here", which the caller reports once and respects.
        return undefined;
    }
}
