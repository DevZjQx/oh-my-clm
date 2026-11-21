/**
 * The one place a clearing decision becomes model-visible.
 *
 * DSH has no `cache_edits` and the loop freezes its request
 * (`dsh-agent-loop`: `deepFreeze(message)` plus a frozen `GenerateOptions`), so a
 * plugin cannot rewrite the delivery copy at `llm/stream`. The sanctioned seam is
 * the one `image/offload` uses: append a durable decision record and register a
 * *pure* message projection that derives the model-visible content from it.
 *
 * Properties this buys, none of which a surface replacement has:
 *   - the transcript keeps the original text; only the model sees the pointer;
 *   - message identity (`id`, `role`, `toolCallId`, `isError`) is preserved, so
 *     tool pairing and compaction anchors cannot be broken by a clear;
 *   - replay is deterministic, because the projection is validated against the
 *     log prefix instead of trusting the writer;
 *   - the record is written with `appendPluginRecord`, so it is `ignorable`:
 *     unloading the plugin silently restores the full text, and a reader that
 *     does not know the type skips it instead of refusing the session.
 */
/** Durable decision record type. Must satisfy the host's `plugin:` grammar. */
export const CLEAR_EVENT_TYPE = "plugin:oh-my-clm/clear";
export const CLEAR_VERSION = 1;
/**
 * Prefix of every derived placeholder. The projection treats a body that already
 * starts with it as cleared and leaves it alone: replaying a log that holds two
 * decisions for one node must converge, not throw. (The selector needs no such
 * check — it never reads model-visible text; it retires a block once a pass
 * commits it.)
 */
export const CLEAR_PLACEHOLDER_PREFIX = "[cleared";
/** Longest pointer text kept in a record; anything longer is a selector bug. */
export const CLEAR_LABEL_MAX_CHARS = 200;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isIndex(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
/** `12,345 tok` -> `12.3k tok`; the placeholder must stay one short line. */
export function compactTokens(tokens) {
    if (!Number.isFinite(tokens) || tokens < 0)
        return "? tok";
    if (tokens < 1_000)
        return `${Math.round(tokens)} tok`;
    if (tokens < 100_000)
        return `${(tokens / 1_000).toFixed(1)}k tok`;
    return `${Math.round(tokens / 1_000)}k tok`;
}
/**
 * The exact text the model sees in place of a cleared body.
 *
 * A clearing receipt, not an invitation: its read of the target is gone from the
 * model's copy, so it must re-read before editing — editing from a forgotten
 * read wastes a round trip or writes against stale content. What the clear left
 * behind (the session log, and the transcript the user reads) is one fact for
 * every cleared block, so the per-turn index header carries it once instead of
 * repeating it under each block the model has to skim.
 */
export function clearPlaceholder(label, tokens) {
    return `${CLEAR_PLACEHOLDER_PREFIX} ${compactTokens(tokens)} · ${label} · re-read before editing]`;
}
function messageText(content) {
    if (!Array.isArray(content))
        return "";
    return content.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : "")).join("");
}
/**
 * Validate one decision and derive the messages it changes.
 *
 * Only a record whose envelope is unusable throws (not an object, unknown
 * version, empty target list): that is a writer bug and the log cannot be
 * interpreted. A *target* the projection cannot apply is skipped instead,
 * because the two reasons for that are both normal on replay:
 *
 *   - host compaction removed the node, so nothing at that position is visible;
 *   - an earlier decision already cleared it, and replay must converge.
 *
 * Refusing to load a session over an inapplicable pointer would trade a cosmetic
 * placeholder for the whole session. What still throws is a target that *is*
 * applicable and malformed (label/tokens/duplicate) — silently dropping that
 * would leave a log claiming a clear the model never saw.
 */
export const clearProjection = {
    type: CLEAR_EVENT_TYPE,
    project(event, context) {
        const data = event.data;
        if (!isRecord(data))
            throw new Error(`${CLEAR_EVENT_TYPE}: data must be an object`);
        if (data.v !== CLEAR_VERSION)
            throw new Error(`${CLEAR_EVENT_TYPE}: unsupported version ${String(data.v)}`);
        const targets = data.targets;
        if (!Array.isArray(targets) || targets.length === 0) {
            throw new Error(`${CLEAR_EVENT_TYPE}: targets must be a nonempty array`);
        }
        const nodes = new Set(context.nodes);
        const updates = new Map();
        // Envelope validity is decided before the projection decision: a target that
        // is skipped because its pointer would not shrink it is still a duplicate of
        // one the record already named.
        const seen = new Set();
        for (const target of targets) {
            if (!isRecord(target))
                throw new Error(`${CLEAR_EVENT_TYPE}: each target must be an object`);
            const seq = target.seq;
            const label = target.label;
            const tokens = target.tokens;
            if (!isIndex(seq))
                throw new Error(`${CLEAR_EVENT_TYPE}: target seq must be a non-negative integer`);
            // Stale position: compaction removed it from the surface, so the model
            // cannot read it and there is nothing to replace. Checked before the rest
            // of the target, because that is exactly the case that must not throw.
            if (!nodes.has(seq))
                continue;
            if (seen.has(seq))
                throw new Error(`${CLEAR_EVENT_TYPE}: duplicate target seq ${seq}`);
            seen.add(seq);
            if (typeof label !== "string" || label.length === 0 || label.length > CLEAR_LABEL_MAX_CHARS) {
                throw new Error(`${CLEAR_EVENT_TYPE}: target label must be 1..${CLEAR_LABEL_MAX_CHARS} characters`);
            }
            if (!isIndex(tokens))
                throw new Error(`${CLEAR_EVENT_TYPE}: target tokens must be a non-negative integer`);
            const source = context.events[seq - context.baseSeq];
            if (!isRecord(source) || source.type !== "tool/result") {
                throw new Error(`${CLEAR_EVENT_TYPE}: target seq ${seq} must be a tool/result`);
            }
            const sourceData = source.data;
            const original = (isRecord(sourceData) ? sourceData.message : undefined);
            if (!isRecord(original))
                throw new Error(`${CLEAR_EVENT_TYPE}: target seq ${seq} carries no message`);
            // The current projection is what the model actually reads: an earlier
            // clear of the same node means this decision is already in effect.
            const current = (context.messages.get(seq) ?? original);
            const currentText = messageText(current.content);
            if (currentText.length === 0)
                throw new Error(`${CLEAR_EVENT_TYPE}: target seq ${seq} has an empty body`);
            if (currentText.startsWith(CLEAR_PLACEHOLDER_PREFIX))
                continue;
            // A clear must strictly shrink what the model reads. A body no longer than
            // the pointer that would replace it is not dead weight: rewriting it would
            // grow every later request. Checked here because a replayed record carries
            // the decision, not the body it was written against.
            const placeholder = clearPlaceholder(label, tokens);
            if (placeholder.length >= currentText.length)
                continue;
            updates.set(seq, {
                ...current,
                content: [{ type: "text", text: placeholder }],
            });
        }
        return updates;
    },
};
