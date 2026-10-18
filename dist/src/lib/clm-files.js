import * as fs from "node:fs";
import * as path from "node:path";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
/**
 * Write a session artifact atomically and keep it private to the current user.
 * The mirror can contain model reasoning and tool output, so the temporary
 * directory and its mirror file should not inherit a world-readable umask.
 */
export function writePrivateText(filePath, content) {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, content, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
        fs.chmodSync(temporaryPath, PRIVATE_FILE_MODE);
        fs.renameSync(temporaryPath, filePath);
        fs.chmodSync(filePath, PRIVATE_FILE_MODE);
    }
    finally {
        try {
            if (fs.existsSync(temporaryPath))
                fs.unlinkSync(temporaryPath);
        }
        catch {
            // The next lifecycle pass will replace the canonical artifact.
        }
    }
}
