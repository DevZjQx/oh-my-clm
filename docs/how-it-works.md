# oh-my-clm 是如何工作的

`oh-my-clm` 是一个运行在 Pi 中的精简 context-language model（CLM）扩展。它不直接改写模型，也不修改原始 session JSONL；它把 **当前 branch 的 Pi projection** 镜像成一个普通文件，让模型可以在 agent turn 内整理这份投影，再把合法差异转换成 Pi 原生的、branch-local `context_edit`。

```text
Pi session projection
        │
        │ context
        ▼
/tmp/clm-${sessionId}/LIVE_CTX_MAIN.md  ◄── 模型用普通 edit/write 修改
        │
        │ turn_end
        ▼
解析、snapshot 校验、配对保护、shrink-only gate
        │
        ▼
Pi context_edit entry
        │
        ▼
下一轮使用新的 context projection
```

这是官方 CLM harness 思路在 Pi 生命周期中的最小实现：没有另起一个 agent loop，也没有为 `/compact` 发送额外的 LLM 请求。

## 1. 三份数据

| 数据 | 作用 | 是否被 CLM 改写 |
| --- | --- | --- |
| Pi 原始 session JSONL | 完整、可重放的历史和 branch 来源 | 不会 |
| Pi 当前 projection | 当前 branch 加上已有 `context_edit` 后，下一轮实际可见的上下文 | 由 Pi 重算 |
| `LIVE_CTX_MAIN.md` | projection 的可编辑文本镜像 | 模型可在 agent turn 内修改 |

扩展只把第三份数据的**合法差异**提交为 Pi 能理解的 `context_edit`。因此 `/tree`、fork、resume 和原始轨迹审计仍由 Pi 负责。

## 2. 一轮请求的生命周期

### 2.1 `before_agent_start`：加入操作协议

扩展在 system prompt 末尾加入一次带 `<pi-clm-live-context>` 标记的说明，告诉模型：

- mirror 路径和 block 格式；
- `CLM_SNAPSHOT`、起止 marker、序号 ID 不能改；
- 可以使用 `cleanup({ blockIds: [...] })` 按 ID 删除过时/冗余/自指 block；它不读取 block body，且始终保留 load-bearing block 1；
- 可以缩短已有 block，也可以删除过时 block；
- 初始任务受保护，user-authored block 只能省略不能改写；
- rewrite/edit 都必须在一个 host-side 工具调用内完成，不读取或打印整个 mirror；
- `pi-clm-budget-nudge` 出现时，这是只整理上下文的 turn，不要做任务工作。

### 2.2 `context`：生成 mirror 和临时预算提醒

扩展调用 `ctx.sessionManager.buildSessionProjection()`，用
`buildMirrorRecords()` 和 `renderMirror()` 生成 `/tmp/clm-${sessionId}/LIVE_CTX_MAIN.md`。

路径由当前 session ID 决定，而不是由 `ctx.cwd` 决定；因此同一工作目录中的不同 session 具有隔离的 mirror。旧版本的 `.pi/clm` 文件不会被自动迁移或删除。

如果 agent turn 外有进程直接修改 mirror，下一次同步会恢复 canonical projection；未经 `turn_end` 校验的文件内容不会静默进入 session。

配置了 `CLM_CONTEXT_BUDGET` 且估算的请求接近目标时，`context` hook 会额外返回一条临时 user message：

```text
<pi-clm-budget-nudge>
...
</pi-clm-budget-nudge>
```

它只存在于这一次 provider request，不写入 session，也不会触发额外的模型 turn。若 Pi 的原生 context window 已没有足够空间，扩展不再追加 nudge，交给 Pi 的 native auto-compaction 处理。

### 2.3 agent turn：模型整理文件或调用 cleanup

删除 stale/self-referential block 时可以调用：

```text
cleanup({ "blockIds": [2, 3, 4] })
```

该工具在一次调用内读取当前 host 状态、按 block ID 完成删除并在返回前写完结果；它不依赖正文，也不会因为 preview 截断而构造错误的 `old_string`。load-bearing block 1、协议头和 `CLM_SNAPSHOT` 保留；assistant/tool-result 配对会一起处理。默认情况下工具结果只有一行确认，因为刷新后的 block index 会在下一次索引刷新后出现；设置 `CLM_CLEANUP_RESULT=full` 可在结果后附带索引，`none` 则不向模型返回结果文本。工具调用和结果事件本身仍完整保留在 session surface 中。

