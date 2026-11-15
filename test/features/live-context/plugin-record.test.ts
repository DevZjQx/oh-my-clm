import { strict as assert } from "node:assert";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	PLUGIN_RECORD_MODULE,
	resolvePluginRecordWriter,
} from "../../../src/features/live-context/plugin-record.ts";

/**
 * A real DSH profile cannot resolve `@deepseek-ai/dsh-session`: the plugin is
 * installed under `~/.dsh/profiles/<name>/node_modules`, while the host package
 * lives under the DSH installation. A bare `import()` from the plugin therefore
 * fails and a profile with clearing enabled latches `unrecordable`. These tests
 * pin the resolution anchors that make the seam reachable.
 */

interface Fixture {
	readonly root: string;
	readonly entry: string;
	readonly packageDir: string;
	readonly specifier: string;
}

function fixture(name: string, moduleSource: string): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "clm-record-"));
	const entry = path.join(root, "host", "lib", "bin.js");
	const packageDir = path.join(root, "host", "node_modules", name);
	fs.mkdirSync(path.dirname(entry), { recursive: true });
	fs.mkdirSync(packageDir, { recursive: true });
	fs.writeFileSync(entry, "// host entry\n", "utf8");
	fs.writeFileSync(
		path.join(packageDir, "package.json"),
		JSON.stringify({ name, version: "1.0.0", type: "module", exports: { ".": "./index.mjs" } }),
		"utf8",
	);
	fs.writeFileSync(path.join(packageDir, "index.mjs"), moduleSource, "utf8");
	return { root, entry, packageDir, specifier: name };
}

const SEAM_SOURCE = [
	"export class Session {}",
	"export function appendPluginRecord(session, type, data) {",
	"\tsession.records ??= [];",
	"\tsession.records.push({ type, data, ignorable: true });",
	"\treturn session.records.length;",
	"}",
].join("\n");

test("a host entry reaches a package the plugin cannot import directly", async () => {
	const host = fixture(`fake-host-session-${process.pid}`, SEAM_SOURCE);
	// The bare specifier is only resolvable from the host's tree, which is the
	// real profile's layout (plugin in the profile, host in the install).
	await assert.rejects(import(host.specifier), /ERR_MODULE_NOT_FOUND/);
	const seam = await resolvePluginRecordWriter(host.specifier, { hostEntries: [host.entry] });
	assert.ok(seam !== undefined, "the host entry must resolve the seam");
	const session: { records?: { type: string; data: unknown; ignorable: boolean }[] } = {};
	assert.equal(typeof seam.write, "function");
	assert.equal(seam.write(session, "plugin:test/clear", { v: 1 }), 1);
	assert.deepEqual(session.records?.[0]?.type, "plugin:test/clear");
	assert.equal(session.records?.[0]?.ignorable, true);
});

test("an exported Session class proves the seam owns this session", async () => {
	const host = fixture(`fake-host-owned-${process.pid}`, SEAM_SOURCE);
	const seam = await resolvePluginRecordWriter(host.specifier, { hostEntries: [host.entry] });
	assert.ok(seam?.owns !== undefined, "a module exporting Session gets an identity check");
	const loaded = await import(pathToFileURL(path.join(host.packageDir, "index.mjs")).href);
	assert.equal(seam.owns(new loaded.Session()), true);
	assert.equal(seam.owns({}), false, "another module copy's session is not this seam's");
});

test("a module without Session still yields a writer but no identity claim", async () => {
	const host = fixture(
		`fake-host-anonymous-${process.pid}`,
		"export function appendPluginRecord() { return 7; }",
	);
	const seam = await resolvePluginRecordWriter(host.specifier, { hostEntries: [host.entry] });
	assert.ok(seam !== undefined);
	assert.equal(seam.owns, undefined);
});

test("an absolute path or file URL is imported as given", async () => {
	const host = fixture(`fake-host-direct-${process.pid}`, SEAM_SOURCE);
	const absolute = path.join(host.packageDir, "index.mjs");
	assert.ok((await resolvePluginRecordWriter(absolute)) !== undefined);
	assert.ok((await resolvePluginRecordWriter(pathToFileURL(absolute).href)) !== undefined);
});

test("global module roots are a fallback when the entry is not in argv", async () => {
	const host = fixture(`fake-host-root-${process.pid}`, SEAM_SOURCE);
	const seam = await resolvePluginRecordWriter(host.specifier, {
		hostEntries: [],
		moduleRoots: [path.join(host.root, "host")],
	});
	assert.ok(seam !== undefined, "a hoisted install under a root must resolve");
});

test("a missing seam and a module without the writer both return undefined", async () => {
	const host = fixture(`fake-host-empty-${process.pid}`, "export const unrelated = 1;");
	assert.equal(await resolvePluginRecordWriter(host.specifier, { hostEntries: [host.entry] }), undefined);
	assert.equal(await resolvePluginRecordWriter(`no-such-clm-host-${process.pid}`), undefined);
	assert.equal(PLUGIN_RECORD_MODULE, "@deepseek-ai/dsh-session");
});
