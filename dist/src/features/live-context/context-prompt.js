export function dshPromptText(options) {
    const mirrorTemplate = options.mirrorTemplate;
    return `<oh-my-clm-dsh-live-context>
\`<oh-my-clm-block-index>\` lists 1-based IDs for history; ranges are inclusive. A cleared block reads \`[set aside to save space · <target> · re-read before editing]\`: the result was read, then set aside.
Prefer \`cleanup\`: whole-turn ranges (e.g. \`["3-16"]\`) remove in one call; \`cleanup({ list: "A-B" })\` only inspects.
To compress instead, edit the session mirror at \`${mirrorTemplate}\` (path above the index): shorten a body and keep the header, \`CLM_SNAPSHOT\`, IDs, roles, and markers. Rewriting a tool-call block also omits its tool result: put the fact there.
Block 1 and the initial task are protected. At a subtask boundary, use one \`cleanup\` to drop settled tool noise, then continue.
</oh-my-clm-dsh-live-context>`;
}