DSH bridge 还会把当前可编辑 block 的索引放进模型可见的 runtime context。默认是 turn 摘要的 `digest` 模式；`CLM_INDEX_MODE=blocks` 切回逐个 block 的列表：

```text
<oh-my-clm-block-index>
Editable blocks by cleanup ID; call cleanup({ blockIds: [...] }) to omit them.
1. assistant: I inspected the repository and found a small TypeScript project.
2. toolResult: A very large command output that is no longer useful.
... 3 editable block(s) omitted (IDs 3-5).
6. user: Keep the important repository fact.
</oh-my-clm-block-index>
```

`CLM_INDEX_MODE=digest`（默认）的摘要：

```text
<oh-my-clm-block-index>
Editable blocks by cleanup ID; ranges are inclusive. One line per turn; call cleanup({ ranges: ["A-B"] }) or cleanup({ blockIds: [...] }) to omit them.
1-2. assistant+toolResult ×2 (35 tok): I inspected the repository and found a small TypeScript project.
3-4. turn ×2 (17 tok): user (10 tok) + 1 noise: Keep the important repository fact.
IDs 5.. (current turn, not listed): One more turn.
</oh-my-clm-block-index>
```

两种模式都使用与 `cleanup` 完全相同的 1-based ordinal。`blocks` 模式附带 role 和单行短 preview，默认 preview 64 字符，列前 40 个 block 再加一段以会话中点为中心的 25 块窗口（200 块时是 1–40 和 88–112），未列出的每个连续区间用一行 `... N editable block(s) omitted (IDs A-B).` 标出。

`digest` 模式每个已完成 turn 一行：包含式 ID 区间、块数、估算 token 和该 turn 的第一条 user 消息。正在进行的 turn 只给稳定的起始锚点 `IDs N..`，不列出：它还在增长，而且工具对可能尚未结算，本来就不是安全的删除目标。因此摘要文本在一个 turn 内字节不变，DSH 的快照去重会命中，索引只在 turn 边界追加一次。`digest` 模式用 `CLM_INDEX_LINES`（默认 40）限制列出的 turn 数，超出部分用省略行标出。

`cleanup` 可以直接吃区间：`cleanup({ ranges: ["3-16"] })`、`cleanup({ blockIds: [7] })`，以及 `skipRoles: ["user"]`（在区间里保留人类消息）。显式单块 ID 仍然严格校验；range 越界会夹取，range 覆盖 block 1 时保留 block 1。配对级联删除单独以 `paired` 报告，因此“没请求却被删”的 ID 不会被误读成索引错误。

索引的静态协议（tag 含义、cleanup 使用纪律、block 1 与 protected block 规则）放在系统提示词里，随 system prompt 一起缓存；runtime-context 只携带动态行。`blocks` 模式下同一个 turn 内索引最多每 `CLM_INDEX_REFRESH_STEPS`（默认 4）步重渲染一次；节流按“打开中的 turn + 已关闭 step 数”计数，因为 DSH 在 `agent/pre-step` 渲染索引时下一步的 `step/start` 还没写入（旧 turn/step 键因此从未命中，见 E-027）。追加新 block 不会重编号，所以缓存索引里列出的 ID 始终有效；删除会重编号，`cleanup` 或 mirror edit 生效后会立即清空缓存并重渲染，compaction 事件也会保守失效。`CLM_INDEX_REFRESH_STEPS=1` 恢复每步刷新。只有需要完整、未截断的正文做 rewrite、或需要 turn 内逐块定位时，才需要打开 mirror。

需要改写时，模型可以使用一次短 rewrite 脚本完成 read+write；普通 edit 只适用于完整、未截断的 body。模型只能修改已有 block 的 body 或删除已有 block，不能通过添加 block 注入新的上下文消息。ID 是当前 mirror 中从 `1` 开始的可读编辑序号；扩展内部仍映射到 Pi 的 opaque entry ID。

