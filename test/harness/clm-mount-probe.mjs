/**
 * One-shot diagnostic plugin for the oh-my-clm mount test.
 *
 * It is inserted as an ordinary profile user-layer row, waits for the Cordis
 * loader to settle, then records the live loader entry state plus the assembled
 * system-prompt sections into /tmp/clm-mount-probe.json and exits.
 */
import * as fs from "node:fs";

export const name = "clm-mount-probe";
export const inject = ["loader"];

export function apply(ctx) {
	const report = {
		probe: "clm-mount-probe",
		entry: null,
		interestingEntries: [],
		promptSection: null,
		promptSectionCount: null,
		errors: [],
	};
	const finish = async () => {
		try {
			await ctx.loader.await();
			for (const entry of ctx.loader.entries()) {
				const row = {
					id: entry.id,
					name: entry.options?.name,
					disabled: entry.disabled,
					fiberState: entry.fiber?.state,
					fiberError: entry.fiber?.error ? String(entry.fiber.error?.message ?? entry.fiber.error) : undefined,
				};
				if (entry.options?.name === "oh-my-clm" || /oh-my-clm/.test(entry.id)) report.entry = row;
				if (/oh-my-clm|clm-mount-probe/.test(`${entry.id} ${entry.options?.name ?? ""}`)) report.interestingEntries.push(row);
			}
			const systemPrompt = ctx.get("systemPrompt");
			if (systemPrompt === undefined) {
				report.errors.push("systemPrompt service is not available");
			} else {
				const assembly = await systemPrompt.assemble({});
				report.promptSectionCount = assembly.sections.length;
				const section = assembly.sections.find((candidate) => candidate.name === "oh-my-clm:live-context");
				report.promptSection = section
					? {
							name: section.name,
							chars: section.text.length,
							mentionsMirror: section.text.includes("LIVE_CTX_MAIN.md"),
							mentionsPatch: section.text.includes("LIVE_CTX_MAIN.patch.json"),
							head: section.text.slice(0, 120),
						}
					: null;
			}
		} catch (error) {
			report.errors.push(String(error?.stack ?? error));
		}
		fs.writeFileSync("/tmp/clm-mount-probe.json", `${JSON.stringify(report, null, 2)}\n`);
		process.exit(0);
	};
	setTimeout(() => {
		void finish();
	}, 4000);
}
