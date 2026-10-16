# Evidence Ledger

> Scope: `oh-my-clm` 与 Facebook `context-language-models/clm/clm_harness` 的只读比较。
>
> 本记录区分 source、observation、interpretation 和 conclusion。`verified` 只表示对应检查覆盖的机械事实，不扩展到未执行的真实 runtime 或用户效果。

## Status vocabulary

- `observed`: 在当前 session 直接看到的事实。
- `verified`: 通过指定命令或独立检查确认的事实。
- `inferred`: 根据已打开源码作出的判断，不等于运行时证明。
- `unresolved`: 当前环境没有足够证据。
- `rejected`: 已被当前证据否定的说法。
- `hold`: 需要外部 runtime、用户授权或新的验证条件后再继续。

## Ledger

### E-001 — Local source baseline

- Status: `observed`
- Source: `/home/sandbox/oh-my-clm` 的 Git 状态与目录。
- Observation: 当前 branch 没有 commit；项目文件基本都处于 untracked 状态；没有 configured remote。
- Interpretation: 当前代码没有可引用的本地 commit 基线，后续变更前应至少保存命令结果和测试结果。
- Conclusion: `verified` 只用于本次工作树状态，不把当前源码声称为某个可复现版本。
- Limit: 未创建 Git commit，也未对外发布版本。
- Plan impact: S0 基线记录必须先完成；本项目不自动创建 commit。

### E-002 — Local mechanical checks

- Status: `verified`
- Source: 本 session 执行的命令。
- Commands:
  - `npm test`
  - `npm run check`
  - `npm run typecheck`
  - `npm pack --dry-run`
- Observation: `npm test` 通过 27 个测试；check、typecheck 和 dry-run 通过。
- Interpretation: 当前源码能通过现有 TypeScript、单元测试、DSH package check 和打包检查。
- Conclusion: 当前实现不是“无法构建的半成品”。
- Coverage: 只覆盖现有 mock host、in-memory Pi session、静态类型和 package contract；不覆盖真实 provider、真实 DSH CLI 或模型行为。
- Plan impact: 可进入设计改进阶段；不能将该 pass 解释为端到端成功。

### E-003 — Upstream source version and core files

- Status: `verified`
- Source: `/tmp/context-language-models-upstream`, commit `483198229ab7b90c0eed4651306ab3b3505aaf50`。
- Opened files:
  - `clm/clm_harness/README.md`
  - `clm/clm_harness/clm_agent/harness.py`
  - `clm/clm_harness/context_env/env.py`
  - `clm/clm_harness/context_utils/context_string.py`
  - `clm/clm_harness/utils/budget.py`
  - `clm/clm_harness/agent_trajectory_format/`
- Observation: upstream 拥有独立 agent loop、Bash-only action、mirror read-back、budget state machine、rollback/retry、context snapshots 和 ATIF-CTX export。
- Interpretation: upstream `clm_harness` 是完整执行/评测 runtime，不只是 mirror parser。
- Conclusion: 当前 Pi 插件不应被描述为 upstream harness 的等价实现。
- Limit: 未运行 upstream benchmark；只比较已打开源码和 README。
- Plan impact: 选择 Pi-native 路线；完整 parity 作为独立后续路线，不进入当前核心。

### E-004 — Current Pi-native lifecycle

- Status: `verified`
- Source:
  - `extensions/clm.ts:134-184`
  - `extensions/clm.ts:312-365`
  - `src/context-format.ts:520-813`
- Observation: 当前实现通过 Pi `context` hook 生成 mirror，在 `turn_end` 解析 mirror，并返回 Pi `context_edit` drafts；原始 session entry 不由插件直接改写。
- Interpretation: 该实现把 CLM 机制接入 Pi 原生 projection/branch 语义，而不是复制 agent loop。
- Conclusion: 作为 Pi-native context editing adapter，核心数据流是明确且可审计的。
- Coverage: 现有测试覆盖 in-memory context edit 和 branch 隔离；未覆盖真实 provider turn。
- Plan impact: 不新增第二套 Pi agent loop。

### E-005 — Structured safety boundary

- Status: `verified`
- Source:
  - `src/context-format.ts:164-226`
  - `src/context-format.ts:252-352`
  - `src/context-format.ts:520-813`
  - `test/context-format.test.ts`
- Observation: 当前协议使用 snapshot、稳定内部 ID、可读 ordinal、role 检查、unknown/duplicate 拒绝、user replacement 拒绝、shrink-only gate 和 tool-call/result 配对处理。
- Interpretation: 当前 mirror 不是 upstream 的 unrestricted raw text round-trip，而是结构化、安全优先的 block editor。
- Conclusion: 当前更适合 Pi 生产语义，但 CLM 的编辑表达能力比 upstream 窄。
- Limit: 安全校验不证明摘要内容语义正确，也不防止模型误删重要事实。
- Plan impact: 保留结构化默认模式，不为追求 parity 盲目放宽 parser。

### E-006 — Baseline token estimator mismatch

- Status: `verified`
- Sources:
  - Current baseline: `src/context-format.ts`
  - Pi host: `node_modules/@earendil-works/pi-ai/dist/utils/estimate.js`
