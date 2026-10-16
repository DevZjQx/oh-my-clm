# Reckless Roadmap

## Current bet

When a Pi session accumulates stale tool output or old assistant turns, the model can edit `.pi/clm/LIVE_CTX_MAIN.md` during a normal agent turn and immediately get a shorter, branch-local projection without a second compaction runtime.

The near-term bet is not upstream benchmark parity. It is a trustworthy, small Pi-native context editor.

## Status

- [x] S0 — Read-only baseline and evidence ledger initialized.
- [x] S1 — Align or isolate token estimation.
- [ ] S2 — Add protocol and lifecycle edge-case tests.
- [ ] S3 — Reduce dead surface and clarify Pi/DSH boundaries.
- [ ] S4 — Update factual documentation and decision records.
- [ ] S5 — Run final mechanical checks and, if available, real host smoke tests.

No source code change has been made as part of S0.

S1 completion note: the shared estimator now uses the current Pi host's `3.5 chars/token` approximation for supported Pi message shapes, including system sections and tool declarations when supplied as structured messages. DSH-specific shapes retain an explicit shared fallback; the shared layer still imports no Pi-only runtime. The public Pi `ExtensionContext` exposes the effective system prompt but not tool declarations, so the extension's fixed-token term documents that missing tool overhead as an incomplete approximation.

## Plan lines

### S1 — Token estimation

Goal: make budget/status numbers honest relative to the current Pi host estimator without weakening the edit gate.

Action:

- Compare shared estimator behavior with the current Pi host estimator.
- Choose either a shared `3.5 chars/token` approximation or a host-specific estimator boundary.
- Keep DSH loadable without importing Pi-only runtime packages.

Acceptance signal:

- User/assistant/tool/image fixtures have an explicit expected result.
- Pi-side fixtures match the host estimator under the documented approximation.
- Any DSH fallback difference is documented and tested.
- Host inputs unavailable through the public Pi extension contract are explicitly marked incomplete rather than silently treated as zero.

If-then recovery:

- If one shared estimator cannot satisfy both hosts, split the estimator at the host boundary.
- If a test fails because system/tool definitions are omitted, do not lower the threshold; add the missing input or mark the estimate as incomplete.

### S2 — Protocol and lifecycle tests

Goal: exercise failure paths that can affect the next provider request.

Action:

- Add tests for multiple tool calls, partial/missing results, stale mirrors, external edits, preview truncation, and interleaved session/cwd state where the host contract permits it.
- Verify rejected edits do not produce partial context drafts.
- Verify accepted edits still preserve Pi branch semantics.

Acceptance signal:

- Every new failure-path fixture has a deterministic rejected/applied result.
- `npm test` remains green.
- No test relies on full mirror contents being printed as a side effect.

If-then recovery:

- If the host contract guarantees one extension/session instance, record that fact and avoid speculative global-state machinery.
- If a real supported message shape is rejected, add the smallest parser change and a regression test; do not switch to unrestricted parsing.

### S3 — Scope reduction

Goal: remove misleading or dead surface without changing the live-context contract.

Action:

- Review `src/compact.ts`, `src/trajectory.ts`, and the placeholder test.
- Remove or replace dead placeholders only if they are not part of a published contract.
- Keep DSH code as an explicit optional proposal adapter, not part of the Pi core claim.

Acceptance signal:

- Core entry points are obvious: `extensions/clm.ts` and `src/context-format.ts`.
- Package contents do not imply that DSH session mutation or trajectory export exists.
- `npm pack --dry-run` still contains only intended publish files.

Hold:

- Do not remove a file if package metadata, external consumers, or a documented import contract depends on it; record the dependency first.

### S4 — Documentation truth pass

Goal: make the public description match verified behavior.

Action:

- Correct token-estimator wording.
- Keep the distinction between Pi `context_edit` persistence and DSH patch proposal.
- State explicitly that the current implementation is structured/block-oriented, not unrestricted upstream parity.
- Update `evidence-ledger.md`, `decision-record.md`, and this roadmap at the milestone.

Acceptance signal:

- Every load-bearing README claim has a source or an explicit `unresolved` label.
- No wording says that a DSH patch changed the active session without a host-policy test.

### S5 — Final verification and handoff

Goal: deliver a reproducible, bounded result.

Required checks:

```text
npm test
npm run check
npm run typecheck
npm pack --dry-run
```

Optional real-runtime checks:

- Pi agent turn with a real provider, if credentials and a safe test task are available.
- DSH install/activation/provider smoke test, only if the real DSH profile and packages are available.

Acceptance signal:

- Required checks pass.
- Optional checks are reported separately as `verified`, `inconclusive`, or `unresolved`.
- `.pi/clm/LIVE_CTX_MAIN.md` and patch files are not in the package.
- Final handoff names entry points, commands, observations, limits, and the next evidence-backed bet.

If-then recovery:

- If DSH runtime is unavailable, hold the DSH activation claim and finish the Pi deliverable.
- If provider/runtime checks fail, separate environment failure from plugin logic and do not add speculative fixes without new evidence.

## Drift and recovery budget

Drift is allowed only inside the current plan line and only while it produces a new observable. After two consecutive actions with no new evidence, stop and recover from the last verified milestone. Re-planning may change only the invalidated plan line; it must not silently expand the project into a full upstream harness.

## Executor and handoff

- Executor after explicit implementation approval: coding assistant in this repository.
- Terms that must stay exact: `Pi-native`, `branch-local context_edit`, `DSH explicit patch proposal`, `estimator approximation`, `unresolved`.
- Re-entry observable: a passing acceptance check, a reproducible host contract, or a written benchmark requirement that changes the route.
