# Decision Record: Pi-native Suckless Core

## Decision

选择 **Pi-native Suckless Core**，不把 Facebook `clm_harness` 的完整 agent runtime 移植进当前插件。

当前项目的目标定义为：

> 在 Pi 中提供一个少依赖、可审计、branch-local 的 live-context 编辑能力；复用 Pi 已有的 agent loop、session projection、context edit 和 native compaction。

这不是“完整复刻 upstream CLM evaluation harness”的承诺。

## Context

已打开并比较：

- 当前：`extensions/clm.ts`、`src/context-format.ts`、`src/dsh-bridge.ts`、相关测试和文档；
- upstream：`facebookresearch/context-language-models` 的 commit `483198229ab7b90c0eed4651306ab3b3505aaf50`，重点是 `clm/clm_harness`。

当前实现已经通过本地机械检查，但真实 DSH runtime、真实 provider budget 行为和模型上下文管理效果尚未验证。

S1 的 estimator 边界决策是：共享格式层采用当前 Pi host 的 `3.5 chars/token` provider-independent 近似，并复刻支持消息形状的 rounding、system sections 和 tool declaration 估算；DSH-specific 消息形状保留明确 fallback。共享层不导入 Pi runtime，host-only fixed prompt tokens 由调用方显式提供。当前 Pi extension 的公开 `ExtensionContext` 没有 tool declaration accessor，因此未提供的 tool overhead 必须保持为 incomplete approximation，不通过未公开 API 猜测。

## Options considered

### Option A — Pi-native adapter（selected）

```text
Pi projection
  -> LIVE_CTX_MAIN.md
  -> parse/snapshot/tool-pair/shrink validation
  -> Pi context_edit
  -> next branch-local projection
```

Characteristics:

- 不复制 Pi agent loop；
- 不修改原始 session JSONL；
- 保留 Pi branch/fork/resume 语义；
- 使用普通 `edit`/`write` 作为模型操作接口；
- 结构化 block editor 默认禁止新增任意 context entry；
- DSH 只提供明确 patch proposal，等待 host policy；
- 共享 estimator 使用 Pi host 的 `3.5 chars/token` 近似，不把 provider tokenizer 或 Pi runtime 带入 DSH 共享层。

Strengths:

- 运行时依赖少；
- 与 Pi 原生语义一致；
- 失败时可拒绝 edit，不污染 canonical projection；
- 原始历史保留，修改可审计；
- 适合当前插件定位。

Weaknesses:

- 不是 upstream unrestricted context round-trip；
- 没有 upstream 的 rollback/retry、ATIF-CTX、FLOPs 轨迹；
- 自定义预算目前只有轻量 nudge；
- DSH patch 尚未改变 active session。

### Option B — Upstream harness parity（rejected for current scope）

引入独立的：

- agent loop；
- Bash-only tool contract；
- sandbox mirror execution；
- budget controller；
- output cap；
- rollback/retry/final-turn；
- context snapshots；
- ATIF-CTX trajectory；
- provider usage/cost/FLOPs export。

Why it was rejected:

- 重复实现 Pi 已有的 agent/session/compaction 能力；
- 显著扩大依赖、代码面和维护面；
- 与当前插件的 host-native 目标冲突；
- 需要更多未验证 runtime 假设；
- 在当前目标下属于 overbuilding，而不是最小修复。

Option B remains a valid fallback if the product objective changes to reproducing upstream benchmark semantics.

## Judgment frame

| Criterion | Option A | Option B | Current status |
|---|---|---|---|
| Pi-native integration | Pass | Needs separate runtime boundary | A preferred |
| Minimal runtime/dependencies | Pass | Fail for plugin scope | A preferred |
| Structured safety | Pass | Needs new safety contract | A preferred |
| Upstream unrestricted editing | Fail | Pass | Not required for current scope |
| Budget rollback/retry parity | Fail | Pass | Separate future capability |
| ATIF/FLOPs research evaluation | Fail | Pass | Separate future capability |
| Real DSH activation | Unresolved | Unresolved without host contract | Hold |
| Model/user benefit | Unresolved | Unresolved | Requires experiment |

## Load-bearing evidence

- Local checks pass, but only prove mechanical behavior: see `evidence-ledger.md` E-002.
- Pi context edits and branch isolation are tested: E-004.
- Current structured safety boundaries are tested: E-005.
- S0 baseline estimator mismatch and S1 alignment: E-006、E-009。
- DSH mutation is not verified: E-007.
- User-visible CLM benefit is not verified: E-008.

## Exact terms that must remain true

1. `context_edit` is branch-local and does not rewrite the original message entry.
2. DSH `status: applied` means “patch proposal accepted”, not “active DSH session changed”.
3. Current implementation is a structured block editor, not unrestricted upstream CLM parity.
4. Token estimates are approximations and must not be described as provider-exact.
5. No real DSH activation claim is allowed without a real host test.

## Reversal conditions

Reconsider Option B, or create a separate parity package, if all of the following become true:

- the project must reproduce ContextBench or upstream long-horizon benchmark semantics;
- per-call context snapshots and rollback history are required for scoring;
- Pi session JSONL cannot provide the required evaluation evidence;
- an explicit owner accepts the additional runtime/dependency surface.

The observable restart signal is a written benchmark acceptance contract requiring those artifacts.

## Hold conditions

- Hold DSH activation claims while `@deepseek-ai/cordis`/`@deepseek-ai/dsh` and a real profile are unavailable.
- Hold accuracy/cost claims until a real provider/model run is executed.
- Hold unrestricted parser changes unless a concrete task demonstrates that structured editing blocks a necessary CLM behavior.

## Review trigger

Estimator fix is recorded as E-009. Review this decision after the S2 protocol/lifecycle tests or if a host changes its message estimator contract. New evidence should be recorded in `evidence-ledger.md` before changing the route.
