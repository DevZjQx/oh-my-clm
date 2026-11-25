# Pi 插件功能差距

本文回答两个问题：Pi 侧扩展（`extensions/clm.ts`）缺哪些功能，哪些可以补上。现有行为的契约由各功能文档拥有（索引见 [docs/README.md](./README.md)），本文只记差距、接缝与补齐顺序，不重复契约正文。

## 现有功能

Pi 侧当前注册的接缝：

| 接缝 | 作用 |
| --- | --- |
| `before_agent_start` | 把 `<pi-clm-live-context>` 协议追加到 system prompt |
| `session_start` / `session_tree` / `session_shutdown` | 会话状态重建、加载器与忽略键告警、mirror 重建 |
| `agent_start` | 推进自动清理的 turn 时钟（一个 agent loop 记一个 turn） |
| `context` | 每次请求前同步 mirror、标记自动清理的请求边界（已落地的 tool result 进入该请求）；追加一次性编辑回执 `<pi-clm-edit-notice>` 与 budget nudge `<pi-clm-budget-nudge>`（system 消息，不入历史） |
| `turn_end` | 把模型对 mirror 的编辑提交为 branch-local `context_edit`；把 mirror 自读换成指针；结算自动清理（`autoClear.enabled` / `autoClear.canary`） |
| `cleanup` 工具 | 按 1-based ID 批量删除 / offload / 只读 list；结果文案按 `cleanup.resultMode` 裁剪 |
| `/clm status` | 只读状态：mirror 路径 / 字节 / token 预览、protected 块数、宿主用量、预算状态、branch 上的 context edit 数、auto-clear 行 |

生命周期与文件协议见 [Live context mirror](./features/live-context-mirror.md)；工具契约见 [Cleanup 与 block index](./features/cleanup-tool.md)。

## 与 DSH 侧的差距

同一份配置文件和同一套共享模块服务两个宿主，但 DSH 侧的以下功能在 Pi 侧没有对应实现，或只有部分实现：

| 功能 | DSH | Pi | 出处 |
| --- | --- | --- | --- |
| turn 内清理（`autoClear.midTurnSuffixTokens`） | 有 | 无；Pi 的 step 没有 turn 内结算点，该 key 在 Pi 上被解析但不产生效果 | [auto-clear.md](./features/auto-clear.md) 的 Pi 侧机制 |
| 恢复后保留 tracker 与拒收证据 | 有（`snapshotEvents` + 记录里的 `keys`） | 无；`context_edit` 由宿主重放，已清块不会被重清，但 tracker 从零开始，历史块不参与提名（保守侧） | [auto-clear.md](./features/auto-clear.md) 的 Pi 侧机制 |
| 运行时 block index（`<oh-my-clm-block-index>`、`index.*`、`/clm mode` 进程级覆盖） | 有 | 无；模型只能打开 mirror 文件，`cleanup.resultMode: full` 时在工具结果里附一次刷新后的索引 | [cleanup-tool.md](./features/cleanup-tool.md) |
| `context.fixedTokens` 计入 shrink gate 与状态 | 有 | 无；Pi 用 system prompt 估算代替 | `dsh/index.ts` |
| 触发阈值 `cleanup.trigger.completedTurns` / `completedSteps` | 有 | 无；Pi 只把 step 时钟用于 `stepsSinceCleanup` 与年龄规则，不把这两个 key 当作触发阈值 | `dsh/index.ts`、`context-trigger.ts` |
| `/clm status` 的 auto-clear 行细节（armed/stopped、mid-turn、passes、cleared tokens、re-reads、error re-reads、refused keys、last 的 turn/token） | 有 | 部分；已有 mode（enabled/canary）、stopped 原因、passes、cleared blocks 与 last outcome/candidates，缺 cleared tokens、re-reads、error re-reads、refused keys、mid-turn 状态与 last 的 turn/token | `dsh/index.ts`、`extensions/clm.ts` |
| canary 离线重放（`npm run canary:replay`） | 读 DSH 会话日志（zstd） | 无 Pi 会话读取器 | `scripts/canary-replay.mjs` 头注 |
| 已清块折进索引（`[set aside …]` 行） | 有 | 无；没有运行时索引，已清块只在下一次 mirror 同步时显示为占位符 | [cleanup-tool.md](./features/cleanup-tool.md) |

### 配置表里 Pi 不读的 key

共享加载器会解析全部 key，`extensions/clm.ts` 只读其中一部分。下表 key 在 Pi 上被解析但不产生任何效果；加载器认为它们合法，自己的 warning 通道只报非法值，所以 `extensions/clm.ts` 在 `session_start` 对配置文件里实际出现的这类 key 发一条分组 warning（清单见同文件的 `PI_IGNORED_CONFIG_KEYS`）：

