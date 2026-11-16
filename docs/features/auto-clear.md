# 自动清理

DSH 侧的可选通道：在 turn 边界把**可重取**的 tool result（`read` / `read_image` / `grep` / `glob` / `web_fetch`）换成一行重取指针。候选来自两条规则：同一目标被后续调用取代，或块正文全部可重取且超过 `staleTurns` 个 turn / `staleSteps` 个 tool result。记录是 log-only 的 `ignorable` plugin record，消息投影只改模型可见副本；会话日志、surface 与人类 transcript 保持原文。默认关闭。

行为由 `src/features/live-context/auto-clear.ts`（选择器、闸门、账本类型）、`clear-projection.ts`（投影）、`plugin-record.ts`（宿主 seam）拥有；本文只写契约摘要与入口。配置文件的读取顺序见根 [README](../../README.md#配置)。

## 开关

| 配置项 | 默认 | 行为 |
| --- | --- | --- |
| `autoClear.canary` | `false` | 只写 `CANARY.jsonl`，模型输入逐字节不变 |
| `autoClear.enabled` | `false` | 写入清理记录，投影替换模型可见正文 |
| `/clm status` | — | 报告当前状态与上一次结算的结果；停止时显示 `stopped (...)` 原因 |

两个开关互不依赖；都不开时选择器只参与恢复与离线重放。

## 选择器

- 可重取工具是 `read` / `read_image` / `grep` / `glob` / `web_fetch`。`grep` / `glob` 参数规范化后相同即同一目标，`read_image` 按文件路径，`web_fetch` 按 URL；`read` 要求新行区间覆盖旧区间。
- **被取代**：块内可重取输出 ≥95% 被后续调用取代。
- **老化**：块的结果落在至少 `staleTurns` 个 turn 或 `staleSteps` 个 tool result 之前（见 [README](../../README.md#配置)）；只贡献“没人回头取”的那部分 rot。两个时钟任一到点即算老化，`0` 关闭对应时钟。
- 两条规则都要求块正文几乎全部可重取（同一 95% 口径）。清理替换的是整块可见正文，PTC 程序里混着现场输出时不清，避免用一行指针换掉还要用的分析。
- 候选按 turn 组装，被跳过的批次不消费，留到下一个边界。

判定、年龄与指针文案的口径见 `auto-clear.ts` 的模块注释。

## 记录与投影

追加一条无 `surfaceOp` 的 record：

```json
{"type":"plugin:oh-my-clm/clear","ignorable":true,"data":{"v":1,
  "targets":[{"seq":41,"label":"read src/x.ts:120-260","tokens":3400,
              "keys":["read\u0000src/x.ts"]}]}}
```

投影保留目标的 `id` / `role` / `toolCallId` / `isError`，只把 `content` 换成：

```text
[cleared 3.4k tok · read src/x.ts:120-260 · re-read if needed]
```

- `keys` 是选择器的目标身份，只供重放使用：投影不读它，占位符与不带 `keys` 的记录逐字节相同，版本号也不因此变化。
- 记录 envelope 损坏（非对象、版本未知、空 `targets`）抛错；目标已被 compaction 移出或已被先前记录清过则跳过；目标适用但畸形抛错。回放必须收敛。
- 写入必须走宿主的 `appendPluginRecord`，不能退回 `Session.append()`：后者写不出 `ignorable`，重启后整份会话会被宿主拒绝。宿主没有该 seam 时会话锁存为 `stopped (unrecordable)`，canary 不受影响。
- 结算发生在 `turn/end`（或 `step/end`）通知之后的一个 microtask：宿主在通知 `session/event` 时仍持有该 append，`appendPluginRecord` 会拒绝嵌套写入。批次、闸门与 turn 计数在边界处快照，延迟执行的只有判定与写入；见 `dsh/index.ts` 的 `scheduleSettlement`。
- 解析顺序、模块身份校验与 `host.pluginRecordModule` 的语义见 `plugin-record.ts`。

## 闸门

每 turn 边界结算一次，任一条件成立即执行：

| 配置项 | 默认 | 含义 |
| --- | --- | --- |
| `autoClear.minTokens` | `1200` | 一批至少释放的 token；量的下限，不是目标 |
| `autoClear.minBlocks` | `2` | 或者至少这么多个候选块 |
| `autoClear.minSharePercent` | `5` | 或者候选块占当前 prompt 的百分比达到该值；`0` = 只按量 |
| `autoClear.stopPercent` | `60` | 占用达到窗口百分比即停手，交给宿主 compaction |
| `autoClear.midTurnSuffixTokens` | `0` | 允许 turn 内清理的尾部预算；`0` 关闭 |

- 量闸门回答“这次断点值不值”；`minSharePercent` 回答“可清的旧内容是否已占模型读到内容的一大块”，是抗 rot 判据。
- 没有累计清理上限：`autoClear.enabled` 期间只有熔断、seam/投影缺失和 `stopPercent` 占用线能让本会话停手。
- **计时器按 step，执行点按 turn**：`completedSteps` / `stepsSinceCleanup` / `stepsOld` / 摊销 `N` 按请求计，批次、候选区间与结算点按 turn。计价的完整公式见 `clm-config.ts` 与 `context-trigger.ts`。
- `midTurnSuffixTokens > 0` 时每 turn 最多一次 turn 内清理：候选块之后待重算的尾部不超过该值即可，闸门绕过，`stop` / 投影就绪 / 熔断仍生效。

## 熔断

| 信号 | 条件 | 动作 |
| --- | --- | --- |
| 单目标重读 | 同一目标 key 被重读 2 次 | 只拒收该 key，永不再清它；显示 `N key(s) refused after re-reads` |
| 重读率 | 被清目标在 3 个 tool result 内被重取，累计 ≥3 次且占已清目标一半以上 | 本会话停止清理，显示 `stopped (breaker)` |
| 记录缝缺失 | 宿主没有 `appendPluginRecord`，或解析不到同一份模块 | 锁存 `stopped (unrecordable)`，不退回 `append()` |
| 投影缺失 | `sessions.registerMessageProjection` 尚未可用 | 跳过本轮，不锁存；候选留到下一个边界 |
| 占用 | ≥ `autoClear.stopPercent` | 跳过本轮，不锁存；占用降下来后恢复 |
| 写法失败 | writer 抛错 | 记 warn，本轮不算清理，不 retire 候选 |

重读本身不算误判，占位符就是请模型按需重读；熔断看的是比例。一批两个块各自被重读一次是一次正常往返，不足以锁存会话。窗口只保留最近 3 个 tool result 内的记录，账本不随会话长度增长。

单目标拒收先于全局熔断：一个反复被重读的 key 说明那个目标还活着，而不是选择器坏了。拒收后该 key 的证据同时被丢弃，因此它不会再推高全局重读率，其余候选照常清理——一个热点文件不会关掉整条通道。候选的 `keys` 中只要有一个被拒收，整块都不清：清理替换的是整块正文。

## 账本

`autoClear.canary: true` 时每个 turn 边界写一行到 `<会话临时目录>/CANARY.jsonl`，包括候选为空的一次：候选、`gate`、`outcome`、`suffixTokens`，以及 `quality`（`rereads` / `errors` / `errorRereads` / `contextTokens`，分 turn 增量与 session 累计）。`suffixTokens` 是一批的一次性重算成本（最早被清块之后的模型可见 token，减去同批一起删掉的正文），只记录不参与判定：闸门是抗 rot 判据，不按钱计价；有了它，重放才能把“清掉多少”和“重算多少”放在一起读。`outcome` 说明这次结算为何执行或跳过（`cleared` / `gate` / `occupancy` / `breaker` / `no-candidate` 等）。字段定义见 `auto-clear.ts` 的 `CanaryRecord` / `CanaryQuality`。空边界也落盘，所以 `0 pass(es)` 能与“选择器没看到死块”区分开。

## 恢复与离线重放

- 加载时用 `session.snapshotEvents()` 重放 `tool/call` / `tool/result` / `tool/ptc-dispatch`，并 retire 历史 clear 记录；历史 `turn/end` 不重放。
- 历史 clear 记录里的 `keys` 会在日志中的原位置放回重读窗口，所以恢复后模型对同一目标的重读仍然计数、仍然能拒收该 key；否则恢复会重清一个已经被证明还活着的目标。
- `npm run build:dsh && npm run canary:replay`，或 `node scripts/canary-replay.mjs <log>`；会话目录默认 `~/.dsh/sessions`，`--sessions-root` 覆盖。需要 PATH 上的 `zstd`。

## 索引

`dsh/index.ts` 把 clear 记录折成 `dsh:<seq>` → `{ label, tokens }`，传给 block index：`blocks` 行显示 `[cleared …]` 而不是 preview，`digest` 扣除已清 token 并附 `cleared`，缓存失效键包含已清数量。

## 与宿主的分工

- 宿主 compaction 在约 80% 占用时压缩，`tool-result-pruner` 在压缩后裁剪超长结果；插件不重复这两件事。
- 插件在 `autoClear.stopPercent`（默认 60%）停手，避免两边改同一段前缀。
- 模型始终可按指针重取；`cleanup` 保留为手动通道。
- 不实现错误率回退熔断、Pi 侧对等实现或清理后自动预取。
