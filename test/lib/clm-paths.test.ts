import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	CLM_MIRROR_FILENAME,
	CLM_TEMP_ROOT,
	sessionDirectory,
	sessionMirrorPath,
} from "../../src/lib/clm-paths.ts";
import { writePrivateText } from "../../src/lib/clm-files.ts";

test("session artifact paths are absolute, stable, and isolated from cwd", () => {
	const sessionId = "session-123";
	assert.equal(sessionDirectory(sessionId), "/tmp/clm-session-123");
	assert.equal(sessionMirrorPath(sessionId), `/tmp/clm-session-123/${CLM_MIRROR_FILENAME}`);
	assert.equal(CLM_TEMP_ROOT, "/tmp");
	assert.notEqual(sessionMirrorPath("session-123"), sessionMirrorPath("session-456"));
});

test("session IDs cannot escape the temporary root", () => {
	assert.equal(sessionMirrorPath("nested/session"), "/tmp/clm-nested%2Fsession/LIVE_CTX_MAIN.md");
	assert.throws(() => sessionMirrorPath(""), /non-empty session ID/);
	assert.throws(() => sessionMirrorPath("   "), /non-empty session ID/);
});

test("session artifacts are private files on POSIX hosts", { skip: process.platform === "win32" }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-clm-private-"));
	const artifact = path.join(root, "nested", "LIVE_CTX_MAIN.md");
	try {
		writePrivateText(artifact, "private mirror");
		assert.equal(fs.statSync(path.dirname(artifact)).mode & 0o777, 0o700);
		assert.equal(fs.statSync(artifact).mode & 0o777, 0o600);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