- `index.mode` / `previewChars` / `headBlocks` / `tailBlocks` / `maxLines` / `refreshSteps`
- `context.fixedTokens`
- `cleanup.trigger.completedTurns` / `completedSteps`
- `autoClear.midTurnSuffixTokens`
- `host.pluginRecordModule`

`autoClear` 的其余 key Pi 都已读取：`turn_end` 结算自动清理，选择器、`rot`/`money`/`both` 通道、闸门、熔断与账本见 [auto-clear.md](./features/auto-clear.md) 的 Pi 侧机制。Pi 实际读取的 key 是 `context.budgetTokens` / `windowTokens` / `maxBlockChars` / `maxMirrorChars`、`cleanup.resultMode`、`cleanup.cacheDiscountPercent` / `paybackTurns` / `paybackSteps`、`cleanup.trigger.stepsSinceCleanup`（回退 `turnsSinceCleanup`）、`toolResultSharePercent`、`usagePercent`、`maxCandidates`、`minSavingsTokens`，以及除 `midTurnSuffixTokens` 外的全部 `autoClear` key。

## 宿主能力未用

Pi 宿主提供、扩展尚未使用的接缝（见 pi-coding-agent 的 `docs/extensions.md`）：

| 接缝 | 可以用来做什么 |
| --- | --- |
| `pi.appendEntry` | 会话内持久账本（canary / quality 数据）；现在扩展状态在内存 Map 里，重启即失——mirror 会重建，nudge、cleanup 与 auto-clear 的计数不会 |
| `session_before_compact` / `session_compact` | compaction 后失效或重置扩展状态；现在计数跨 compaction 保留，mirror 靠 signature 失配在下一次请求重建 |
| `before_provider_request` / `cache_warming_decision` | 观测真实前缀缓存行为，校准 `cleanup.cacheDiscountPercent` |
| `registerShortcut` | 快捷键触发 `/clm status` 等小件 |
| `ctx.compact()` / 自定义 compaction | 刻意不用：手动压缩走宿主原生 `/compact`（[live-context-mirror.md](./features/live-context-mirror.md#命令与配置)） |

## 哪些可以补

按改动量与风险分档；每项给出接缝与必须保住的约束。

### 小件：auto-clear 状态行细节

`autoClearStatusLine` 已有 mode、passes、cleared blocks、last outcome 与 stopped 原因；`AutoClearState` 还记着 `clearedTokens`、`rereads`、`errorRereads` 与 `reread.refused`。补齐只是把这些字段拼进同一行，不需要新接缝。必须保住的约束：状态行只读，不改变计数或清理决定。

### 中件：运行时 block index

`index.*` 与 `/clm mode`。Pi 可在 `context` 事件以 system 消息携带索引行（与 budget nudge 同一通道），或挂进 `before_agent_start` 的协议之后。共享的 `renderBlockIndex` / `renderBlockDigest` 已支持 `cleared` 标记。必须保住的约束：索引文本在一个 turn 内逐字节不变，`index.refreshSteps` 的节流语义与 DSH 一致。

### 大件：Pi 会话的 canary:replay

自动清理已在 Pi 侧落地（`turn_end` 结算，记录与机制见 [auto-clear.md](./features/auto-clear.md) 的 Pi 侧机制），剩余的配套是离线重放：Pi 会话是未压缩 JSONL（`~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`），读取器比 DSH 的 zstd 日志更简单；记录格式沿用 `CANARY.jsonl`，给 `scripts/canary-replay.mjs` 加一个 Pi 会话根即可。

### 补齐顺序建议

小件 → 中件 → 大件。每项落地前先写失败测试（AGENTS.md 的代码规则表）。

## 明确不补

以下是项目声明的边界，补它们等于改契约，不在“缺功能”的讨论范围内（见根 [README](../README.md#边界)、[live-context-mirror.md](./features/live-context-mirror.md#命令与配置) 与 [auto-clear.md](./features/auto-clear.md) 末行）：

- 独立 agent runtime、rollback/retry harness、trajectory export、receipt store、`dsh-ops` 工具矩阵。
- 错误率回退熔断、清理后自动预取。
- `/clm refresh`、`/clm export`、专用 `/clm-compact`：手动压缩走宿主原生 `/compact`。
- 自动清理的省钱承诺：清理解决的是上下文腐烂，不是账单；宿主窗口仍是硬约束。
