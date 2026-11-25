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
 * Prefix of every pointer this build writes. The projection treats a body that
 * already starts with it (or with {@link CLEAR_PLACEHOLDER_V1_PREFIX}) as cleared
 * and leaves it alone: replaying a log that holds two decisions for one node must
 * converge, not throw. (The selector needs no such check — it never reads
 * model-visible text; it retires a block once a pass commits it.)
 */
export const CLEAR_PLACEHOLDER_PREFIX = "[set aside to save space";
/** Prefix the v1 pointer used; still recognised on replay. */
export const CLEAR_PLACEHOLDER_V1_PREFIX = "[cleared";
/** Longest pointer text kept in a record; anything longer is a selector bug. */
export const CLEAR_LABEL_MAX_CHARS = 200;
/**
 * Longest literal placeholder a record may carry. The pointer is one line built
 * from a bounded label, so anything past this is a writer bug, not a big block.
 */
export const CLEAR_PLACEHOLDER_MAX_CHARS = 512;
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
 * A clearing receipt, not an invitation, and it has two readers to keep apart.
 * The pointer must send the model back to the target before it edits: its read is
 * gone from the model's copy, so editing from a forgotten read wastes a round
 * trip or writes against stale content. It must also not read as "this call
 * returned nothing": a model that takes it that way disowns the answers it built
 * on that result, which is worse than the tokens the clear saved. So the line
 * states that the result was there, that the model read it, and that it was set
 * aside to save space, and it names only the tool and the size.
 *
 * What the clear left behind (the session log, and the transcript the user
 * reads) is one fact for every cleared block, so the per-turn index header
 * carries it once instead of repeating it under each block the model has to skim.
 */
export function clearPlaceholder(label, tokens) {
    return `${CLEAR_PLACEHOLDER_PREFIX} · ${label} · you read its ${compactTokens(tokens)} in full at the time and wrote your later replies from it · re-read before editing]`;
}
/**
 * The pointer v1 wrote when a record carries no literal text.
 *
 * Frozen on purpose. Records written before the wording change have no `text`
 * field, and their model-visible bytes must not move with a new build: a replay
 * that re-rendered them through today's {@link clearPlaceholder} would send the
 * model a prompt no earlier request ever contained. This function is not a
 * fallback for new records — it is the v1 format, and it must not change.
 */
export function clearPlaceholderV1(label, tokens) {
    return `[cleared ${compactTokens(tokens)} · ${label} · re-read before editing]`;
}
function messageText(content) {
    if (!Array.isArray(content))
        return "";
    return content.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : "")).join("");
}
/**
 * The literal pointer a record carries, when it carries one.
 *
 * Only the envelope decides whether a malformed field throws: a record that says
 * it stored the model-visible text but cannot reproduce it is a writer bug, and
 * silently re-rendering the block under a new build is exactly the drift the
 * field exists to rule out.
 */
function literalPlaceholderOf(target) {
    const text = target.text;
    if (text === undefined)
        return undefined;
    if (typeof text !== "string" || text.length === 0 || text.includes("\n")) {
        throw new Error(`${CLEAR_EVENT_TYPE}: target text must be one non-empty line`);
    }
    return text;
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
            const literal = literalPlaceholderOf(target);
            if (literal !== undefined && literal.length > CLEAR_PLACEHOLDER_MAX_CHARS) {
                throw new Error(`${CLEAR_EVENT_TYPE}: target text must be at most ${CLEAR_PLACEHOLDER_MAX_CHARS} characters`);
            }
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
            if (currentText.startsWith(CLEAR_PLACEHOLDER_PREFIX) || currentText.startsWith(CLEAR_PLACEHOLDER_V1_PREFIX))
                continue;
            // A clear must strictly shrink what the model reads. A body no longer than
            // the pointer that would replace it is not dead weight: rewriting it would
            // grow every later request. Checked here because a replayed record carries
            // the decision, not the body it was written against.
            const placeholder = literal ?? clearPlaceholderV1(label, tokens);
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