### 2.4 `turn_end`：计划并提交编辑

agent turn 结束后，扩展：

1. 读取 mirror；
2. 检查版本、snapshot、重复/未知 ID、role、closing marker 等协议条件；
3. 将当前文件与 turn 开始时的 snapshot 比较；
4. 执行 tool call/result 配对保护和 shrink-only gate；
5. 返回一个或多个 Pi `context_edit` entry。

结构错误、过期 snapshot 或不满足 gate 的编辑会整体拒绝，不会部分应用。扩展不写隐藏 receipt；状态和错误通过 Pi UI 通知，原始 session JSONL 保持干净。

### 2.5 下一轮：Pi 重建 projection

Pi 在当前 branch 记录 `context_edit`，然后在下一次请求中替换或省略目标 entry。原始 entry 仍然存在，因此可以审计“原文是什么、哪个 branch 何时改变了可见性”。

## 2.6 DSH/Cordis 生命周期适配

DSH 入口是 [`../dsh/index.ts`](../dsh/index.ts)，发布发现清单是 [`../dsh-plugin.json`](../dsh-plugin.json)。它遵循官方 `deepseek-harness` 的 Cordis host plugin 形态：使用 `apply(ctx)`、`systemPrompt.section()` 和 agent/session 事件，而不是自己启动 agent loop 或扫描 session JSONL。

```text
DSH session.surface + session.snapshotEvents()
                 │
                 ▼
同一份 buildMirrorRecords/renderMirror/parseMirror/planContextEdits
                 │
                 ▼
/tmp/clm-${sessionId}/LIVE_CTX_MAIN.md ──编辑──> snapshot/安全/shrink 校验
                                      │
                                      ├─ Session.append(surfaceOp=replace)
                                      │       └─ current surface / deriveMessages
                                      └─ canonical mirror（原始 log 保留）
```

DSH 的 `Session` surface 是由官方框架从已提交事件增量投影出来的；bridge 只读取 `surface.nodes` 和事件快照来适配 `ProjectionEntryLike`。它通过 `systemPrompt.context()` 注册 `oh-my-clm:block-index`，DSH 会把该 contribution 作为 sourced user-role runtime-context snapshot 追加到模型历史；bridge 同时把 `source.kind === "runtime-context"` 的 snapshot 从 mirror records 中排除，因此它们既不会出现在可编辑 block 里，也不会让 index 列出自身。cleanup 工具通过官方 `ctx.tools.register(defineTool(...))` 注册，schema 会在 `execute` 前验证基础参数；共享 parser 再执行正整数、唯一性和 active-surface 约束。cleanup 直接基于当前 surface 的 canonical records 按 ID 执行，不经过 mirror 文件，并在工具返回前写完新的 canonical mirror。`session/event` 是 DSH 的 append-event 观察入口，但回调仍处于当前 `Session.append()` 的发布栈内，所以 bridge 只排队 reconcile，等事件发布完成后再串行检查文件。`agent/pre-step` 运行在 `step/start` 之前，此时 DSH 还没有打开新 step，因此它只等待已排队的收敛，不执行 mutation；真正的 mutation 由 `step/start`（或 `tool/result`、`user/message`）触发，确保下一次模型请求看到已经收敛的 projection。编辑通过 snapshot、结构安全和 shrink-only 校验后，bridge 使用官方 `Session.append()` 的 surface replacement seam：内容编辑追加 `assistant/message` 或 `tool/result` replacement，删除追加使用 append 时打开的 `turn`/`step`（正数）的空 `developer/message` replacement；assistant 改写同样使用这一对坐标，`tool/result` 则严格保持原事件 envelope、只改 `content`。若当前没有打开的 turn/step，bridge 拒绝 mutation 而不是写入坐标过期的事件。所有 replacement 都用 `{ op: "replace", startSeq, endSeq }`，非 assistant replacement 同时提供覆盖目标的 `sourceEventSeqs`。DSH 的 surface fold 会立即遮蔽旧节点，`deriveMessages()` 因而使用新内容；原始事件仍留在 append-only session log 中，mirror 随后重写为新的 canonical projection。DSH 文件工具可访问宿主侧的 `/tmp`，sandbox 内 bash 不应被假定能访问同一目录。

