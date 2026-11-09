# oh-my-clm

可直接加载到 Pi 的精简 live-context 扩展，参考
[Facebook Research context-language-models](https://github.com/facebookresearch/context-language-models/tree/main/clm/clm_harness)
的“把当前上下文镜像到普通文件、由模型自行整理”思路。

**摘要**：扩展在 Pi 构建 projection 时把可编辑上下文镜像到 session 临时目录，由模型通过 `cleanup` 或同 call rewrite 整理；同一套核心实现同时服务 Pi 扩展与 DeepSeek Harness（DSH）/Cordis 插件。

**目录**

- [核心机制](#核心机制)
- [安装](#安装)
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
- body 里如果需要出现 `[[CLM_ENTRY ...]]`、`[[/CLM_ENTRY ...]]`、`<!-- CLM_EMPTY -->`、`CLM_SNAPSHOT` 或 `clm-v2` 这样的字面行，保留它前面的一个反斜杠 `\`：这是转义，去掉后该行会变成协议结构。
- `id` 是从 `1` 开始的可读编辑序号；不要改 ID，也不要重排 block。扩展内部仍用 Pi 的 opaque entry ID。
- 删除一个可编辑 block 会从后续 projection 中省略该消息；删除最后一个 block 时保留 `<!-- CLM_EMPTY -->`。
- 初始用户任务在无 compaction 时受保护，不会出现在可编辑区域中；出现 compaction summary 后 protected 前缀被释放，但首个可编辑 block（load-bearing block 1）在两条删除路径上始终保留，初始任务因此仍不会被删除。user-authored block 可以被省略，但不能被模型改写。
- Pi 侧的 mirror preview 有固定的单 block 和总大小上限；DSH 默认相同，但可用 `CLM_MAX_BLOCK_CHARS` / `CLM_MAX_MIRROR_CHARS` 覆盖。截断只影响显示，canonical source 始终完整；但**改写截断块会被拒绝**——否则 head+tail 截断副本会成为新的 canonical 正文，中间未显示内容永久丢失。只能省略该 block 或用 `cleanup`。
- `cleanup({ blockIds: [...] })` 按当前 1-based editable ID 删除 block；load-bearing block 1 在 `cleanup` 与 mirror 编辑两条路径上共享 `loadBearingRecord()` 守卫、始终保留，assistant/tool-result 配对也会整体处理。未知、重复、过期或协议损坏的 ID 会整体拒绝。
- 如果工具结果读取了 `LIVE_CTX_MAIN.md`，该结果会在未来 projection 中替换成短指针，避免 mirror 自我复制。
- 改写或删除 assistant tool turn 时，配对的 tool result 也会一起处理，避免孤立的 tool message。

### 索引与读取

DSH 的 runtime context 会包含 `<oh-my-clm-block-index>`，有两种模式（`CLM_INDEX_MODE`）：

- `digest`（默认）：每个已完成的 turn 一行，给出包含式 ID 区间、块数、估算 token 成本和该 turn 的第一条 user 消息；正在进行的 turn 只给稳定的起始锚点（`IDs N..`），不列出。正常追加时文本在一个 turn 内不变，DSH 只在 turn 边界追加一条快照，而不是每步一条；`cleanup`、mirror edit 或 compaction 会清空缓存并在同一 turn 内重渲染（见下文 DSH 配置项）。
- `blocks`（`CLM_INDEX_MODE=blocks`）：逐个列出可编辑 block，给出 cleanup 使用的 1-based ID、role 和短 preview。列表较长时显示前 12 个可编辑 block（“别动”锚点）加**最近 40 个**；两者之间的每个连续区间都用一行 `... N editable block(s) omitted (IDs A-B).` 标出，所以 ID 跳段不会被误读成空洞。

每个 DSH 快照的头部还有一行用量，命中触发条件时索引末尾追加一条清理候选：

- 用量行形如 `Usage: 12.3k/128k tokens (9.6%) · 18 editable blocks · last cleanup at turn 4`。token 数优先取宿主精确值：`sessionProjections` 的 `contextPressure.projectedTokens`（下一次请求的 prompt 估算价），缺失时退到同一投影的 `pressureTokens`（最近一次请求的 prompt 大小）。**不要用 `tokenUsage` 的 `cacheReadTokens + uncachedInputTokens`**——那是整段会话的累计计费账（DSH 文档原文 "durable cumulative provider usage for a complete session log"），跑几轮就会超过窗口，拿它当水位会让每次 cleanup 都显得不安全；取不到时显示 `~` 估算，窗口也不可知时写 `window unknown`，不会把估算冒充精确值（P1-2）。
- 命中任一触发阈值时，`<oh-my-clm-block-index>` 末尾给出可直接确认的候选：`Suggested cleanup (usage 80% ≥ 70%): cleanup({ ranges: ["3-5"], skipRoles: ["user"] }) frees ~120 tok.`，随后一行列出每个区间的预计节省与陈旧度。候选带上已有的 `skipRoles: ["user"]`：turn 以 user 块开头，裸区间会连人类请求一起删掉，而引用的节省数字已经扣除了被保留的 user 块。候选只取**已完成的 turn**，永不包含 block 1 和当前 turn；模型只需要确认或改范围，不必自己判断何时清理。
- 用量行与候选按 **turn 边界** 计算并缓存，同一 turn 内逐字节不变，不会每步追加一份快照；`cleanup` 或 mirror edit 生效后清空缓存（删除会重排 ID），compaction 由宿主适配器清空。
- 所有触发阈值默认关闭（`0`），因为尚未在真实 DeepSeek-V4.1-Flash 会话上标定；打开方式见下文 `CLM_TRIGGER_*`。

`cleanup` 接受 `ranges: ["3-16"]`（包含式区间）或 `blockIds: [...]`（单块），还可以用 `skipRoles: ["user"]` 在一个 turn 区间里保留人类消息。不确定是否还需要某个 block 时用 `cleanup({ offload: [{ blockId, note }] })`：保留 ID / role / 位置，正文换成一行严格更短的 `[offloaded: <note>]`，要点由模型自己写（插件不引入第二个 summarizer）；`offload` 可与删除混用，block 1、user 块和会变长的占位都会被拒绝。配对级联删除（assistant tool call 与结果）会单独报告为 `paired`，不会混进你请求的 ID。显式单块 ID 仍然严格校验，range 越界会夹取，range 覆盖 block 1 时保留 block 1。`cleanup({ list: "3-16" })` 是只读的展开：返回该区间的行（role + 短 preview），不做任何删除，因此“索引只给了省略行、但我想先看清楚”不需要读整个 mirror；它不能和删除目标同时出现。只有需要完整、未截断的正文做 rewrite 时才需要读 mirror。

### 分支与持久化

合法修改在 `turn_end` 通过 Pi 原生 `context_edit` 持久化；原始 session JSONL 不会被改写。

由于 context edit 属于当前 branch，`/tree`、fork 和 session resume 继续遵守 Pi 的分支语义。

## 安装

npm 主包同时包含 Pi extension 和 DSH/Cordis bundle，两种宿主都可以从 npm 或 GitHub 安装。npm 页面：<https://www.npmjs.com/package/oh-my-clm>；源码仓库：<https://github.com/DevZjQx/oh-my-clm>。

### Pi

```bash
# 从 npm 安装，写入 ~/.pi/agent/settings.json
pi install npm:oh-my-clm

# 从 GitHub 安装
pi install git:github.com/DevZjQx/oh-my-clm
```

加 `--local`（或 `-l`）可写入当前项目的 `.pi/settings.json`。只试用一次、不修改 settings：

```bash
pi -e npm:oh-my-clm
pi -e git:github.com/DevZjQx/oh-my-clm
```

`pi list` 查看已安装的包，`pi update --extensions` 同步更新，`pi remove <source>` 卸载。安装或更新后重新启动 Pi 即可加载。

### DSH

`dsh plugin` 是 DSH 包管理器的入口，安装时指定目标 profile：

```bash
# 从 npm 安装
dsh plugin --profile <profile> add oh-my-clm

# 从 GitHub 安装
dsh plugin --profile <profile> add github:DevZjQx/oh-my-clm
```

把 `<profile>` 换成实际使用的 profile，例如 `web` 或 `tui`。安装后重启该 profile 即可加载：

```bash
dsh --profile <profile>
```

卸载：

```bash
dsh plugin --profile <profile> remove oh-my-clm
```

需要固定版本时，npm 源在包名后加 `@<version>`（例如 `oh-my-clm@0.1.16`），GitHub 源在仓库后加 `#<ref>`（例如 `github:DevZjQx/oh-my-clm#<commit-sha>`）。DSH 不读取 `pi` 设置，Pi 的安装也不会自动把插件加入任何 DSH profile。

## 快速上手

从源码运行，在仓库根目录执行：

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
/clm mode [blocks|digest|auto]   # 仅 DSH
```

`/clm` 与 `/clm status` 等价，Pi 扩展和 DSH 插件都提供。DSH 另有 `/clm mode`：不带参数显示当前模式，带 `blocks` / `digest` 则在当前进程里切换索引形状并清空缓存的索引文本，从下一步开始生效，直到进程重启；`auto` 撤销进程级覆盖、回到 `CLM_INDEX_MODE`（默认 `digest`）。这是进程级覆盖：切换会影响当前进程中的所有 session。进程环境只在启动时读取一次，所以这是不重启就做 A/B 验证的方式；要跨重启保持，使用 `CLM_INDEX_MODE`。

- **Pi 侧**显示 mirror 路径、字节数、可编辑/保护 block 数、preview/canonical 估算 token、Pi context usage、目标预算、shrink-only 策略和 branch 上已持久化的 context edit 数量。
- **DSH 侧**显示当前 session 的 mirror 路径、mirror 与 canonical projection 是否一致、字节数、可编辑/保护 block 数、preview/canonical token 估算、DSH surface 节点数、shrink-only 策略和 mirror 限制。命令只读，不修改 session、不写 mirror、不追加 session event，也不缓存状态，因此在第一次 bridge pass 之前也能给出准确结果。
- 两个宿主都不提供 `/clm refresh`。

扩展会在 session start 和请求前自动刷新 mirror；branch 切换只标记待刷新，真正的刷新发生在下一次 `context` hook 的 `syncMirror`。在 agent turn 之外直接修改 mirror，会在下一次同步时被恢复为 canonical projection，避免未经校验的内容进入 session。

## 预算与生命周期

### 预算与 nudge

`CLM_CONTEXT_BUDGET` 是一个近似的目标预算，不是第二个 context window，也不会阻止已经过大的请求。未设置时预算默认取宿主窗口（`ctx.getContextUsage().contextWindow`）；当用量达到约 `0.75 × max(1, budget - 2048)` 时，扩展在**同一次请求**里追加一条临时 `system` 行（不占单独回合、不要求停手），内容是 §5.2 的用量行 + 可直接确认的 `cleanup({ ranges, skipRoles: ["user"] })` 候选；没有候选时提示做一次 `cleanup` 或一次 mirror 编辑。该行不写入 session history，`I-2` 的停止条件（连续两轮无进展即中止、轮数上限、压力消失后重置）仍在 state 里。设了 `CLM_CONTEXT_BUDGET` 时，用量行和百分比都以该预算为分母（与触发判定一致），而不是宿主窗口。

```bash
CLM_CONTEXT_BUDGET=32000 pi --extension ./extensions/clm.ts
```

超过 Pi 自身 context window 时，交给 Pi 原生 auto-compaction；需要手动整理时使用 Pi 原生 `/compact`。这避免在已经过大的完整上下文上再追加一次 `/clm-compact` LLM 请求。

### shrink-only 策略

所有接受的 mirror 编辑都采用固定的 shrink-only 策略：按 Pi 的结构化估算，编辑后的上下文必须严格短于编辑前。不能安全缩短上下文的编辑会被拒绝。系统 prompt 等 mirror 之外的固定 token 会计入预算估算。

### 显示上限

Pi 侧的 mirror 显示上限是固定的：单 block 约 `12000` 字符，总 mirror 约 `96000` 字符。DSH 默认使用相同值，但可用 `CLM_MAX_BLOCK_CHARS` / `CLM_MAX_MIRROR_CHARS` 覆盖。

### token 估算

token 计数使用共享格式层的 provider-independent `estimateMessageTokens(message)`，按消息分别估算。对当前 Pi 支持的 text、thinking、tool call、图片、system sections 和 tool declarations，ASCII 文本沿用与 Pi host 一致的 `3.5 chars/token` 近似及按消息 rounding；非 ASCII 字符（CJK、emoji 等）按约 1 token/字符加权，assistant 的字符串正文也按正文计入（此前计 0）。共享层不导入 Pi runtime，但会显式处理 DSH 的 `reasoning`、`tool-call`、`tool` 等形状；只有未识别的其他自有消息形状才走 fallback 估算。

当前 Pi extension 的公开 `ExtensionContext` 只提供 effective system prompt，`fixedRequestTokens` 因此只计该 prompt；tool declaration overhead 只有在 host 传入结构化 system message 时才会被计入，否则这个估算就不完整。**它不是 provider 的精确 tokenizer**：加权只保证"换语种导致真实 token 增长"不再被误判为收缩；估算只用于编辑前后的有符号 delta，`beforeTokens` 与硬上限改取宿主精确用量（Pi `ctx.getContextUsage()`；DSH 走免 inject 的 `ctx.get("sessionProjections")` 取 `contextPressure` 的 `projectedTokens` / `pressureTokens` 与窗口，见 [dsh-surface-bridge.md](./docs/features/dsh-surface-bridge.md) §1）。校准后编辑用量仍高于窗口 95% 时拒绝（`HOST_CAP_HEADROOM`，待真实 V4.1-Flash 会话标定）；宿主用量取不到时 status 显式标 `~`，不静默当作精确值。宿主数字超过自己声明的窗口时视为口径错误（单次请求不可能超窗）而退回估算；基线本身已占满窗口时，任何 cleanup 都到不了水位，此时放行严格收缩并给 warning，避免门控死锁。

### mirror 文件位置与权限

生成的 `/tmp/clm-${sessionId}/LIVE_CTX_MAIN.md` 位于系统临时目录，不属于发布包，也不应提交到 Git。目录默认使用 `0700`，mirror 文件默认使用 `0600`；宿主仍负责临时文件清理和内容审计。

## DSH 适配

仓库同时提供一个最小 DSH/Cordis host bridge，契约依据官方
[`deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness/)（`master`）的 Cordis plugin、agent-loop、session projection 资料，并参考
[`dsh-ops`](https://github.com/T-Auto/dsh-ops) 的 Community v0.15 manifest 形态；它保留同一份
`src/features/live-context/context-format.ts` 镜像、解析、snapshot 和编辑规划实现。

### 契约与生命周期

- 社区插件发现入口是 [`dsh-plugin.json`](https://github.com/DevZjQx/oh-my-clm/blob/main/dsh-plugin.json)，host entry 为构建后的 `dist/dsh/index.js`；官方 bundle 安装元数据位于 `package.json` 的 `dsh.bundle.patch` 和 [`cordis.patch.yml`](https://github.com/DevZjQx/oh-my-clm/blob/main/cordis.patch.yml)。在 DSH 0.2.0-rc.2 与 0.2.2-rc.1 中，实际生效的都是 bundle 元数据；`dsh-plugin.json` 的 Community permissions 按真实写入位置声明为 `host-temp`（`/tmp/clm-<session>/`），它描述位置而不是 workspace 边界，也不提供运行时强制隔离。
- DSH 生命周期使用官方 Harness 的 Cordis `agent/created`、`agent/pre-step`、`session/event`、`systemPrompt.section()`、`systemPrompt.context()` 和 `tools.register()` 扩展点；cleanup 直接对当前 session surface 执行按 ID 的 native replacement，不读取 mirror 文件。
- `systemPrompt.context()` 负责把 block index 放进模型可见的 runtime context；DSH 自己的 runtime-context snapshot 也会从 mirror records 中排除，避免 index 递归列出自身。
- 普通 mirror 编辑的 `session/event` 只排队 reconcile；当编辑由 `tool/result` 或 `user/message` 触发时，mutation 在该事件的 `Session.append()` 发布完成后、当前仍打开的 step 内执行。`agent/pre-step` 不执行 mutation；它只在 session 仍有 open turn/step 时等待已排队的收敛，否则直接返回，把待处理编辑留给随后的 `step/start`。session projection 仍由 DSH 提供，session log 仍是事实来源。
- DSH 会按当前 session ID 生成 `/tmp/clm-${sessionId}/LIVE_CTX_MAIN.md`。系统提示给出 mirror 路径模板并说明可编辑（用于压缩），但删除操作明确指向 `cleanup`；runtime context 还会在 block index 上方给出一行 `Mirror:`，写的是当前 session 的具体路径——系统提示段是进程级静态文本，无法填 `<session-id>`。sandboxed bash 可能拥有不同的 `/tmp`，除非宿主显式共享该 session 目录。

### 编辑语义：与 Pi 的差异

bridge 会对 mirror 编辑执行与 Pi 侧相同的 snapshot、结构安全和 shrink-only 校验；合法编辑通过 DSH 原生 `Session.append()` 的 `surfaceOp: { op: "replace" }` seam 写入当前 session，处理后再把 mirror 重写为新的 canonical DSH projection。

当前 bridge 会改变 DSH active surface，这与 Pi 的 branch-local `context_edit` 不是一回事：cleanup 的删除是 `replacement: null`，因此只追加空 `developer/message` omission；`offload` 与普通 mirror 编辑则在改写 tool result 时追加 `tool/result` content replacement，在改写/删除 assistant 时追加 `developer/message`（改写用缩短后的文本，删除用空 content）。原始事件仍保留在 append-only session log 中，`deriveMessages()` 使用新的 surface。

DSH 明确禁止 `assistant/message` 携带 `sourceEventSeqs`，而每个 replacement 又必须引用所有被遮蔽的节点，所以 assistant block 不能原地替换成另一个 assistant message。改写后的文本以 developer 身份进入模型可见历史，不再归属原模型回复；其 `source.kind` 由规划器来源派生（`oh-my-clm:model-mirror-edit` / `oh-my-clm:runtime-cleanup`），不再标记为 `user`。

写入时溯源：`ContextEditDraft.provenance` 由规划器写入（`model-mirror-edit` / `runtime-cleanup`），不从正文解析，并在 DSH 写边界映射为 `developer/message` 的 `source.kind`，因此持久化事件能区分是哪条规划路径产生了这次编辑；mirror body 中出现 `[oh-my-clm ... source=/owner=/trusted=/provenance=]` 之类的保留来源声明会被整体拒绝。Pi 侧运行时通知和 budget nudge 改为 `system` 角色消息，不冒充合成 `user` 消息。系统提示、安全策略和 block index 从不进入可编辑 mirror，模型可改区只放历史正文。这里的正文黑名单只拦显式保留字，不等于对任意注入指令做内容审计；仍缺审批/签名、编辑 diff/审计与最小回滚（见"设计边界"）。

它不生成 proposal/receipt 文件，也不注册自定义 session event；reconcile 在事件回调之外串行执行，避免 `Session.append()` reentrant failure。所有 omission 和 assistant 改写都使用 append 时真正打开的 `turn`/`step`（正数），`tool/result` replacement 保持原 event envelope、只改 `content`，并带 `sourceEventSeqs: [targetSeq]`。

host entry 不复制 `dsh-ops` 的 Rust 工具、shell、PTC 或 TUI 矩阵，只做 live-context 适配。DSH 仅依赖 host 提供的 Cordis 生命周期，运行时不导入 Pi 的 coding-agent 包。

### 安装与打包

安装 DSH bundle 时，按官方 Harness 的插件管理流程把本仓库目录（或 `npm pack` 产物）交给当前 profile；不要手写 profile 的 `package.json`、`dsh.profile` 或 `cordis.patch.yml`。外部 E-012 报告验证了 DSH 0.2.0-rc.2 的安装、Cordis activation、system prompt 和真实 mirror/file-tool 路径；本地实现另外依据官方 Harness commit `1517a4dbca0a2789ff1d41ba439600f8547d23fa` 的 `Session.append()`/surface replacement 契约，通过 mock seam 回归测试验证 active-surface mutation。该契约已对照上游 `@deepseek-ai/dsh` 0.2.2-rc.1（harness master `fcc0ad46`）复核：`Session.append()`、`surfaceOp`、`sourceEventSeqs` 与 `source.kind` 校验规则均未变化；E-012 报告与上述 commit 仍作为最初实现时的历史依据保留。本地 `@deepseek-ai/dsh-llm` 类型把 `MessageSourceMap` 定义为 merge-extensible（各生产者自定义 `kind`、消费者对未知 kind fall through），这是插件自定义 `source.kind` 的依据；但这两个 kind 在真实 DSH profile 上的接受度仍需发版前复核（§2 I-5）。

如果要交给 DSH 插件管理器安装，使用专门的 DSH 打包脚本：

```bash
npm run build:dsh:plugin
# 默认输出：artifacts/oh-my-clm-<version>.tgz

# 也可以指定输出目录或具体文件
node scripts/build-dsh-plugin.mjs ./out
node scripts/build-dsh-plugin.mjs --output ./out/oh-my-clm.tgz
```

这个脚本会先编译并检查 host entry，再生成只包含 DSH host、运行时 `dist`、manifest、bundle patch、locale、icon 的 npm tgz；Pi extension、TypeScript 源码、测试文件和开发依赖不会进入该专用包。`@deepseek-ai/dsh-tools` 仅作为可选 peer 声明用于兼容性检查，不产生运行时依赖，也不得改回 `dependencies`（原因见 [changelog.md](https://github.com/DevZjQx/oh-my-clm/blob/main/changelog.md)）。普通 `npm pack` 仍用于构建同时包含 Pi 与 DSH 内容的完整包。

`npm run build:dsh` 会从 `src/features/live-context/dsh-bridge.ts` 和共享格式层生成 `dist/`；`npm pack` 的 `prepack` 也会执行这一步。仓库测试主要是 mock host 和契约/包检查；外部 DSH 验证报告另外覆盖了真实 CLI 安装、bundle activation、system prompt 和 mirror/file-tool 生成。DSH 文件工具运行在宿主侧时可以访问 `/tmp/clm-*`；sandbox 内的 bash 不一定共享同一个 `/tmp`，因此 mirror 相关操作应以文件工具或 `cleanup` 为准，不要假设两个 `/tmp` 是同一个。`Session.append()` 的 replacement 会走正常 `session/event` 发布路径；需要立即验证后端崩溃持久性的部署应由宿主使用官方 `session/flush` 检查点，插件本身不猜测或注册额外的 flush API。

### 配置项

DSH host bridge 可选读取 `CLM_MAX_BLOCK_CHARS`、`CLM_MAX_MIRROR_CHARS` 和 `CLM_CONTEXT_FIXED_TOKENS`；它们只影响 mirror preview 或 shrink-only safety gate 的近似估算，不改变 DSH 的 context window。`CLM_CLEANUP_RESULT` 只在 DSH host bridge 中读取（Pi 侧固定为 `compact` 语义）：默认 `compact` 只返回一行确认（刷新后的 block index 会在下一次索引刷新后出现），`full` 会在结果后附带刷新后的索引，`none` 只抑制成功确认，`rejected` 与 `listed` 始终可见（被拒绝的 cleanup 必须把可行动的 reason 交给模型）；`cleanup({ list: "A-B" })` 的只读 listing 在任何 copy 模式下都返回行内容。它只影响模型可见的结果，不改变工具调用记录本身。

Block index 的模式与尺寸开关：`CLM_INDEX_MODE`（`digest` 默认 / `blocks`）、`CLM_INDEX_PREVIEW`（默认 64，preview 字符数）、`CLM_INDEX_HEAD`（默认 12）、`CLM_INDEX_TAIL`（默认 40，尾部窗口宽度；旧名 `CLM_INDEX_MIDDLE` 仍作为回退别名读取）、`CLM_INDEX_LINES`（digest 模式最多列出多少个 turn，默认 40）、`CLM_INDEX_REFRESH_STEPS`（默认 4，同一个 turn 内最多每几步重渲染一次）。

`blocks` 模式列两段：前 12 个可编辑 block（开头任务的“别动”锚点）加最近 40 个；中间的连续区间用省略行标出。预算偏向最近内容，因为那里的 stale tool 噪声才是清理目标，而开头几轮通常要保留。`digest` 模式每个已完成 turn 一行，正在进行的 turn 只有锚点，所以文本天然在一个 turn 内稳定；被折叠的 turn 会额外给一行 `... largest omitted turns: A-B (x tok), ...`，直接指出回收窗口最大、却不在列表里的区间。

DSH 只在 runtime-context 快照文本变化时追加新快照，因此节流能减少重复注入；`cleanup` 或 mirror edit 生效后会立即失效并重渲染，设为 `1` 可恢复每步刷新。节流按“打开中的 turn + 已关闭 step 数”计数：DSH 在 `agent/pre-step` 渲染索引，此时下一步的 `step/start` 还没写入，旧的 turn/step 键因此从未命中（E-027）。

清理触发开关（默认全部关闭，尚未在真实 V4.1-Flash 会话标定，见 [`docs/plan.md`](./docs/plan.md) §5.2）：`CLM_TRIGGER_PCT`（用量达到窗口的百分比）、`CLM_TRIGGER_TURNS`（已完成 turn 数）、`CLM_TRIGGER_TOOL_RATIO`（toolResult 占可编辑 token 的百分比）、`CLM_TRIGGER_SINCE`（距上次成功清理的 turn 数）、`CLM_TRIGGER_CANDIDATES`（每次最多候选数，默认 3）、`CLM_TRIGGER_MIN_TOKENS`（最小可省 token）、`CLM_CONTEXT_WINDOW`（宿主不提供窗口时的兜底窗口）。任一命中即在该 turn 边界装配一次候选；未命中时只有用量行。

用 `node scripts/measure-session-index.mjs --project .` 可以从真实 session 日志核对索引快照数、字节数、步间隔和 cleanup 调用形态；它同时给出 `blocks` 与 `digest` 的对比，以及 digest 的预测重渲染次数。

DSH 生命周期、surface replacement 语义、打包和验证边界的完整说明见 [docs/features/dsh-surface-bridge.md](https://github.com/DevZjQx/oh-my-clm/blob/main/docs/features/dsh-surface-bridge.md)；cleanup 参数和 block index 见 [docs/features/cleanup-tool.md](https://github.com/DevZjQx/oh-my-clm/blob/main/docs/features/cleanup-tool.md)。

## 项目结构

代码按 `shared → feature → host adapter` 单向依赖组织，入口路径保持宿主约定不变：

```text
src/lib/                       共享基础设施：mirror 文件写入、路径解析
src/features/live-context/     业务领域：mirror 协议、cleanup、DSH surface bridge
extensions/clm.ts              Pi host adapter
dsh/index.ts                   DSH/Cordis host adapter
test/{lib,features,adapters,package,harness}
```

`src/lib` 不导入 feature，feature 之间不互相导入，feature 不导入 host adapter，也不使用 barrel 文件。`npm run check` 会运行 `scripts/check-boundaries.mjs` 验证这些规则；完整的目录职责、新增文件放置规则和测试布局见 [docs/project-structure.md](https://github.com/DevZjQx/oh-my-clm/blob/main/docs/project-structure.md)。

## 设计边界

本项目刻意保留 Pi-native 的最小核心：projection → live mirror → `context_edit`；DSH 侧对应为 projection → live mirror → snapshot/safety/shrink validation → `Session.append()` surface replacement。它不实现独立的 agent runtime、rollback/retry harness、trajectory export、receipt store 或 dsh-ops 的 Rust/Bash/PowerShell/PTC/TUI 工具矩阵；DSH bridge 只使用宿主已拥有的 session mutation owner，不猜测 Cordis Service/Event，也不声称 Pi 的 branch-local 语义。Pi session JSONL 和 DSH session log 都仍是各自主机的事实来源；两条路径的原始日志都保留，只有当前 surface/projection 被替换。

## 文档

功能文档：

- [Live context mirror](https://github.com/DevZjQx/oh-my-clm/blob/main/docs/features/live-context-mirror.md)：Pi 侧 mirror 生命周期、文件协议、snapshot、编辑校验和限制。
- [Cleanup 与 block index](https://github.com/DevZjQx/oh-my-clm/blob/main/docs/features/cleanup-tool.md)：按 block ID 删除、digest/blocks 索引、只读 listing、结果模式和配置。
- [DSH surface bridge](https://github.com/DevZjQx/oh-my-clm/blob/main/docs/features/dsh-surface-bridge.md)：Cordis 生命周期、`Session.append()` surface replacement、与 Pi 的差异和验证边界。

工程与资料：

- [项目结构](https://github.com/DevZjQx/oh-my-clm/blob/main/docs/project-structure.md)：分层目录、单向依赖规则、测试布局和边界检查。
- [CLM 技术分析表](https://github.com/DevZjQx/oh-my-clm/blob/main/docs/reference/clm-technical-analysis.md)：Context Language Models 论文、官方实现和工程取舍。
- [DSH 前缀缓存](https://github.com/DevZjQx/oh-my-clm/blob/main/docs/reference/dsh-prefix-cache.md)：服务端前缀 KV 缓存、DSH 侧架构对齐和逐请求命中率可观测性。
- [DSH 证据与 harness](https://github.com/DevZjQx/oh-my-clm/blob/main/docs/reports/README.md)：mock host harness 的运行方式和历史验证报告。
- [更新日志](https://github.com/DevZjQx/oh-my-clm/blob/main/changelog.md)：各版本的修复与调整说明。

## 开发检查

本地检查（包括 DSH bridge）：

```bash
npm test
npm run check
npm run typecheck
npm pack --dry-run
```

Pi 入口只依赖 Pi 在运行时提供的 host packages；DSH host entry 只依赖 DSH/Cordis 提供的公开生命周期对象。开发依赖用于类型检查和生成 `dist/`。发布白名单包含 `README.md`、`changelog.md`、`docs/` 下的公开文档与 `docs/reports/`、`dsh-plugin.json`、`cordis.patch.yml`、`extensions/clm.ts`、`src/lib/`、`src/features/live-context/`、`dsh/`、`dist/`、`locale/` 和 `icon.svg`，不包含本地 session 生成物、`artifacts/` 打包输出或 `/tmp/clm-*` mirror 文件。

## 关键要点

- 整理历史时先按 1-based block ID 调 `cleanup`；只有 rewrite 需要完整、未截断的正文时才读 mirror。
- 所有被接受的 mirror 编辑都必须严格缩短上下文；不能安全缩短的编辑会被拒绝。
- Pi 走 branch-local `context_edit`，DSH 走 `Session.append()` surface replacement；两者的持久化语义不同。
- 超过宿主 context window 时交给 Pi 原生 auto-compaction 或 `/compact`，扩展不再追加一次 LLM 请求。
- 发布走两条通道：`npm pack` 生成 Pi+DSH 完整包，`npm run build:dsh:plugin` 生成 DSH 专用包。
