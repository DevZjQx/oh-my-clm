// Git credential helper that answers for github.com using the repository's
// gitignored .env file, so pushes work without `gh`, SSH keys, or a global
// credential store. Install it once per clone with `npm run git:setup`.
//
// The helper never writes the token anywhere; it only prints it to git on the
// `get` operation, and only when the request is for github.com. `store` and
// `erase` are ignored on purpose so nothing lands in ~/.git-credentials.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveRepoRoot(metaUrl) {
	return path.resolve(path.dirname(fileURLToPath(metaUrl)), "..");
}

/** Parse the KEY=VALUE subset of dotenv syntax used by this repository. */
export function readDotEnv(repoRoot) {
	const file = path.join(repoRoot, ".env");
	if (!fs.existsSync(file)) return {};
	const values = {};
	for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		const value = match[2].trim();
		const quoted = /^(['"])(.*)\1$/.exec(value);
		values[match[1]] = quoted ? quoted[2] : value;
	}
	return values;
}

function readCredentialRequest() {
	return new Promise((resolve) => {
		if (process.stdin.isTTY) return resolve({});
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			const fields = {};
			for (const line of data.split(/\r?\n/)) {
				if (!line) continue;
				const index = line.indexOf("=");
				if (index === -1) fields[line] = "";
				else fields[line.slice(0, index)] = line.slice(index + 1);
			}
			resolve(fields);
		});
	});
}

const invokedDirectly = process.argv[1] !== undefined
	&& path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
	const operation = process.argv[2] ?? "";
	const request = await readCredentialRequest();
	const host = request.host ?? "";
	const isGitHub = host === "github.com" || host === "github.com:443";
	// Other helpers stay in charge for every host we do not own, and for
	// store/erase there is deliberately nothing to persist.
	if (operation !== "get" || !isGitHub) process.exit(0);

	const env = readDotEnv(resolveRepoRoot(import.meta.url));
	const token = env.GITHUB_TOKEN;
	if (!token) {
		process.stderr.write("oh-my-clm: GITHUB_TOKEN is missing from .env; falling through to the next credential helper.\n");
		process.exit(1);
	}
	if (/[\r\n]/.test(token)) {
		process.stderr.write("oh-my-clm: GITHUB_TOKEN in .env must be a single line.\n");
		process.exit(1);
	}
	process.stdout.write(`username=${env.GITHUB_USER || "x-access-token"}\n`);
	process.stdout.write(`password=${token}\n`);
}
