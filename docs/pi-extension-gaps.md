# Pi 插件功能差距

本文回答两个问题：Pi 侧扩展（`extensions/clm.ts`）缺哪些功能，哪些可以补上。现有行为的契约由各功能文档拥有（索引见 [docs/README.md](./README.md)），本文只记差距、接缝与补齐顺序，不重复契约正文。

## 现有功能

Pi 侧当前注册的接缝：

| 接缝 | 作用 |
| --- | --- |
| `before_agent_start` | 把 `<pi-clm-live-context>` 协议追加到 system prompt |
| `session_start` / `session_tree` / `session_shutdown` | 会话状态重建、加载器配置告警、mirror 重建 |
| `context` | 每次请求前同步 mirror；追加一次性编辑回执 `<pi-clm-edit-notice>` 与 budget nudge `<pi-clm-budget-nudge>`（system 消息，不入历史） |
| `turn_end` | 把模型对 mirror 的编辑提交为 branch-local `context_edit`；把 mirror 自读换成指针 |
| `cleanup` 工具 | 按 1-based ID 批量删除 / offload / 只读 list；结果文案按 `cleanup.resultMode` 裁剪 |
| `/clm status` | 只读状态：mirror 用量、预算状态、branch 上的 context edit 数 |

生命周期与文件协议见 [Live context mirror](./features/live-context-mirror.md)；工具契约见 [Cleanup 与 block index](./features/cleanup-tool.md)。

## 与 DSH 侧的差距

同一份配置文件和同一套共享模块服务两个宿主，但 DSH 侧的以下功能在 Pi 侧没有对应实现：

| 功能 | DSH | Pi | 出处 |
| --- | --- | --- | --- |
| 自动清理全通道（`autoClear.enabled` / `autoClear.canary`：选择器、`rot`/`money`/`both` 通道、闸门、熔断、账本、恢复、结算调度、turn 内清理） | 有 | 无 | [auto-clear.md](./features/auto-clear.md) 末尾把“Pi 侧对等实现”列为不实现 |
| 运行时 block index（`<oh-my-clm-block-index>`、`index.*`、`/clm mode` 进程级覆盖） | 有 | 无；模型只能打开 mirror 文件，`cleanup.resultMode: full` 时在工具结果里附一次刷新后的索引 | [cleanup-tool.md](./features/cleanup-tool.md) |
| `context.fixedTokens` 计入 shrink gate 与状态 | 有 | 无；Pi 用 system prompt 估算代替 | `dsh/index.ts` |
| 触发阈值 `cleanup.trigger.completedTurns` / `completedSteps` | 有 | 无；Pi 的 nudge 不读这两个 turn/step 时钟 | `dsh/index.ts`、`context-trigger.ts` |
| `/clm status` 的 auto-clear 行（armed/stopped 原因、passes、cleared、re-reads、refused keys） | 有 | 无 | `dsh/index.ts` |
| canary 离线重放（`npm run canary:replay`） | 读 DSH 会话日志（zstd） | 无 Pi 会话读取器 | `scripts/canary-replay.mjs` 头注 |
| 已清块折进索引（`[cleared …]` 行） | 有 | 无（没有自动清理，也没有运行时索引） | [cleanup-tool.md](./features/cleanup-tool.md) |

### 配置表里 Pi 不读的 key

共享加载器会解析全部 key，`extensions/clm.ts` 只读其中一部分。下表 key 在 Pi 上被解析但不产生任何效果；加载器认为它们合法，自己的 warning 通道只报非法值，所以 `extensions/clm.ts` 在 `session_start` 对配置文件里实际出现的这类 key 发一条分组 warning（清单见同文件的 `PI_IGNORED_CONFIG_KEYS`）：

- `index.mode` / `previewChars` / `headBlocks` / `tailBlocks` / `maxLines` / `refreshSteps`
- `context.fixedTokens`
- `cleanup.trigger.completedTurns` / `completedSteps`
- `autoClear.enabled` / `canary` / `staleTurns` / `staleSteps` / `channel` / `minAgeSteps` / `maxAgeSteps` / `minTokens` / `minBlocks` / `minSharePercent` / `maxSuffixTokens` / `minNetTokens` / `stopPercent` / `midTurnSuffixTokens`
- `host.pluginRecordModule`

其中 `autoClear.enabled: true` 的后果最实际：用户在项目配置里打开自动清理，Pi 侧没有变化，只有启动时的一条 warning。Pi 实际读取的 key 是 `context.budgetTokens` / `windowTokens` / `maxBlockChars` / `maxMirrorChars`、`cleanup.resultMode`、`cleanup.cacheDiscountPercent` / `paybackTurns` / `paybackSteps`、`cleanup.trigger.stepsSinceCleanup`（回退 `turnsSinceCleanup`）、`toolResultSharePercent`、`usagePercent`、`maxCandidates` 与 `minSavingsTokens`。

