# oh-my-clm

一个可直接加载到 Pi 的精简 live-context 扩展，参考
[Facebook Research context-language-models](https://github.com/facebookresearch/context-language-models/tree/main/clm/clm_harness)
的“把当前上下文镜像到普通文件、由模型自行整理”思路。

## 核心体验

Pi 为下一次请求构建当前 branch 的 projection 时，扩展会把可编辑部分镜像到：

```text
.pi/clm/LIVE_CTX_MAIN.md
```

模型可以使用普通的 `edit`、`write` 或一次短脚本修改已有 block：

```text
<!-- pi-clm-v2 -->
<!-- CLM_SNAPSHOT ... -->

[[CLM_ENTRY id=1 role=assistant]]
这段旧内容可以被改写成一句更短的事实摘要。
[[/CLM_ENTRY id=1]]
```

- 只修改 block body；保留 `CLM_SNAPSHOT`、`CLM_ENTRY` 和 closing marker。
- `id` 是从 `1` 开始的可读编辑序号；不要改 ID，也不要重排 block。扩展内部仍用 Pi 的 opaque entry ID。
- 删除一个可编辑 block 会从后续 projection 中省略该消息；删除最后一个 block 时保留 `<!-- CLM_EMPTY -->`。
- 初始用户任务受到保护，不会出现在可编辑区域中；user-authored block 可以被省略，但不能被模型改写。
- mirror preview 有固定的单 block 和总大小上限；截断只影响显示，不改变 canonical source。
- 如果工具结果读取了 `LIVE_CTX_MAIN.md`，该结果会在未来 projection 中替换成短指针，避免 mirror 自我复制。
- 改写或删除 assistant tool turn 时，配对的 tool result 也会一起处理，避免孤立的 tool message。
- 合法修改在 `turn_end` 通过 Pi 原生 `context_edit` 持久化；原始 session JSONL 不会被改写。

这不是对 session JSONL 的直接压缩：context edit 属于当前 branch，所以 `/tree`、fork 和 session resume 继续遵守 Pi 的分支语义。

## 试用

在仓库根目录运行：

```bash
pi --extension ./extensions/clm.ts
```

或以 Pi package 方式临时加载：

```bash
pi -e .
```

开始一项会产生几轮工具输出的任务。需要整理历史时，模型会按照系统提示编辑
`.pi/clm/LIVE_CTX_MAIN.md`；也可以直接使用 Pi 原生 `/compact` 完成手动压缩。扩展不会再发送一个额外的“compact LLM turn”。

## 命令

```text
/clm status
```

`/clm status` 显示 mirror 路径、字节数、可编辑/保护 block 数、preview/canonical 估算 token、Pi context usage、目标预算、shrink-only 策略和 branch 上已持久化的 context edit 数量。

扩展会在 session start、branch 切换和请求前自动刷新 mirror；没有 `/clm refresh`。直接在 agent turn 外修改 mirror 会在下一次同步时恢复为 canonical projection，避免未经校验的内容进入 session。

## 预算与生命周期

`CLM_CONTEXT_BUDGET` 是一个近似的目标预算，不是第二个 context window，也不会阻止已经过大的请求。接近目标时，扩展在 `context` hook 返回一条**临时** nudge，要求模型只做一次 mirror 编辑；该 nudge 不写入 session history。预算没有设置时，不发送 nudge。

超过 Pi 自身 context window 时，交给 Pi 原生 auto-compaction；需要手动整理时使用 Pi 原生 `/compact`。这避免在已经过大的完整上下文上再追加一次 `/clm-compact` LLM 请求。

```bash
CLM_CONTEXT_BUDGET=32000 pi --extension ./extensions/clm.ts
```

所有接受的 mirror 编辑都采用固定的 **shrink-only** 策略：按 Pi 的结构化估算，编辑后的上下文必须严格短于编辑前。没有可安全缩短的编辑会被拒绝。系统 prompt 等 mirror 之外的固定 token 会计入预算估算。

mirror 的显示上限是固定的：单 block 约 `12000` 字符，总 mirror 约 `96000` 字符；这些限制不再通过环境变量分叉配置。

token 计数使用共享格式层的 provider-independent `estimateMessageTokens(message)`，按消息分别估算。对当前 Pi 支持的 text、thinking、tool call、图片、system sections 和 tool declarations，它采用与 Pi host 一致的 `3.5 chars/token` 近似及 rounding；共享层不导入 Pi runtime，因此仍保留 DSH 的 `reasoning`、`tool-call`、`tool` 和其他自有消息形状的 fallback 估算。当前 Pi extension 的公开 `ExtensionContext` 只提供 effective system prompt，`fixedRequestTokens` 因此只计该 prompt；tool declaration overhead 只有在 host 传入结构化 system message 时才会被计入，否则必须视为 incomplete approximation。它不是 provider 的精确 tokenizer；Pi/DSH 自身的 context window 仍是最终约束。

生成的 `.pi/clm/LIVE_CTX_MAIN.md` 不属于发布包，也不应提交到 Git。

## DeepSeek Harness（DSH）适配

仓库同时提供一个最小 DSH/Cordis host bridge，契约依据官方
[`deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness/)（`master`）的 Cordis plugin、agent-loop、session projection 资料，并参考
[`dsh-ops`](https://github.com/T-Auto/dsh-ops) 的 Community v0.15 manifest 形态；它保留同一份
`src/context-format.ts` 镜像、解析、snapshot 和编辑规划实现：

- 社区插件发现入口是 [`dsh-plugin.json`](./dsh-plugin.json)，host entry 为构建后的 `dist/dsh/index.js`；官方 bundle 安装元数据位于 `package.json` 的 `dsh.bundle.patch` 和 [`cordis.patch.yml`](./cordis.patch.yml)。
- DSH 生命周期使用官方 Harness 的 Cordis `agent/created`、`agent/pre-step`、`session/event` 和 `systemPrompt.section()` 扩展点；session projection 仍由 DSH 提供，session log 仍是事实来源。
- DSH 会生成同一路径的 `.pi/clm/LIVE_CTX_MAIN.md`。合法的 shrink-only 编辑会写入 `.pi/clm/LIVE_CTX_MAIN.patch.json`，其中包含 snapshot、changed IDs、tool-call/result 配对处理和 replacement/omit 明细。
- 当前 bridge **不会**把 patch 静默写回 DSH session，也不宣称 DSH 已支持 Pi 的 branch-local `context_edit`。DSH 原生 context-edit API 尚未在本仓库的真实 runtime 中验证；需要另一个经过批准的 host policy 消费 patch，才能改变活动上下文。
- host entry 不复制 `dsh-ops` 的 Rust 工具、shell、PTC 或 TUI 矩阵，只做 live-context 适配。DSH 仅依赖 host 提供的 Cordis 生命周期，运行时不导入 Pi 的 coding-agent 包。

安装 DSH bundle 时，按官方 Harness 的 `plugin_manager install_bundle` 流程把本仓库目录（或 `npm pack` 产物）交给当前 profile；不要手写 profile 的 `package.json`、`dsh.profile` 或 `cordis.patch.yml`。本仓库没有在真实 DSH profile 中执行安装，因此这里不提供“已安装/已激活”的 runtime 声明。

本地检查 DSH bridge：

```bash
npm test
npm run check
npm run typecheck
npm pack --dry-run
```

`npm run build:dsh` 会从 `src/dsh-bridge.ts` 和共享格式层生成 `dist/`；`npm pack` 的 `prepack` 也会执行这一步。当前测试是 mock host 和契约/包检查，不等于真实 DSH CLI 的安装、HMR、bundle activation 或 provider 请求端到端验证。

DSH host bridge 可选读取 `CLM_MAX_BLOCK_CHARS`、`CLM_MAX_MIRROR_CHARS` 和 `CLM_CONTEXT_FIXED_TOKENS`；它们只影响 mirror preview 或 patch gate 的近似估算，不改变 DSH 的 context window。

## 设计边界

本项目刻意保留 Pi-native 的最小核心：projection → live mirror → `context_edit`；DSH 侧对应为 projection → live mirror → explicit patch proposal。它不实现独立的 agent runtime、rollback/retry harness、trajectory export、独立 receipt store 或 dsh-ops 的 Rust/Bash/PowerShell/PTC/TUI 工具矩阵；DSH 的 patch 文件只是明确的 host-policy 输入。Pi session JSONL 和 DSH session log 都仍是各自主机的事实来源；只有 Pi 侧的 context edit 当前具备已验证的 branch-local 持久化语义。

## 文档

- [工作原理](./docs/how-it-works.md)：说明 live context mirror、生命周期、编辑校验和限制。
- [CLM 技术分析表](./docs/CLM技术分析表.md)：整理 Context Language Models 论文、官方实现和工程取舍。

## 开发检查

```bash
npm test
npm run check
npm run typecheck
npm pack --dry-run
```

Pi 入口只依赖 Pi 在运行时提供的 host packages；DSH host entry 只依赖 DSH/Cordis 提供的公开生命周期对象。开发依赖用于类型检查和生成 `dist/`。发布白名单同时包含 `dsh-plugin.json`、`cordis.patch.yml`、`dsh/`、`dist/`、`locale/` 和 `icon.svg`，不包含本地 session 生成物或 `.pi/clm` patch/mirror 文件。
