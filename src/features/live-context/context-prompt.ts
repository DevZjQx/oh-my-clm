/**
 * The static DSH prompt section.
 *
 * The section is registered once per process, so it cannot branch on a
 * per-session config value. It therefore states the clearing contract
 * conditionally: the pointer can appear when `autoClear.enabled` is set, and a
 * resumed session may carry one even when the switch is now off.
 */
export interface DshPromptOptions {
	readonly mirrorTemplate: string;
}

export function dshPromptText(options: DshPromptOptions): string {
	const mirrorTemplate = options.mirrorTemplate;
	return `<oh-my-clm-dsh-live-context>
\`<oh-my-clm-block-index>\` lists 1-based IDs for history; ranges are inclusive. A cleared block reads \`[cleared <size> · <target> · re-read before editing]\`.
Prefer \`cleanup\`: whole-turn ranges (e.g. \`["3-16"]\`) remove in one call; \`cleanup({ list: "A-B" })\` only inspects.
To compress instead, edit the session mirror at \`${mirrorTemplate}\` (path above the index): shorten a body and keep the header, \`CLM_SNAPSHOT\`, IDs, roles, and markers. Rewriting a tool-call block also omits its tool result: put the fact there.
Block 1 and the initial task are protected. At a subtask boundary, use one \`cleanup\` to drop settled tool noise, then continue.
</oh-my-clm-dsh-live-context>`;
}