这不是 Pi 的 branch-local `context_edit`：DSH 采用当前 `Session` 的 append-only surface replacement 和它自己的 fork/persistence 语义。它也不需要 proposal、receipt 或自定义 session event。若运行时对象没有已验证的 `Session.append()` owner，bridge 会拒绝编辑并恢复 canonical mirror，而不是退回“看似应用”的 mirror-only 状态。DSH 文件工具运行在宿主侧；sandboxed bash 可能看见隔离的 `/tmp`，因此脚本只有在实际写到了 host-side mirror、且在工具返回前完成写入时才会被 bridge 采纳。

这部分依据官方 `deepseek-harness` commit `1517a4dbca0a2789ff1d41ba439600f8547d23fa` 的 `dsh-session`、surface fold、compaction replacement 和 session persistence 契约实现；`dsh-ops` 只作为 manifest/host-entry 形态的参考，不作为需要复制的工具矩阵。

## 3. Mirror 文件格式

当前协议版本为 `clm-v2`（宿主中立，Pi 与 DSH 共用）：

```markdown
<!-- clm-v2 -->
<!-- CLM_SNAPSHOT 6e4c2a1f8b7d9012 -->
<!-- Edit block bodies only. Keep CLM_ENTRY and closing markers intact. -->
<!-- id is the editable block's ordinal; do not change it or reorder blocks. -->
<!-- Delete an editable block to omit that message; use CLM_EMPTY when deleting the last one. -->
<!-- The protected initial task is intentionally not shown here. -->

[[CLM_ENTRY id=1 role=assistant]]
我检查了 README，并发现项目使用 TypeScript。
[[/CLM_ENTRY id=1]]

[[CLM_ENTRY id=2 role=toolResult]]
测试全部通过。
[[/CLM_ENTRY id=2]]
```

### Header 和 snapshot

- `clm-v2` 是协议版本；它是文件格式版本，不是宿主标识，宿主差异由入口、system prompt 标记和各自的原生应用语义承担；
- `CLM_SNAPSHOT` 是 canonical records 的 SHA-256 前缀；
- snapshot 用于检测 mirror 刷新后的竞态或过期文件，失配时拒绝编辑而不是把整份文件当作删除。

### Block 和 ID

每个 block 对应一个 Pi projection entry。文件中使用从 `1` 开始的 editable ordinal，避免模型必须先读取 session entry 的 opaque ID；解析器同时保留内部 ID 映射。DSH 的同一组 ordinal 也会由 runtime context 的 `<oh-my-clm-block-index>` 直接呈现，因此 cleanup 的 ID 目标可以只来自聊天上下文；mirror 只负责完整正文和 rewrite。`role` 只能是 `user`、`assistant`、`toolResult` 或 `custom`，改变 role 会被拒绝。

只有 block body 可编辑。删除所有可编辑 block 时必须保留：

```markdown
<!-- CLM_EMPTY -->
```

完整 header 加 `CLM_EMPTY` 表示“明确删除所有可编辑内容”；缺少 header 的空文件则会被拒绝。

## 4. Projection 到 records

`buildMirrorRecords()` 只选择可表达的 `message` 和 `custom_message` entry，并识别 `user`、`assistant`、`toolResult`、`custom` 消息。系统消息和普通 branch 元数据不会成为 block。

消息会投影成适合编辑的文本：

- text content 直接保留；
- thinking 使用 thinking 文本；
- assistant tool call 显示为工具名和 JSON 参数；
- image 显示 MIME 占位符；
- 多段 tool result 用换行连接。

### 4.1 保护初始任务

没有 compaction summary 时，首个 user entry 以及它之前的 records 被标记为 protected：它们参与 snapshot 和 token 估算，但不显示为可编辑 block，也不会因为 block 缺失而被删除。Pi 原生 `/compact` 产生新的 compaction boundary 后，projection 以新的边界为准。

### 4.2 Preview 和 canonical source

为避免大 tool output 撑爆镜像，当前固定限制为：

- 单个 block 最多显示约 12,000 字符；
- 所有可编辑 preview 最多约 96,000 字符；
- block 较多时按 editable block 数量分配 fair share。

