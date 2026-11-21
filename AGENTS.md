# Agent rules

Repository: Pi extension + DSH/Cordis plugin. `npm test` and `npm run check` gate a change; CI runs both plus `npm run typecheck`.

## Invariants

A change that needs one of these to bend must bring the test that encodes the new contract.

| Rule | Owner |
| --- | --- |
| The session log is the fact; only the model-visible copy changes. | `src/features/live-context/clear-projection.ts`, `src/features/live-context/dsh-bridge.ts` |
| Every edit strictly shrinks the estimated context; there is no off switch. | `src/features/live-context/context-format.ts` |
| Automatic clears write through the host's `appendPluginRecord` (`Session.append()` cannot mark a record `ignorable`), so a missing seam leaves the channel off. | `src/features/live-context/plugin-record.ts` |
| `autoClear.canary` changes the model input by zero bytes. | `src/features/live-context/auto-clear.ts` |
| Replaying one log twice yields the same projection. | `src/features/live-context/clear-projection.ts` |
| The host owns compaction and the context window; the plugin stops at `autoClear.stopPercent`. | `docs/features/auto-clear.md` |
| Clearing targets context rot, not the bill. | `README.md#边界` |

## Documentation

Docs are read by users and by agents that copy the nearest example. Keep them to current contracts.

| Rule | Enforced by |
| --- | --- |
| Docs describe current behavior only; release versions, earlier designs, measurements, and “why it used to be” go to `git log`. | `scripts/check-docs.mjs` rejects release versions, retrospective wording, and “why/history” headings in `README.md` and `docs/**`. |
| Point at the file whose module comment owns the detail; link instead of writing when a source comment or `git diff` already says it. | `scripts/check-docs.mjs` rejects a long sentence copied from `src/**`, `extensions/**`, or `dsh/**` comments; the rest is review judgment. |
| One fact has one owner: `README.md` for install, config, and the full config table; `docs/features/` for behavior contracts; `docs/project-structure.md` for layout. | Review judgment. |

## Code

| Rule | Enforced by |
| --- | --- |
| Layers are `src/lib` → `src/features/<one feature>` → `extensions/**` / `dsh/**`; no cross-feature imports, no barrel files under `src`. | `scripts/check-boundaries.mjs` (`npm run check`). |
| The DSH host entry must have a complete relative import closure in the built `dist`. | `scripts/check-dsh-package.mjs` (`npm run check`). |
| `dsh-plugin.json` and `package.json` agree on name, version, host entry, and bundle patch. | `test/package/**` and `scripts/check-dsh-package.mjs`. |
| Behavior changes come with the test that fails before the change. | `npm test`. |
