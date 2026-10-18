# DSH evidence artifacts

`dsh-clm/` is now generated output only: `scripts/build-dsh-plugin.mjs` writes the DSH plugin tarballs there and the directory is gitignored. The mock-host harness lives in [`test/harness/`](../../test/harness), and the evidence reports live in this folder.

The current DSH contract is **native `Session.append()` surface replacement** with **step-scoped `developer/message` coordinates**. The current mock host harness is `test/harness/clm-dsh-host-test.mjs`; after rebuilding `dist`, run:

```text
node test/harness/clm-dsh-host-test.mjs /home/deepseek-agent/oh-my-clm
```

It checks `defineTool()` schema validation and cleanup registration, the dynamic `<oh-my-clm-block-index>` runtime context, refreshed block indexes in cleanup results, direct active-surface deletion, canonical mirror writing before the tool returns, open turn/step metadata, the append-only event log, `surfaceOp.replace` surface nodes, assistant/tool pairing, strict shrink-only rejection, canonical mirror rewrite, `agent/pre-step` deferral until `step/start`, private artifact behavior, and the absence of proposal/receipt artifacts.

`dsh-plugin-test-report.md`, `dsh-host-test-report.txt`, and `test/harness/clm-mount-probe.mjs` are **historical artifacts from the superseded mirror-only/proposal implementation**. Their references to `LIVE_CTX_MAIN.patch.json`, non-mutating behavior, old assertion counts, or the old profile installation must not be used as evidence for the current build. The external profile run recorded there is retained only as historical evidence for bundle activation and mirror/file-tool access; it did not verify the current append seam or real persistence.

The current source/mock evidence is recorded in `docs/reckless/evidence-ledger.md` (E-016, E-020, E-021), and the latest local output is `dsh-host-test-report-current.txt`. Real DSH profile installation, `session/flush`, restart recovery, and fork behavior remain unverified under the repository constraints.