截断 marker 只属于 `renderText`。`MirrorRecord.text` 仍保留 canonical source；模型原样保留 preview 时，解析器将其视为未编辑，真正改写后才产生 replacement。

## 5. 编辑校验和安全边界

`planContextEdits()` 先为每个 record 生成 `keep`、`replace` 或 `omit` 动作，然后整体校验。

### 5.1 必须满足的条件

1. 文件有正确版本、snapshot 和合法 block，或明确的 `CLM_EMPTY`；
2. snapshot 与当前 turn 的 canonical records 匹配；
3. 没有重复或未知 ID；
4. role 没有变化，closing marker 没有缺失；
5. user-authored block 不能被改写，只能保留或省略；
6. 编辑后的估算 context 必须严格短于编辑前。

固定的 shrink-only 策略不通过环境变量切换。共享格式层的 `estimateMessageTokens(message)` 对当前 Pi 支持的消息形状采用与 Pi host 一致的 `3.5 chars/token` 近似和按消息 rounding，并同时接受 DSH 的 `reasoning`、`tool-call`/`tool` 等词汇；system sections 和 tool declarations 在结构化 system message 中也按 host 规则估算。当前 Pi extension 的公开 `ExtensionContext` 只提供 effective system prompt，因此 `fixedRequestTokens` 只计可取得的 prompt；host 未提供的 tool declaration overhead 必须标记为 incomplete approximation，而不能假定已计入。它用于 before/after 比较；Pi context window 仍是最终约束。

### 5.2 Tool call / tool result 配对

如果 assistant block 含有 tool call，而它被改写或删除，扩展会同时删除对应 tool result；否则下一轮 provider 可能看到孤立的 tool result。反过来，删除 tool result 也会删除其 owner assistant。模型应把需要保留的事实写入不带 tool call 的短摘要，或只编辑普通历史 block。

### 5.3 文件外部修改

只有 agent turn 内的变化会被当作候选 edit。其他进程直接写 mirror 时，下一次同步恢复 canonical projection。文件写入使用临时文件加 rename，尽量避免半写入状态。

## 6. Mirror 自读保护

如果模型用 Pi `read` 工具读取 `/tmp/clm-${sessionId}/LIVE_CTX_MAIN.md`，扩展会在 `turn_end` 将成功的 tool result 替换为短指针：

```text
[oh-my-clm] Live mirror read omitted from future context; the mirror is already available at /tmp/clm-${sessionId}/LIVE_CTX_MAIN.md.
```

否则完整 mirror 会作为 tool result 回到下一轮，又被重新镜像，造成自我复制。该保护只针对识别到的 Pi `read` 调用；原始 session 历史仍保留完整 tool result，未来 projection 才使用短替换。

## 7. 命令与配置

### 命令

```text
/clm status
```

`/clm status` 显示：

- mirror 路径和大小；
- editable/protected block 数；
- preview 与 canonical token 估算；
- Pi 当前 context usage；
- 真实的目标预算状态（未超限或 `OVER`）；
- shrink-only 策略和当前 branch 的 context edit 数量。

没有 `/clm refresh`、`/clm export` 或专用 `/clm-compact`。mirror 会在生命周期事件中自动刷新；手动压缩使用 Pi 原生 `/compact`。

### 环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `CLM_CONTEXT_BUDGET` | 无 | 近似目标 token；接近目标时触发一次临时 budget nudge。正整数才生效 |

例如：

```bash
CLM_CONTEXT_BUDGET=32000 \
pi --extension ./extensions/clm.ts
```

如果不设置目标预算，扩展仍会生成 mirror、校验模型编辑并使用 Pi native context limit/auto-compaction。

## 8. 代码结构

