# oh-my-clm 是如何工作的

`oh-my-clm` 是一个运行在 Pi 中的精简 context-language model（CLM）扩展。它不直接改写模型，也不修改原始 session JSONL；它把 **当前 branch 的 Pi projection** 镜像成一个普通文件，让模型可以在 agent turn 内整理这份投影，再把合法差异转换成 Pi 原生的、branch-local `context_edit`。

```text
Pi session projection
        │
        │ context
        ▼
.pi/clm/LIVE_CTX_MAIN.md  ◄── 模型用普通 edit/write 修改
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
- 可以缩短已有 block，也可以删除过时 block；
- 初始任务受保护，user-authored block 只能省略不能改写；
- 使用一次普通 edit/write 操作完成整理，不读取或打印整个 mirror；
- `pi-clm-budget-nudge` 出现时，这是只整理上下文的 turn，不要做任务工作。

### 2.2 `context`：生成 mirror 和临时预算提醒

扩展调用 `ctx.sessionManager.buildSessionProjection()`，用
`buildMirrorRecords()` 和 `renderMirror()` 生成 `.pi/clm/LIVE_CTX_MAIN.md`。

如果 agent turn 外有进程直接修改 mirror，下一次同步会恢复 canonical projection；未经 `turn_end` 校验的文件内容不会静默进入 session。

配置了 `CLM_CONTEXT_BUDGET` 且估算的请求接近目标时，`context` hook 会额外返回一条临时 user message：

```text
<pi-clm-budget-nudge>
...
</pi-clm-budget-nudge>
```

它只存在于这一次 provider request，不写入 session，也不会触发额外的模型 turn。若 Pi 的原生 context window 已没有足够空间，扩展不再追加 nudge，交给 Pi 的 native auto-compaction 处理。

### 2.3 agent turn：模型编辑文件

模型可以像编辑普通文件一样缩短历史：

```markdown
[[CLM_ENTRY id=1 role=assistant]]
已经检查仓库：这是一个小型 TypeScript Pi 插件，测试位于 test/。
[[/CLM_ENTRY id=1]]
```

模型只能修改已有 block 的 body 或删除已有 block，不能通过添加 block 注入新的上下文消息。ID 是当前 mirror 中从 `1` 开始的可读编辑序号；扩展内部仍映射到 Pi 的 opaque entry ID。

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
LIVE_CTX_MAIN.md ──合法编辑──> LIVE_CTX_MAIN.patch.json
                                      │
                                      └─ host policy（当前未提供）
```

DSH 的 `Session` surface 是由官方框架从已提交事件增量投影出来的；bridge 只读取 `surface.nodes` 和事件快照来适配 `ProjectionEntryLike`。它在 `agent/pre-step` 前刷新 mirror，并在 `session/event` 后尽早检查模型的文件编辑。

DSH 当前没有在本项目中验证到可映射 Pi `context_edit` 的 branch-local 原生 API。因此 patch 是**明确的提案/receipt**，不是 session mutation：

- `status: applied` 表示共享格式层接受了编辑计划，不表示 DSH 活动上下文已改变；
- patch 保留 `baseSnapshot`、target IDs、replacement/omit、token gate、warnings 和 paired tool-call/result 结果；
- `status: rejected` 也会写入 patch 文件，便于 mock host 或未来 host policy 审计；
- 只有一个明确消费 patch 的 DSH host policy 才能把它转成 DSH 认可的 session/surface 操作。当前 bridge 不假设这种 policy 存在，也不写自定义 session event。

这部分依据官方 `deepseek-harness` 的 session projection、agent-loop、system-prompt 和 Cordis plugin development 资料实现；`dsh-ops` 只作为 manifest/host-entry 形态的参考，不作为需要复制的工具矩阵。

## 3. Mirror 文件格式

当前协议版本为 `pi-clm-v2`：

```markdown
<!-- pi-clm-v2 -->
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

- `pi-clm-v2` 是协议版本；
- `CLM_SNAPSHOT` 是 canonical records 的 SHA-256 前缀；
- snapshot 用于检测 mirror 刷新后的竞态或过期文件，失配时拒绝编辑而不是把整份文件当作删除。

### Block 和 ID

每个 block 对应一个 Pi projection entry。文件中使用从 `1` 开始的 editable ordinal，避免模型必须先读取 session entry 的 opaque ID；解析器同时保留内部 ID 映射。`role` 只能是 `user`、`assistant`、`toolResult` 或 `custom`，改变 role 会被拒绝。

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

如果模型用 Pi `read` 工具读取 `.pi/clm/LIVE_CTX_MAIN.md`，扩展会在 `turn_end` 将成功的 tool result 替换为短指针：

```text
[oh-my-clm] Live mirror read omitted from future context; the mirror is already available at .pi/clm/LIVE_CTX_MAIN.md.
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
| [`src/context-format.ts`](../src/context-format.ts) | Pi/DSH 共用的 record 构建、文本投影、序号 ID、mirror 渲染/解析、snapshot、编辑规划和 token/gate 校验 |
| [`src/dsh-bridge.ts`](../src/dsh-bridge.ts) | DSH surface 适配、mirror 生命周期和显式 patch 提案输出（不自动改写 session） |
| [`dsh/index.ts`](../dsh/index.ts) | Cordis host entry：system prompt、agent/session 生命周期和文件 I/O |
| [`dsh-plugin.json`](../dsh-plugin.json) | DSH Community v0.15 host manifest；`cordis.patch.yml` 是官方 bundle 安装层 |
| [`test/context-format.test.ts`](../test/context-format.test.ts) | 协议、截断、gate、stale snapshot、tool 配对和安全边界测试 |
| [`test/extension.test.ts`](../test/extension.test.ts) | Pi extension 生命周期、持久化 edit、预算 nudge 和 self-read guard 测试 |
| [`test/session-integration.test.ts`](../test/session-integration.test.ts) | Pi `SessionManager` 对 context edit、原始历史和 branch 隔离的集成测试 |

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
9. budget nudge 是临时请求内容，不会生成持久化 compact/receipt entry。

## 10. 当前取舍与限制

这是一个 Pi 扩展原型，而不是完整的 CLM serving/runtime。当前设计明确保留最小核心：

- 文本 block 编辑，而不是完整结构化 message patch；
- Pi 的 context projection、branch 和 context edit 语义；
- Pi 原生 `/compact` 和 auto-compaction 作为硬超限路径；
- Pi 的近似 token estimator，而不是 provider tokenizer；
- 原始 session JSONL 作为审计和重放来源。

它没有实现独立 Bash agent loop、rollback/retry harness、trajectory export、持久化 receipt、可调 mirror limit 或 user rewrite 开关。模型生成的摘要仍可能误删事实、引入错误或携带 prompt injection；保护 header、初始任务和 shrink gate 不能替代内容审计。
