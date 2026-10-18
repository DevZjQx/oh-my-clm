import * as path from "node:path";

/** The live-context artifacts intentionally live outside the project tree. */
export const CLM_TEMP_ROOT = "/tmp";
export const CLM_MIRROR_FILENAME = "LIVE_CTX_MAIN.md";

function encodedSessionId(sessionId: string): string {
	if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
		throw new Error("oh-my-clm requires a non-empty session ID");
	}
	return encodeURIComponent(sessionId);
}

export function sessionDirectory(sessionId: string): string {
	return path.join(CLM_TEMP_ROOT, `clm-${encodedSessionId(sessionId)}`);
}

export function sessionMirrorPath(sessionId: string): string {
	return path.join(sessionDirectory(sessionId), CLM_MIRROR_FILENAME);
}