| 文件 | 职责 |
| --- | --- |
| [`extensions/clm.ts`](../extensions/clm.ts) | Pi lifecycle handlers、mirror 同步、临时预算 nudge、`/clm status`、self-read guard |
| [`src/features/live-context/context-format.ts`](../src/features/live-context/context-format.ts) | Pi/DSH 共用的 record 构建、文本投影、序号 ID、mirror 渲染/解析、snapshot、编辑规划和 token/gate 校验 |
| [`src/features/live-context/context-cleanup.ts`](../src/features/live-context/context-cleanup.ts) | 双宿主共用的 block-ID cleanup 参数、配对/保护校验和完整 span 删除；不依赖截断 preview |
| [`src/features/live-context/dsh-bridge.ts`](../src/features/live-context/dsh-bridge.ts) | DSH surface 适配、mirror 生命周期、安全校验和 `Session.append()` replacement mutation；cleanup 直接走 active surface |
| [`dsh/index.ts`](../dsh/index.ts) | Cordis host entry：system prompt、agent/session 生命周期和文件 I/O |
| [`src/lib/clm-files.ts`](../src/lib/clm-files.ts) | session mirror 的原子写入和私有文件权限（目录 0700、文件 0600） |
| [`dsh-plugin.json`](../dsh-plugin.json) | DSH Community v0.15 host manifest；`cordis.patch.yml` 是官方 bundle 安装层 |
| [`test/features/live-context/context-format.test.ts`](../test/features/live-context/context-format.test.ts) | 协议、截断、gate、stale snapshot、tool 配对和安全边界测试 |
| [`test/features/live-context/context-cleanup.test.ts`](../test/features/live-context/context-cleanup.test.ts) | cleanup ID 校验、block 1 保留、截断 preview、完整 span 删除和配对失败测试 |
| [`test/adapters/extension.test.ts`](../test/adapters/extension.test.ts) | Pi extension 生命周期、持久化 edit、预算 nudge 和 self-read guard 测试 |
| [`test/adapters/session-integration.test.ts`](../test/adapters/session-integration.test.ts) | Pi `SessionManager` 对 context edit、原始历史和 branch 隔离的集成测试 |

完整的目录职责、导入边界和新增文件放置规则见 [`docs/project-structure.md`](./project-structure.md)。

## 9. 如何验证实现

在仓库根目录运行：

```bash
npm test
npm run check
npm run typecheck
npm pack --dry-run
```

关键不变量包括：

1. assistant tool turn 被改写时不会留下孤立 tool result；
2. 删除 stale block 必须形成 shrink edit；
3. 缺少 header、snapshot 过期、未知 ID、重复 ID 和 role 变化都会拒绝；
4. 默认不能改写 user-authored block；
5. preview 截断不会改变 canonical source；
6. Pi context edit 不会修改原始消息；
7. branch 切换不会泄漏另一个 branch 的编辑；
8. 读取 live mirror 的 tool result 不会被再次复制进未来 context；
9. cleanup 按 block ID 在一次工具调用内完成 host-side mutation，preview 截断和 `old_string` 不会影响删除；block 1、协议头和安全配对得到保留；
10. budget nudge 是临时请求内容，不会生成持久化 compact/receipt entry；DSH mirror edit 处理后会恢复新的 canonical projection。
11. DSH legal edit 会追加标准 surface replacement，原始 session event 不被删除，当前 `surface.nodes` 和 `deriveMessages()` 会改变；没有 append owner 时编辑会被拒绝。
12. session mirror 写入使用私有权限，避免 reasoning 和 tool output 被同机其他用户直接读取。

## 10. 当前取舍与限制

这是一个 Pi 扩展原型，而不是完整的 CLM serving/runtime。当前设计明确保留最小核心：

- 文本 block 编辑，而不是完整结构化 message patch；
- Pi 的 context projection、branch 和 context edit 语义；
- Pi 原生 `/compact` 和 auto-compaction 作为硬超限路径；
- Pi 的近似 token estimator，而不是 provider tokenizer；
- 原始 session JSONL 作为审计和重放来源。

它没有实现独立 Bash agent loop、rollback/retry harness、trajectory export、持久化 receipt、可调 mirror limit 或 user rewrite 开关。DSH 使用宿主 `Session.append()` 的 surface replacement，而不是 Pi 的 branch-local `context_edit`；append-only 原始日志仍是事实来源，session persistence 的即时 flush 由宿主负责。临时 mirror 可能包含 reasoning 和 tool output，虽然写入使用私有权限，仍应由宿主负责生命周期清理。模型生成的摘要仍可能误删事实、引入错误或携带 prompt injection；保护 header、初始任务和 shrink gate 不能替代内容审计。
