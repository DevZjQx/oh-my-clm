import assert from "node:assert/strict";
import test from "node:test";
import { dshPromptText } from "../../../src/features/live-context/context-prompt.ts";

const mirrorTemplate = "/tmp/clm-test/LIVE_CTX_MAIN.md";

test("the DSH prompt names the cleared pointer, cleanup, and the mirror", () => {
	const text = dshPromptText({ mirrorTemplate });
	assert.match(text, /\[cleared <size>/);
	assert.match(text, /re-read/);
	assert.match(text, /Prefer `cleanup`/);
	assert.match(text, /edit the session mirror/);
	assert.match(text, /subtask boundary/);
	assert.doesNotMatch(text, /CLM_CANARY|CLM_AUTO_CLEAR|autoClear\.enabled/);
	assert.ok(text.length <= 800, `DSH prompt grew to ${text.length} chars`);
});
