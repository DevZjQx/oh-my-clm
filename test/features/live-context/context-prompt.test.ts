import assert from "node:assert/strict";
import test from "node:test";
import { dshPromptText } from "../../../src/features/live-context/context-prompt.ts";

const mirrorTemplate = "/tmp/clm-test/LIVE_CTX_MAIN.md";

test("the DSH prompt quotes the cleared pointer the model will read", () => {
	const text = dshPromptText({ mirrorTemplate });
	assert.match(text, /\[cleared <size>/);
	assert.match(text, /re-read before editing\]/);
	assert.match(text, /Prefer `cleanup`/);
	assert.match(text, /edit the session mirror/);
	assert.match(text, /subtask boundary/);
	assert.doesNotMatch(text, /the user still sees/, "the index header owns what a clear leaves behind");
	assert.doesNotMatch(text, /CLM_CANARY|CLM_AUTO_CLEAR|autoClear\.enabled/);
	assert.ok(text.length <= 800, `DSH prompt grew to ${text.length} chars`);
});