- Observation: S0 基线的共享 estimator 使用 `ceil(chars / 4)`；当前 Pi host estimator 使用 `CHARS_PER_TOKEN = 3.5`。直接检查结果：3500 字符文本基线为 875 tokens，Pi host 为 1000；42 字符样本基线为 11，Pi host 为 12。
- Interpretation: 基线 budget/status 近似可能比 Pi host 乐观；README 中“遵循 Pi 的 chars/4 近似”不能同时被解释为“与当前 Pi estimator 一致”。
- Conclusion: 这是 S1 的 load-bearing 修正项；该基线差异已由 E-009 处理，本条保留为修正前证据。
- Coverage: 这是 estimator 对照，不是 provider tokenizer 的精确证明；system sections 和 tool declarations 在基线中仍未覆盖。
- Plan impact: S1 需要修正或隔离 host-specific estimator；不得通过放宽 shrink gate 来掩盖差异。

### E-007 — DSH runtime boundary

- Status: `unresolved`
- Sources:
  - `README.md:82-112`
  - `src/dsh-bridge.ts`
  - `dsh/index.ts`
  - `test/dsh-bridge.test.ts`
  - `npm ls @deepseek-ai/cordis @deepseek-ai/dsh --all`
- Observation: DSH bridge 会生成 `.pi/clm/LIVE_CTX_MAIN.patch.json`，但不会把 patch 写回 DSH session；本地 optional DSH packages 未安装；现有测试是 mock host/manifest/package contract。
- Interpretation: `status: applied` 表示编辑计划被共享层接受，不表示 active DSH context 已改变。
- Conclusion: 真实 DSH 安装、激活、host policy 消费和 provider 请求仍未验证。
- Plan impact: README/roadmap 必须保持 `hold` 或 `unresolved` 语义；没有真实 host contract 前不实现 speculative patch consumer。

### E-008 — User-visible CLM benefit

- Status: `unresolved`
- Source: 当前 session 没有真实 provider/model rollout 或用户反馈。
- Observation: 只有机械测试通过；没有 accuracy、exact-recall、latency、cost 或多 seed 结果。
- Interpretation: 当前可以证明“编辑链路能工作”，不能证明“模型会正确管理上下文”或“任务效果变好”。
- Conclusion: 产品收益仍是待验证假设。
- Plan impact: 后续如做真实 runtime smoke test，必须把可达性、重复一致性和任务效果分开记录。

### E-009 — Shared estimator aligned to the Pi host approximation

- Status: `verified`
- Sources:
  - Shared implementation: `src/context-format.ts`
  - Pi host implementation: `node_modules/@earendil-works/pi-ai/dist/utils/estimate.js`
  - Regression fixtures: `test/context-format.test.ts`
- Observation: 共享 estimator 已切换到 `3.5 chars/token`，并按当前 Pi host 规则处理支持的 text、thinking、tool call、image、system sections 和 tool declaration lists。直接调用共享实现与 Pi host estimator 的对照 fixture 全部一致；DSH-specific `reasoning`、`custom`、`bashExecution`、summary 和 `tool` shapes 由共享 fallback 覆盖并有独立测试。
- Interpretation: 选择“共享 3.5 近似 + 明确 DSH fallback”而不是导入 Pi runtime，保持 `src/context-format.ts` 可被 Pi 和 DSH 共同加载；host-only fixed prompt tokens 仍由调用方显式提供。
- Conclusion: S1 的 estimator acceptance signal 已满足：Pi-side fixtures 在记录的近似下对齐，DSH fallback 有文档和测试，shrink-only gate 未放宽；不可从公开 Pi extension contract 取得的 tool overhead 被明确标为 incomplete。
- Coverage: 证明的是当前 Pi host estimator 的机械对齐，不是任何 provider tokenizer、真实 context window 或 DSH runtime 行为的证明。
- Limit: 当前 Pi `ExtensionContext` 只暴露 effective system prompt，扩展的 `fixedRequestTokens` 不能独立计入 tool declaration overhead；Pi host estimator 的常数或消息契约未来变化时需要重新对照；真实 DSH 安装和 provider smoke test 仍 unresolved。
- Verification: `npm test` 通过 29 个测试；`npm run check`、`npm run typecheck` 和 `npm pack --dry-run` 均通过。
- Plan impact: S1 完成；下一步回到 S2 协议和生命周期边界测试。

## Evidence lineage note

E-002、E-004、E-005 共同依赖当前项目测试和 host 类型契约，因此它们可以证明机械接口行为，但不能独立证明模型策略质量。E-006 记录修正前的 estimator 不一致；E-009 使用独立的 Pi host estimator 源文件和直接 fixture 对照，支持“当前共享近似已对齐”的条件化结论；它们都不证明任何 provider 的精确 tokenizer。

## Maintenance triggers

更新本文件的节点：

1. 每个计划步骤的 acceptance check 完成后；
2. 发现测试失败、协议意外或新的 host limitation 时；
3. 进入或解除 `hold` 状态时；
4. 最终交付时，补上命令输出摘要和未验证项。
