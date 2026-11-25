# 自动清理

可选通道：在 turn 边界把**可重取**的 tool result（`read` / `grep` / `glob` / `web_fetch`，以及显式开启时的 `read_image`）换成一行重取指针。候选来自两条规则：同一目标被后续调用取代，或块正文全部可重取且年龄落在 `minAgeSteps`–`maxAgeSteps` 个 tool result（或超过 `staleTurns` 个 turn）的窗口内；块小于 `minResultTokens`、结果还没被请求发送过、或落在会话第一条 user 消息之前时不成候选。两个宿主都只改模型可见副本；会话日志、surface 与人类 transcript 保持原文。默认关闭。

行为由 `src/features/live-context/auto-clear.ts`（选择器、闸门、账本类型）与 `clear-projection.ts`（DSH 投影与占位符）拥有；写入分别落在 `dsh/index.ts`（ignorable plugin record + 消息投影）与 `extensions/clm.ts`（`turn_end` 的 branch-local `context_edit`）。本文只写契约摘要与入口。配置文件的读取顺序见根 [README](../../README.md#配置)。

## 开关

| 配置项 | 默认 | 行为 |
| --- | --- | --- |
| `autoClear.canary` | `false` | 只写 `CANARY.jsonl`，模型输入逐字节不变 |
| `autoClear.enabled` | `false` | 写入清理记录，投影替换模型可见正文 |
| `/clm status` | — | 报告当前状态与上一次结算的结果；停止时显示 `stopped (...)` 原因 |

两个开关互不依赖；都不开时选择器只参与恢复与离线重放。

## 选择器

- 可重取工具是 `read` / `grep` / `glob` / `web_fetch`。`grep` / `glob` 参数规范化后相同即同一目标，`web_fetch` 按 URL；`read` 要求新行区间覆盖旧区间。`read_image` 默认不参与（见下）。
- **被取代**：块内可重取输出 ≥95% 被后续调用取代。
- **老化**：块的结果落在至少 `staleTurns` 个 turn 之前，或年龄（tool result 数）落在 `minAgeSteps`–`maxAgeSteps` 的窗口内（见 [README](../../README.md#配置)）；只贡献“没人回头取”的那部分 rot。窗口的下限把热区挡在外面，上限把积压旧块挡在外面——一批的重算成本从最早的块算起，无上界的年龄规则选中的积压批，其尾部就是整个会话。`0` 关闭对应时钟或边界。窗口的上限低于 step 时钟的下限（`max(staleSteps, minAgeSteps)`）时该时钟永不触发，配置解析会写一条 warning，而不是静默失效。
- 两条规则都要求块正文几乎全部可重取（同一 95% 口径）。清理替换的是整块可见正文，PTC 程序里混着现场输出时不清，避免用一行指针换掉还要用的分析。
- **位置规则先于一切**：块小于 `autoClear.minResultTokens`（默认 `1000`，约一页源码）不清——一批里有两个小块也不改变单块的账；结果还没进过一次模型请求（DSH `step/start`、Pi 的 `context` 钩子之前）不清，被拦下的块数记在账本的 `unseen`；落在会话第一条 user 消息之前的块（`SOUL.md` 一类启动读）永不清。
- `read_image` 默认不清：把 image part 换成 text 改的是消息形状，不只是大小，图片历史归宿主 compaction 与历史窗口。`autoClear.clearImages: true` 才按同一指针规则处理。
- 候选按 turn 组装，被跳过的批次不消费，留到下一个边界。

判定、年龄与指针文案的口径见 `auto-clear.ts` 的模块注释。

## 记录与投影

追加一条无 `surfaceOp` 的 record：

```json
{"type":"plugin:oh-my-clm/clear","ignorable":true,"data":{"v":1,
  "targets":[{"seq":41,"label":"read src/x.ts:120-260","tokens":3400,
              "text":"[set aside to save space · read src/x.ts:120-260 · you read its 3.4k tok in full at the time and wrote your later replies from it · re-read before editing]",
              "keys":["read\u0000src/x.ts"]}]}}
```

投影保留目标的 `id` / `role` / `toolCallId` / `isError`，只把 `content` 换成 `text` 的值：

```text
[set aside to save space · read src/x.ts:120-260 · you read its 3.4k tok in full at the time and wrote your later replies from it · re-read before editing]
```

- 占位符是一条清理回执，不是被动的邀请：模型对目标的读取已从它的副本里消失，编辑前必须重读，凭记忆编辑要么浪费一次往返、要么写在对旧内容上。它在每块下面只携带绑定到该块目标的那一条指令；「什么还在」对所有块是同一个事实，由每 turn 一次的 block index 表头（`the user still sees the original`）持有。
- 回执同时否定另一种读法：它写明这次调用当时返回了多少、模型读过并用它写了后续回复，只点名工具与大小——被读成「这次调用返回了空」的占位符会让模型否认自己先前的答案。措辞本身由 `clearPlaceholder` 的注释拥有，`clear-projection.test.ts` 把这两条意思钉在断言里。
- `text` 是写入时的字面量，投影不再现算：改一次措辞不会重写已清会话的模型输入，也不需要升版本号。没有 `text` 的旧记录走 `clearPlaceholderV1`（冻结的 v1 文案），所以同一份日志在任何构建下都投影出同样的字节。

- `keys` 是选择器的目标身份，只供重放使用：投影不读它，`text` 与不带 `keys` 的记录逐字节相同，版本号也不因此变化。
- 记录 envelope 损坏（非对象、版本未知、空 `targets`、重复 `seq`）抛错；目标已被 compaction 移出、已被先前记录清过（正文以任一版指针前缀开头）、或正文不比占位符长（替换会让模型读到更多字）则跳过；目标适用但畸形抛错，`text` 不是单行非空字符串或超过 `CLEAR_PLACEHOLDER_MAX_CHARS` 也算畸形。写入侧对超限的指针跳过该块，不写出记录；`clear-projection.test.ts` 钉住最长 label 仍在界内。回放必须收敛。
- DSH 写入必须走宿主的 `appendPluginRecord`，不能退回 `Session.append()`：后者写不出 `ignorable`，重启后整份会话会被宿主拒绝。宿主没有该 seam 时会话锁存为 `stopped (unrecordable)`，canary 不受影响。Pi 的写入是 `turn_end` 提案里的 `context_edit` draft，不依赖任何记录 seam。
- DSH 的结算发生在 `turn/end`（或 `step/end`）通知之后的一个 microtask：宿主在通知 `session/event` 时仍持有该 append，`appendPluginRecord` 会拒绝嵌套写入。批次、闸门与 turn 计数在边界处快照，延迟执行的只有判定与写入；见 `dsh/index.ts` 的 `scheduleSettlement`。Pi 的结算同步运行在 `turn_end` 处理器里，draft 随边界提案一起由宿主校验并追加。
- 解析顺序、模块身份校验与 `host.pluginRecordModule` 的语义见 `plugin-record.ts`。

## Pi 侧机制

Pi 没有消息投影 seam，但有同等的写入通道：扩展在 `turn_end` 返回的 `context_edit` draft。它是 branch-local 的持久条目——宿主把它应用于 active projection，session JSONL 里的原始事件不动，resume、fork 与分支导航都按宿主的重放语义恢复（见 `test/adapters/session-integration.test.ts`）。因此 DSH 的 `appendPluginRecord` 要求在 Pi 上不存在，通道也没有 `unrecordable` 状态。

- **结算点**：每个 `turn_end`（Pi 的一个 step）。该边界的 tool 流量（`event.message` 的 toolCall 与 `event.toolResults`）喂给共享选择器；turn 时钟按 agent loop（用户请求）计。
- **写入**：每个被清块一条 `context_edit`，replacement 是与 DSH 相同的占位符文本；消息身份、tool 配对与 compaction 锚点由宿主的 context-edit 语义保留。模型可见的 mirror 在下一次请求的同步时显示指针。
- **与手动编辑的先后**：mirror 在本 step 已被模型编辑或 `cleanup` 改过时，该边界跳过自动结算（outcome `dirty-mirror`），候选留到下一个边界；手动 diff 照常提交。镜像自读（`turn_end` 已有的自读替换）永远不会被自动清理重复处理。
- **严格缩短**：占位符不比 canonical 正文短的候选不提名；`turn_end` 的 mirror diff 通道自身也是 shrink-only。
- **canary**：同一个 `CANARY.jsonl`、同一个记录形状，写在与 mirror 相同的会话目录；模型输入逐字节不变。
- **占用停手**：用宿主精确用量（`getContextUsage`）对照 `autoClear.stopPercent`。
- **恢复**：tracker 属于活会话，恢复后从零开始——历史块不参与提名（保守侧），已清块不会被重清；上次运行的拒收账目不跨恢复保留。
- **turn 内清理**：Pi 的 step 没有 turn 内结算点，`autoClear.midTurnSuffixTokens` 在 Pi 上不生效（仍由配置加载器解析）。

## 闸门

每 turn 边界结算一次，任一条件成立即执行：

| 配置项 | 默认 | 含义 |
| --- | --- | --- |
| `autoClear.minTokens` | `1200` | 一批至少释放的 token；量的下限，不是目标 |
| `autoClear.minTokensWindowPercent` | `5` | 同一个下限按窗口计的百分比：实际门槛是 `max(minTokens, 该值 × 窗口)`；`0` = 只按固定值 |
| `autoClear.minBlocks` | `2` | 宿主报告了窗口时不再单独开闸；窗口未知时按块数开闸 |
| `autoClear.minSharePercent` | `5` | 或者候选块占当前 prompt 的百分比达到该值；`0` = 只按量 |
| `autoClear.maxSuffixTokens` | `0` | money 通道：一批的一次性重算成本超过该值即拒；`0` 关闭 |
| `autoClear.minNetTokens` | `0` | money 通道：摊销净收益 `r·ΔL − (1−r)·S / N` 的下限；`0` 允许恰好回本，负值关闭 |
| `autoClear.stopPercent` | `60` | 占用达到窗口百分比即停手，交给宿主 compaction |
| `autoClear.midTurnSuffixTokens` | `0` | 允许 turn 内清理的尾部预算；`0` 关闭 |

- 量闸门回答“这次断点值不值”；`minSharePercent` 回答“可清的旧内容是否已占模型读到内容的一大块”，是抗 rot 判据。
- 量门槛随窗口缩放：`max(minTokens, minTokensWindowPercent% × 窗口)`；窗口未知时只剩固定值与块数两条路。为什么固定值不能单独用、为什么块数只在窗口未知时开闸，见 `auto-clear.ts` 的 `batchPassesGate`。
- `autoClear.channel` 选判据：`rot`（默认）只看量与死内容占比；`money` 再要求一批的一次性重算成本 ≤ `maxSuffixTokens` 且摊销净收益 ≥ `minNetTokens`（`r` 取 `cleanup.cacheDiscountPercent`，`N` 取 `cleanup.paybackSteps`，否则 `paybackTurns`）；`both` 让被 money 拒的批仍走 rot。默认 `rot` 保持现有判定不变，money 显式开启。
- 没有累计清理上限：`autoClear.enabled` 期间只有熔断、seam/投影缺失和 `stopPercent` 占用线能让本会话停手。
- **计时器按 step，执行点按 turn**：`completedSteps` / `stepsSinceCleanup` / `stepsOld` / 摊销 `N` 按请求计，批次、候选区间与结算点按 turn。计价的完整公式见 `clm-config.ts` 与 `context-trigger.ts`。
- `midTurnSuffixTokens > 0` 时每 turn 最多一次 turn 内清理：候选块之后待重算的尾部不超过该值即可，闸门绕过，`stop` / 投影就绪 / 熔断仍生效。

## 熔断

| 信号 | 条件 | 动作 |
| --- | --- | --- |
| 单目标重读 | 同一目标 key 被重读 2 次（第一次就是占位符要求的编辑前重读） | 只拒收该 key，永不再清它；显示 `N key(s) refused after re-reads` |
| 拒收率 | 累计 ≥3 个不同目标被拒收，且占已清目标一半以上 | 本会话停止清理，显示 `stopped (breaker)` |
| 记录缝缺失（DSH） | 宿主没有 `appendPluginRecord`，或解析不到同一份模块 | 锁存 `stopped (unrecordable)`，不退回 `append()`；Pi 无此状态 |
| 投影缺失 | `sessions.registerMessageProjection` 尚未可用 | 跳过本轮，不锁存；候选留到下一个边界 |
| 占用 | ≥ `autoClear.stopPercent` | 跳过本轮，不锁存；占用降下来后恢复 |
| 写法失败 | writer 抛错 | 记 warn，本轮不算清理，不 retire 候选 |

重读本身不算误判：占位符就要求模型在编辑前重读，所以第一次重读是遵守指令，不是选错了块。证据从同一 key 的第二次重读开始——那是模型拿到它要的重读之后又回来了。全局熔断因此数被拒收的目标，而不是重读次数：重读次数只进账本（canary 的 `rereads` 与 `/clm status`），数它会让会话在模型听话时自毁。窗口保留最近 3 个 tool result 内的目标 key，同一目标被清掉多个副本也只占一条，账本不随会话长度增长。

单目标拒收先于全局熔断：一个反复被重读的 key 说明那个目标还活着，而不是选择器坏了。拒收后该 key 从重读窗口里移除，其余候选照常清理——一个热点文件不会关掉整条通道。候选的 `keys` 中只要有一个被拒收，整块都不清：清理替换的是整块正文。

## 账本

`autoClear.canary: true` 时每个 turn 边界写一行到 `<会话临时目录>/CANARY.jsonl`，包括候选为空的一次：候选、`unseen`（被“模型还没看到”拦下的块数）、`gate`、`outcome`、`suffixTokens`，以及 `quality`（`rereads` / `errors` / `errorRereads` / `contextTokens`，分 turn 增量与 session 累计）。`suffixTokens` 是一批的一次性重算成本（最早被清块之后的模型可见 token，减去同批一起删掉的正文）。`rot` 通道只记录不判定；`money` 通道用它判定。有了它，重放才能把“清掉多少”和“重算多少”放在一起读。`outcome` 说明这次结算为何执行或跳过（`cleared` / `gate` / `occupancy` / `breaker` / `no-candidate` 等）。字段定义见 `auto-clear.ts` 的 `CanaryRecord` / `CanaryQuality`。空边界也落盘，所以 `0 pass(es)` 能与“选择器没看到死块”区分开。

## 恢复与离线重放

- 加载时用 `session.snapshotEvents()` 重放 `tool/call` / `tool/result` / `tool/ptc-dispatch`，以及标记「已发送」与「首条 user 消息」的 `step/start` / `user/message`，并 retire 历史 clear 记录；历史 `turn/end` 不重放。
- 历史 clear 记录里的 `keys` 会在日志中的原位置放回重读窗口，所以恢复后模型对同一目标的重读仍然计数、仍然能拒收该 key；否则恢复会重清一个已经被证明还活着的目标。
- `npm run build:dsh && npm run canary:replay`，或 `node scripts/canary-replay.mjs <log>`；会话目录默认 `~/.dsh/sessions`，`--sessions-root` 覆盖。`--max-age-steps` 覆盖 rot 窗口上界，`--min-result-tokens` 覆盖单块下限，`--clear-images` 打开图片清理，`--discount` / `--payback` 定价净收益。需要 PATH 上的 `zstd`。

## 索引

`dsh/index.ts` 把 clear 记录折成 `dsh:<seq>` → `{ label, tokens }`，传给 block index：`blocks` 行显示 `[set aside …]` 而不是 preview，`digest` 扣除已清 token 并附 `cleared`，缓存失效键包含已清数量。

## 与宿主的分工

- 宿主 compaction 在约 80% 占用时压缩，`tool-result-pruner` 在压缩后裁剪超长结果；插件不重复这两件事。
- 插件在 `autoClear.stopPercent`（默认 60%）停手，避免两边改同一段前缀。
- 模型始终可按指针重取；`cleanup` 保留为手动通道。
- 不实现错误率回退熔断或清理后自动预取。