## 宿主能力未用

Pi 宿主提供、扩展尚未使用的接缝（见 pi-coding-agent 的 `docs/extensions.md`）：

| 接缝 | 可以用来做什么 |
| --- | --- |
| `tool_call` / `tool_result` | 重读账本：DSH 熔断的核心信号（同一目标被重读）在 Pi 侧没有跟踪；也可以在 `turn_end` 从 projection 重算，二选一 |
| `pi.appendEntry` | 会话内持久账本（canary / quality 数据）；现在扩展状态在内存 Map 里，重启即失——mirror 会重建，nudge / cleanup 计数不会 |
| `session_before_compact` / `session_compact` | compaction 后失效或重置扩展状态；现在计数跨 compaction 保留，mirror 靠 signature 失配在下一次请求重建 |
| `before_provider_request` / `cache_warming_decision` | 观测真实前缀缓存行为，校准 `cleanup.cacheDiscountPercent` |
| `registerShortcut` | 快捷键触发 `/clm status` 等小件 |
| `ctx.compact()` / 自定义 compaction | 刻意不用：手动压缩走宿主原生 `/compact`（[live-context-mirror.md](./features/live-context-mirror.md#命令与配置)） |

## 哪些可以补

按改动量与风险分档；每项给出接缝与必须保住的约束。

### 中件：运行时 block index

`index.*` 与 `/clm mode`。Pi 可在 `context` 事件以 system 消息携带索引行（与 budget nudge 同一通道），或挂进 `before_agent_start` 的协议之后。共享的 `renderBlockIndex` / `renderBlockDigest` 已支持 `cleared` 标记。必须保住的约束：索引文本在一个 turn 内逐字节不变，`index.refreshSteps` 的节流语义与 DSH 一致。

### 大件：Pi 侧自动清理与 canary:replay

1. **Pi 侧自动清理**。接缝映射：
   - DSH 的 `appendPluginRecord` ↔ Pi 的 `turn_end` boundary draft：扩展已经在 `turn_end` 返回 `context_edit` entries，自动清理是同一 draft 类型换上计算出的占位符正文；原始 entry 留在 session JSONL，“会话日志是事实”由 Pi 的 branch-local `context_edit` 语义保证。
   - DSH 的 `session/event`（`tool/call`、`tool/result`）↔ Pi 的 `tool_call` / `tool_result` 事件，或在 `turn_end` 从 projection 重算账本。
   - DSH 的 `snapshotEvents` 恢复 ↔ Pi 的 `sessionManager.getEntries()` / branch。
   - DSH 的消息投影 ↔ Pi 的下一次 `buildSessionProjection()`（`context_edit` 自动生效）。
   - DSH 的 `CANARY.jsonl` ↔ 同一路径（`sessionMirrorPath` 目录），模型不可见。
   - `stopPercent` ↔ `hostUsageOfContext` 已有宿主精确用量与窗口。

   选择器、闸门、账本类型、熔断在共享的 `auto-clear.ts` 与 `clear-projection.ts`：前者的模块注释明确说它只做选择器、投影不在这个文件里，后者拥有占位符与重放收敛。必须保住的约束：占位符严格短于正文（`clear-projection.ts` 已有跳过规则）、canary 对模型输入零字节、同一份日志重放两次得到同一投影、熔断账本有界。Pi 的 `turn_end` 每 step 触发，结算点比 DSH 更密；turn 分组用共享的 block digest units。落地后 `[cleared …]` 行折进运行时索引（`renderBlockIndex` / `renderBlockDigest` 的 `cleared` 选项），`/clm status` 补 auto-clear 行。

2. **Pi 会话的 canary:replay**。Pi 会话是未压缩 JSONL（`~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`），读取器比 DSH 的 zstd 日志更简单；记录格式沿用 `CANARY.jsonl`，给 `scripts/canary-replay.mjs` 加一个 Pi 会话根即可。

### 补齐顺序建议

中件 → 大件 1 → 大件 2。canary:replay 依赖大件 1 的记录格式。每项落地前先写失败测试（AGENTS.md 的代码规则表）。

## 明确不补

以下是项目声明的边界，补它们等于改契约，不在“缺功能”的讨论范围内（见根 [README](../README.md#边界)、[live-context-mirror.md](./features/live-context-mirror.md#命令与配置) 与 [auto-clear.md](./features/auto-clear.md) 末行）：

- 独立 agent runtime、rollback/retry harness、trajectory export、receipt store、`dsh-ops` 工具矩阵。
- 错误率回退熔断、清理后自动预取。
- `/clm refresh`、`/clm export`、专用 `/clm-compact`：手动压缩走宿主原生 `/compact`。
- 自动清理的省钱承诺：清理解决的是上下文腐烂，不是账单；宿主窗口仍是硬约束。
