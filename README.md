# oh-my-clm

可直接加载到 Pi 的精简 live-context 扩展，参考
[Facebook Research context-language-models](https://github.com/facebookresearch/context-language-models/tree/main/clm/clm_harness)
的“把当前上下文镜像到普通文件、由模型自行整理”思路。

**摘要**：扩展在 Pi 构建 projection 时把可编辑上下文镜像到 session 临时目录，由模型通过 `cleanup` 或同 call rewrite 整理；同一套核心实现同时服务 Pi 扩展与 DeepSeek Harness（DSH）/Cordis 插件。

**目录**

- [核心机制](#核心机制)
- [快速上手](#快速上手)
- [命令](#命令)
- [预算与生命周期](#预算与生命周期)
- [DSH 适配](#dsh-适配)
- [项目结构](#项目结构)
- [设计边界](#设计边界)
- [文档](#文档)
- [开发检查](#开发检查)
- [关键要点](#关键要点)

## 核心机制

Pi 为下一次请求构建当前 branch 的 projection 时，扩展会把可编辑部分镜像到当前 session 的临时目录：

```text
/tmp/clm-${sessionId}/LIVE_CTX_MAIN.md
```

`${sessionId}` 是运行时 session ID。多个 session 即使使用同一个工作目录，也不会共享或覆盖 mirror。旧版本生成的 `.pi/clm` 文件不会被自动迁移或删除。

### 模型如何整理历史

模型可以调用 Pi/DSH 都提供的 `cleanup({ blockIds: [...] })` 工具，按 editable block ID 删除 stale、重复或自指噪声。cleanup 在一次工具调用内完成 host-side 变更，不依赖完整 block body 或 `old_string`。需要缩短已有 block 时，rewrite 脚本要在同一个 host-side 工具调用内完成 read+write；普通 edit 只适用于完整且未截断的 body。DSH 会等触发文件编辑的 session event 发布完成后再应用 native replacement，所以脚本必须在工具返回前写完，不能在后台持续重写 mirror。

mirror 的结构如下：

```text
<!-- clm-v2 -->
<!-- CLM_SNAPSHOT ... -->

[[CLM_ENTRY id=1 role=assistant]]
这段旧内容可以被改写成一句更短的事实摘要。
[[/CLM_ENTRY id=1]]
```

### 编辑规则

- 只修改 block body；保留 `CLM_SNAPSHOT`、`CLM_ENTRY` 和 closing marker。
- `id` 是从 `1` 开始的可读编辑序号；不要改 ID，也不要重排 block。扩展内部仍用 Pi 的 opaque entry ID。
- 删除一个可编辑 block 会从后续 projection 中省略该消息；删除最后一个 block 时保留 `<!-- CLM_EMPTY -->`。
- 初始用户任务受到保护，不会出现在可编辑区域中；user-authored block 可以被省略，但不能被模型改写。
- mirror preview 有固定的单 block 和总大小上限；截断只影响显示，不改变 canonical source。
- `cleanup({ blockIds: [...] })` 按当前 1-based editable ID 删除 block；load-bearing block 1 始终保留，assistant/tool-result 配对也会整体处理。未知、重复、过期或协议损坏的 ID 会整体拒绝。
- 如果工具结果读取了 `LIVE_CTX_MAIN.md`，该结果会在未来 projection 中替换成短指针，避免 mirror 自我复制。
- 改写或删除 assistant tool turn 时，配对的 tool result 也会一起处理，避免孤立的 tool message。

### 索引与读取

DSH 的 runtime context 会包含当前可编辑 block 的 `<oh-my-clm-block-index>`，每条记录给出 cleanup 使用的 1-based ID、role 和短 preview。列表较长时只显示前 40 个可编辑 block，再加一段以会话中点为中心的 25 块窗口；没有 tail 或省略摘要，未列出的 ID 需要读 mirror。`cleanup` 的 tool result 也会返回刷新后的 index。所以清理时不需要为了确认 ID 或内容去读 `LIVE_CTX_MAIN.md`；只有需要完整、未截断的正文做 rewrite 时才读 mirror。

### 分支与持久化

合法修改在 `turn_end` 通过 Pi 原生 `context_edit` 持久化；原始 session JSONL 不会被改写。

由于 context edit 属于当前 branch，`/tree`、fork 和 session resume 继续遵守 Pi 的分支语义。

## 快速上手

在仓库根目录运行：

```bash
pi --extension ./extensions/clm.ts
```

或以 Pi package 方式临时加载：

```bash
pi -e .
```

开始一项会产生几轮工具输出的任务。需要整理历史时，模型可以按 block ID 调用 `cleanup({ blockIds: [...] })`，也可以按系统提示对 `/tmp/clm-${sessionId}/LIVE_CTX_MAIN.md` 做同 call 的 rewrite/edit；手动压缩直接使用 Pi 原生 `/compact`。扩展不额外发送 “compact LLM turn”。

## 命令

```text
/clm
/clm status
```

`/clm` 与 `/clm status` 等价，Pi 扩展和 DSH 插件都提供。

- **Pi 侧**显示 mirror 路径、字节数、可编辑/保护 block 数、preview/canonical 估算 token、Pi context usage、目标预算、shrink-only 策略和 branch 上已持久化的 context edit 数量。
- **DSH 侧**显示当前 session 的 mirror 路径、mirror 与 canonical projection 是否一致、字节数、可编辑/保护 block 数、preview/canonical token 估算、DSH surface 节点数、shrink-only 策略和 mirror 限制。命令只读，不修改 session、不写 mirror、不追加 session event，也不缓存状态，因此在第一次 bridge pass 之前也能给出准确结果。
- 两个宿主都不提供 `/clm refresh`。

扩展会在 session start、branch 切换和请求前自动刷新 mirror。在 agent turn 之外直接修改 mirror，会在下一次同步时被恢复为 canonical projection，避免未经校验的内容进入 session。

## 预算与生命周期

### 预算与 nudge

`CLM_CONTEXT_BUDGET` 是一个近似的目标预算，不是第二个 context window，也不会阻止已经过大的请求。接近目标时，扩展会在 `context` hook 返回一条临时 nudge，要求模型只做一次 mirror 编辑；该 nudge 不写入 session history。没有设置预算时不发送 nudge。

```bash
CLM_CONTEXT_BUDGET=32000 pi --extension ./extensions/clm.ts
```

超过 Pi 自身 context window 时，交给 Pi 原生 auto-compaction；需要手动整理时使用 Pi 原生 `/compact`。这避免在已经过大的完整上下文上再追加一次 `/clm-compact` LLM 请求。

### shrink-only 策略

所有接受的 mirror 编辑都采用固定的 shrink-only 策略：按 Pi 的结构化估算，编辑后的上下文必须严格短于编辑前。不能安全缩短上下文的编辑会被拒绝。系统 prompt 等 mirror 之外的固定 token 会计入预算估算。

### 显示上限

mirror 的显示上限是固定的：单 block 约 `12000` 字符，总 mirror 约 `96000` 字符。

### token 估算

token 计数使用共享格式层的 provider-independent `estimateMessageTokens(message)`，按消息分别估算。对当前 Pi 支持的 text、thinking、tool call、图片、system sections 和 tool declarations，它采用与 Pi host 一致的 `3.5 chars/token` 近似及 rounding。共享层不导入 Pi runtime，所以 DSH 的 `reasoning`、`tool-call`、`tool` 和其他自有消息形状仍走 fallback 估算。

当前 Pi extension 的公开 `ExtensionContext` 只提供 effective system prompt，`fixedRequestTokens` 因此只计该 prompt；tool declaration overhead 只有在 host 传入结构化 system message 时才会被计入，否则这个估算就不完整。它不是 provider 的精确 tokenizer；Pi/DSH 自身的 context window 仍是最终约束。

### mirror 文件位置与权限

生成的 `/tmp/clm-${sessionId}/LIVE_CTX_MAIN.md` 位于系统临时目录，不属于发布包，也不应提交到 Git。目录默认使用 `0700`，mirror 文件默认使用 `0600`；宿主仍负责临时文件清理和内容审计。

## DSH 适配

仓库同时提供一个最小 DSH/Cordis host bridge，契约依据官方
[`deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness/)（`master`）的 Cordis plugin、agent-loop、session projection 资料，并参考
[`dsh-ops`](https://github.com/T-Auto/dsh-ops) 的 Community v0.15 manifest 形态；它保留同一份
`src/features/live-context/context-format.ts` 镜像、解析、snapshot 和编辑规划实现。

### 契约与生命周期

- 社区插件发现入口是 [`dsh-plugin.json`](./dsh-plugin.json)，host entry 为构建后的 `dist/dsh/index.js`；官方 bundle 安装元数据位于 `package.json` 的 `dsh.bundle.patch` 和 [`cordis.patch.yml`](./cordis.patch.yml)。在 DSH 0.2.0-rc.2 中，实际生效的是 bundle 元数据；`dsh-plugin.json` 的 Community permissions 目前不应被描述为运行时强制隔离。
- DSH 生命周期使用官方 Harness 的 Cordis `agent/created`、`agent/pre-step`、`session/event`、`systemPrompt.section()`、`systemPrompt.context()` 和 `tools.register()` 扩展点；cleanup 直接对当前 session surface 执行按 ID 的 native replacement，不读取 mirror 文件。
- `systemPrompt.context()` 负责把 block index 放进模型可见的 runtime context；DSH 自己的 runtime-context snapshot 也会从 mirror records 中排除，避免 index 递归列出自身。
- 普通 mirror 编辑的 `session/event` 只排队 reconcile，实际 mutation 延迟到 `Session.append()` 发布完成、且 `step/start` 打开新 step 之后执行；`agent/pre-step` 只等待已排队的收敛，不执行 mutation。session projection 仍由 DSH 提供，session log 仍是事实来源。
- DSH 会按当前 session ID 生成 `/tmp/clm-${sessionId}/LIVE_CTX_MAIN.md`。DSH 文件工具可以直接编辑这个 host-side mirror；sandboxed bash 可能拥有不同的 `/tmp`，除非宿主显式共享该 session 目录。

### 编辑语义：与 Pi 的差异

bridge 会对 mirror 编辑执行与 Pi 侧相同的 snapshot、结构安全和 shrink-only 校验；合法编辑通过 DSH 原生 `Session.append()` 的 `surfaceOp: { op: "replace" }` seam 写入当前 session，处理后再把 mirror 重写为新的 canonical DSH projection。

当前 bridge 会改变 DSH active surface，这与 Pi 的 branch-local `context_edit` 不是一回事：cleanup 和普通编辑会追加 `tool/result` content replacement 或 `developer/message` replacement（omission 用空 content，assistant 改写用缩短后的文本），原始事件仍保留在 append-only session log 中，`deriveMessages()` 使用新的 surface。

DSH 明确禁止 `assistant/message` 携带 `sourceEventSeqs`，而每个 replacement 又必须引用所有被遮蔽的节点，所以 assistant block 不能原地替换成另一个 assistant message。改写后的文本以 developer 身份进入模型可见历史，不再归属原模型回复。

它不生成 proposal/receipt 文件，也不注册自定义 session event；reconcile 在事件回调之外串行执行，避免 `Session.append()` reentrant failure。所有 omission 和 assistant 改写都使用 append 时真正打开的 `turn`/`step`（正数），`tool/result` replacement 保持原 event envelope、只改 `content`，并带 `sourceEventSeqs: [targetSeq]`。

host entry 不复制 `dsh-ops` 的 Rust 工具、shell、PTC 或 TUI 矩阵，只做 live-context 适配。DSH 仅依赖 host 提供的 Cordis 生命周期，运行时不导入 Pi 的 coding-agent 包。

### 安装与打包

安装 DSH bundle 时，按官方 Harness 的插件管理流程把本仓库目录（或 `npm pack` 产物）交给当前 profile；不要手写 profile 的 `package.json`、`dsh.profile` 或 `cordis.patch.yml`。外部 E-012 报告验证了 DSH 0.2.0-rc.2 的安装、Cordis activation、system prompt 和真实 mirror/file-tool 路径；本地实现另外依据官方 Harness commit `1517a4dbca0a2789ff1d41ba439600f8547d23fa` 的 `Session.append()`/surface replacement 契约，通过 mock seam 回归测试验证 active-surface mutation。

如果要交给 DSH 插件管理器安装，使用专门的 DSH 打包脚本：

```bash
npm run build:dsh:plugin
# 默认输出：artifacts/oh-my-clm-<version>.tgz

# 也可以指定输出目录或具体文件
node scripts/build-dsh-plugin.mjs ./out
node scripts/build-dsh-plugin.mjs --output ./out/oh-my-clm.tgz
```

这个脚本会先编译并检查 host entry，再生成只包含 DSH host、运行时 `dist`、manifest、bundle patch、locale、icon 的 npm tgz；Pi extension、TypeScript 源码、测试文件和开发依赖不会进入该专用包。`@deepseek-ai/dsh-tools` 仅作为可选 peer 声明用于兼容性检查，不产生运行时依赖，也不得改回 `dependencies`（原因见 [changelog.md](./changelog.md) 的 0.1.1 说明）。普通 `npm pack` 仍用于构建同时包含 Pi 与 DSH 内容的完整包。

`npm run build:dsh` 会从 `src/features/live-context/dsh-bridge.ts` 和共享格式层生成 `dist/`；`npm pack` 的 `prepack` 也会执行这一步。仓库测试主要是 mock host 和契约/包检查；外部 DSH 验证报告另外覆盖了真实 CLI 安装、bundle activation、system prompt 和 mirror/file-tool 生成。DSH 文件工具运行在宿主侧时可以访问 `/tmp/clm-*`；sandbox 内的 bash 不一定共享同一个 `/tmp`，应按提示使用文件工具编辑 mirror。`Session.append()` 的 replacement 会走正常 `session/event` 发布路径；需要立即验证后端崩溃持久性的部署应由宿主使用官方 `session/flush` 检查点，插件本身不猜测或注册额外的 flush API。

### 配置项

DSH host bridge 可选读取 `CLM_MAX_BLOCK_CHARS`、`CLM_MAX_MIRROR_CHARS` 和 `CLM_CONTEXT_FIXED_TOKENS`；它们只影响 mirror preview 或 shrink-only safety gate 的近似估算，不改变 DSH 的 context window。`CLM_CLEANUP_RESULT` 控制 cleanup 工具结果的拷贝量：默认 `compact` 只返回一行确认（刷新后的 block index 会在下一次索引刷新后出现），`full` 会在结果后附带刷新后的索引，`none` 则不产生结果文本；它只影响模型可见的结果，不改变工具调用记录本身。

Block index 另有三个尺寸开关和一个节流开关：`CLM_INDEX_PREVIEW`（默认 64，单块 preview 字符数）、`CLM_INDEX_HEAD`（默认 40）、`CLM_INDEX_MIDDLE`（默认 25，中点窗口大小）、`CLM_INDEX_REFRESH_STEPS`（默认 4，同一个 turn 内最多每几步重渲染一次）。索引列两段：前 40 个可编辑 block，再加一段以会话中点为中心的 25 块窗口（200 块时是 88–112）。head 与窗口之间、窗口之后的 block 都不列出，也没有 tail 或省略摘要；那些 ID 需要读 mirror。窗口会整体前移以避免和 head 重叠，也会在末尾收边，因此短会话里它会紧接在 head 后面。DSH 只在 runtime-context 快照文本变化时追加新快照，因此节流能减少每步重复注入；`cleanup` 或 mirror edit 生效后会立即失效并重渲染，设为 `1` 可恢复每步刷新。

## 项目结构

代码按 `shared → feature → host adapter` 单向依赖组织，入口路径保持宿主约定不变：

```text
src/lib/                       共享基础设施：mirror 文件写入、路径解析
src/features/live-context/     业务领域：mirror 协议、cleanup、DSH surface bridge
extensions/clm.ts              Pi host adapter
dsh/index.ts                   DSH/Cordis host adapter
test/{lib,features,adapters,package,harness}
```

`src/lib` 不导入 feature，feature 之间不互相导入，feature 不导入 host adapter，也不使用 barrel 文件。`npm run check` 会运行 `scripts/check-boundaries.mjs` 验证这些规则；完整的目录职责、新增文件放置规则和测试布局见 [docs/project-structure.md](./docs/project-structure.md)。

## 设计边界

本项目刻意保留 Pi-native 的最小核心：projection → live mirror → `context_edit`；DSH 侧对应为 projection → live mirror → snapshot/safety/shrink validation → `Session.append()` surface replacement。它不实现独立的 agent runtime、rollback/retry harness、trajectory export、receipt store 或 dsh-ops 的 Rust/Bash/PowerShell/PTC/TUI 工具矩阵；DSH bridge 只使用宿主已拥有的 session mutation owner，不猜测 Cordis Service/Event，也不声称 Pi 的 branch-local 语义。Pi session JSONL 和 DSH session log 都仍是各自主机的事实来源；两条路径的原始日志都保留，只有当前 surface/projection 被替换。

## 文档

版本更新说明（0.1.0–0.1.6）已移至 [changelog.md](./changelog.md)。

- [工作原理](./docs/how-it-works.md)：说明 live context mirror、生命周期、编辑校验和限制。
- [项目结构](./docs/project-structure.md)：说明分层目录、单向依赖规则、测试布局和边界检查。
- [CLM 技术分析表](./docs/CLM技术分析表.md)：整理 Context Language Models 论文、官方实现和工程取舍。
- [DSH 证据与 harness](./docs/reports/README.md)：mock host harness 的运行方式和历史验证报告。
- [DSH 缓存机制](./docs/dsh-cache-explained.md)：整理服务端前缀 KV 缓存、dsh 侧架构对齐和逐请求命中率可观测性。
- [更新日志](./changelog.md)：0.1.0–0.1.6 各版本的修复与调整说明。

## 开发检查

本地检查（包括 DSH bridge）：

```bash
npm test
npm run check
npm run typecheck
npm pack --dry-run
```

Pi 入口只依赖 Pi 在运行时提供的 host packages；DSH host entry 只依赖 DSH/Cordis 提供的公开生命周期对象。开发依赖用于类型检查和生成 `dist/`。发布白名单包含 `dsh-plugin.json`、`cordis.patch.yml`、`extensions/clm.ts`、`src/lib/`、`src/features/live-context/`、`dsh/`、`dist/`、`locale/` 和 `icon.svg`，不包含本地 session 生成物、`artifacts/` 打包输出或 `/tmp/clm-*` mirror 文件。

## 关键要点

- 整理历史时先按 1-based block ID 调 `cleanup`；只有 rewrite 需要完整、未截断的正文时才读 mirror。
- 所有被接受的 mirror 编辑都必须严格缩短上下文；不能安全缩短的编辑会被拒绝。
- Pi 走 branch-local `context_edit`，DSH 走 `Session.append()` surface replacement；两者的持久化语义不同。
- 超过宿主 context window 时交给 Pi 原生 auto-compaction 或 `/compact`，扩展不再追加一次 LLM 请求。
- 发布走两条通道：`npm pack` 生成 Pi+DSH 完整包，`npm run build:dsh:plugin` 生成 DSH 专用包。
