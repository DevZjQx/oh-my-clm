// Point this repository's credential.helper at scripts/git-credential.mjs.
// Idempotent: re-running only rewrites the two local config entries.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { readDotEnv, resolveRepoRoot } from "./git-credential.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);
const helper = path.join(repoRoot, "scripts", "git-credential.mjs");
const shellQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;

function git(...args) {
	return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

if (git("rev-parse", "--is-inside-work-tree") !== "true") {
	throw new Error(`not inside a git work tree: ${repoRoot}`);
}

// An empty helper value clears the inherited list (for example the global
// `store` helper), then the local helper is appended. Without the reset the
// global store would still try to cache the token in ~/.git-credentials.
git("config", "--local", "--replace-all", "credential.helper", "");
git("config", "--local", "--add", "credential.helper", `!${shellQuote(process.execPath)} ${shellQuote(helper)}`);

const env = readDotEnv(repoRoot);
if (!env.GITHUB_TOKEN) {
	process.stderr.write("oh-my-clm: warning: .env has no GITHUB_TOKEN yet; pushes will keep using the next helper.\n");
}

process.stdout.write(`credential.helper configured for ${repoRoot}\n`);
process.stdout.write("verify with: git config --local --get-all credential.helper\n");
