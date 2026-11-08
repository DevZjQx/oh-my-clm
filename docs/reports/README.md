# DSH evidence artifacts

`artifacts/` is now generated output only: `scripts/build-dsh-plugin.mjs` writes the DSH plugin tarballs there and the directory is gitignored. The mock-host harness lives in [`test/harness/`](../../test/harness), and the evidence reports live in this folder.

The current DSH contract is **native `Session.append()` surface replacement** with **step-scoped `developer/message` coordinates**. The current mock host harness is `test/harness/clm-dsh-host-test.mjs`; after rebuilding `dist`, run:

```text
node test/harness/clm-dsh-host-test.mjs /home/deepseek-agent/oh-my-clm
```

It checks the plain cleanup tool definition and shared argument parser (not `defineTool` schema validation), the dynamic `<oh-my-clm-block-index>` runtime context, compact cleanup results by default with opt-in `full` result copies, direct active-surface deletion, canonical mirror writing before the tool returns, open turn/step metadata, the append-only event log, `surfaceOp.replace` surface nodes, assistant/tool pairing, strict shrink-only rejection, canonical mirror rewrite, `agent/pre-step` deferral until `step/start`, private artifact behavior, and the absence of proposal/receipt artifacts.

The superseded mirror-only/proposal implementation's artifacts (`dsh-plugin-test-report.md`, `dsh-host-test-report.txt`, and `test/harness/clm-mount-probe.mjs`) have been removed; their history remains in git. Their old `LIVE_CTX_MAIN.patch.json` and non-mutating behavior must not be used as evidence for the current build.

The latest local harness output is `dsh-host-test-report-current.txt` (99 passed, 0 failed, 1 observation). Real DSH profile installation, `session/flush`, restart recovery, and fork behavior remain unverified under the repository constraints.
