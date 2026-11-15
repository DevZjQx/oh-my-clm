# 自动清理：canary、投影与熔断

DSH 侧新增的一条通道：在 turn 边界把**已被同一目标取代**的 tool-result 块换成一行指针，让模型仍能按指针重取，但不再为死内容付钱、也不再让死内容埋在窗口里。

三个开关互相独立，全部写在配置文件里（用户级 `$XDG_CONFIG_HOME/oh-my-clm/config.json`，未设时为 `~/.config/oh-my-clm/config.json`；或项目级 `.oh-my-clm.json`）：

| 配置项 | 默认 | 作用 |
| --- | --- | --- |
| `autoClear.canary` | `false` | 只记录"本来会清哪些"，写 `CANARY.jsonl`，模型侧逐字节不变 |
| `autoClear.enabled` | `false` | 真正清理：追加一条 durable 记录，投影把正文换成指针 |
| `/clm` | — | `status` 末尾多一行自动清理状态；熔断后显示 `stopped (breaker)` |

默认都不开。原因写在 [changelog](../changelog.md)：0.1.18 曾用自家数据证明"就地清理在 `r=0.02` 下不省钱"，这条路卖的是**抗 rot**，不是省钱；在没有真实会话账本之前默认改模型输入，等于拿用户的会话做实验。

## 为什么不是 `llm/stream`

早期方案想让插件在 `llm/stream` 里改投递副本（cookbook 的"服务端编辑只改副本"）。DSH 上不可行：

- `dsh-agent-loop` 把请求冻结：`deepFreeze(message)` 逐条、`Object.freeze(boundaryMessages)`、`Object.freeze(GenerateOptions)`（`lib/index.js:1084-1093`）。
- `llm/stream` 的 `next` 不接受参数（`dsh-llm/lib/types/index.d.ts:45`），监听器只能旁听。
- 宿主把这条写成了规则：`agent/request` "Model-visible content must use logged channels; this waterfall **cannot** mutate messages"（`dsh-agent/lib/types/runtime-types.d.ts:350`）。

宿主的替代面是**日志事件 + 消息投影**：`ctx.sessions.registerMessageProjection({ type, project })`。它和 surface replacement 的区别恰好是我们需要的：

| | surface replacement（旧 `cleanup`） | 消息投影（本通道） |
| --- | --- | --- |
| 会话日志 | 新增一条替换事件，正文本复制 | 只新增一条决策记录 |
| surface / ID | 变（要重编号、要镜像对齐） | **不变** |
| 人类 transcript | 原文被替换掉 | 保留原文 |
| 回放 | 依赖替换事件自洽 | 纯函数按日志重算 |

## 选择器：什么算死块

只有**可重取工具**（`read` / `grep` / `glob`）的结果会成为候选，且必须被同一目标的后续调用取代。

- `grep` / `glob`：参数规范化后相同即同一目标。
- `read`：同一路径**且**新读取的行区间覆盖旧区间；`offset 200` 不取代 `offset 1 limit 100`。缺 `limit` 视为读到文件末尾。
- `bash` / `write` / `web` 一律不是候选：结果不可确定重取。

块级判定：PTC 执行器下一个 `run_code` 块装多个子调用，**块内全部可重取输出都被取代**（`deadShare = 0.95`）才算死块。否则删整块会连带删掉仍然有效的子结果。

## 记录与投影

清理追加一条 **ignorable plugin record**（无 `surfaceOp`，不新增 surface 节点）：

```json
{"type":"plugin:oh-my-clm/clear","ignorable":true,"data":{"v":1,
  "targets":[{"seq":41,"label":"read src/x.ts:120-260","tokens":3400}]}}
```

写入走宿主的 `appendPluginRecord(session, type, data)`（`@deepseek-ai/dsh-session` ≥ 0.2.2-rc.1）。`ignorable: true` 是这个通道能存在的前提：宿主的持久化读路径（`dsh-session-persistence` 的 `validateStoredEvents`）对**不认识且未标 ignorable** 的事件类型直接抛 `SessionFormatUnsupportedError`，拒绝恢复整个会话。`Session.append()` 没有设置该标记的入口，所以用 `append()` 写插件事件 = 重启后用户的会话打不开——用用户的 transcript 换 token 不划算。

插件**不静态 import** 宿主的 `dsh-session`：profile 安装只解析插件自己的依赖，静态 import 会让插件在它要发布的环境里加载失败。因此 `src/features/live-context/plugin-record.ts` 在会话创建时动态解析 `appendPluginRecord`：

| 宿主 | 行为 |
| --- | --- |
| 有 `appendPluginRecord`（≥ 0.2.2-rc.1 且可解析） | 记录可写，清理可用 |
| 没有（旧宿主 / 不可解析） | **绝不退回 `append()`**：会话创建时 warn 一次，本会话清理锁存为 `stopped (unrecordable)`，`/clm` 明写原因 |

`host.pluginRecordModule` 可覆盖解析目标（默认 `@deepseek-ai/dsh-session`），harness 用它注入一个等价 writer 验证“记录确实是 ignorable 的、且没有新增 surface 节点”。这是配置里**唯一**把字符串变成代码执行的点：设了它并打开 `autoClear.enabled`，等于信任写这份配置的仓库，所以它定位为高级/测试开关；不设就是宿主自己的包，没有额外风险。

投影（`src/features/live-context/clear-projection.ts`）把目标节点推导成：

```text
[cleared 3.4k tok · read src/x.ts:120-260 · re-read if needed]
```

保留 `id` / `role` / `toolCallId` / `isError`，只换 `content`。校验分两类：

- **记录本身坏了就抛**（不是对象、版本不认识、`targets` 为空）——这类日志无法解释。
- **目标不适用就跳过**：位置已被宿主 compaction 移出 surface（模型读不到，没什么可换），或同一条记录之前已经清过它（回放必须收敛）。为一条读不到的指针拒绝加载整个会话，代价远大于收益。
- **目标适用却畸形仍抛**（`label` 1–200 字符、`tokens` 非负整数、同记录内不重复）。静默丢掉会造出“日志说清了、模型没看到”的状态。

**一个已知取舍**：`ignorable` 记录在宿主格式迁移中是 best-effort 保留的；真丢了，模型看到的只是原文回来（多花 token），不会损坏会话。

## 闸门与限额

一个 turn 结束结算一次，必须同时满足：

| 配置项 | 默认 | 含义 |
| --- | --- | --- |
| `autoClear.minTokens` | `1200` | 一批至少释放这么多 token |
| `autoClear.minBlocks` | `2` | 或者至少这么多个死块 |
| `autoClear.stopPercent` | `60` | 占用达到窗口百分比就停手，交给宿主 compaction |
| `autoClear.maxTokens` | `40000` | 单会话累计清理上限 |

闸门很小，因为每次清理都会在清理位置断开前缀缓存：真实会话里一轮尾部滚动通常只有 1–3 块，8k 的闸门会让它永不触发（0.1.18 的失败形态）。

**预算不是整批否决。** 一批 73,646 token 对 40,000 上限时，旧逻辑会在清任何东西之前锁存 `stopped (budget)`；现在按 seq 从旧到新切片，只清预算还付得起的那部分，剩余候选留到下一个边界。首个批次允许超一个候选（单个超大块），否则一个比预算还大的死块永远清不掉，只能等宿主 compaction。

**被跳过的批次不会被丢掉。** `peekBatch()` 是只读的，只有真正写入成功的那一批才 `retire()`：闸门不够、占用过高、投影还没注册时，候选留在池子里，下一个 turn 边界连同新死的块一起再算一次，因此“每轮只死一块、单块不足闸门”的会话也能累积到一次可执行的清理。canary 账本对每个块只写一行（按 blockId 去重），重复跳过不会刷屏。

## 熔断

| 信号 | 条件 | 动作 |
| --- | --- | --- |
| 重读率 | 被清目标在 3 个 tool result 内被重取，累计 ≥2 次且占已清目标一半以上 | 本会话停止清理，`/clm` 显示 `stopped (breaker)` |
| 预算 | 累计清理超过 `autoClear.maxTokens` | 本会话停止，`stopped (budget)` |
| 记录缝缺失 | 宿主没有 `appendPluginRecord`（或旧宿主） | 本会话锁存 `stopped (unrecordable)`，绝不退回 `session.append` |
| 投影缺失 | `sessions.registerMessageProjection` 尚未可用 | **跳过本轮**，不锁存；候选留到下一个 turn 边界，注册成功前绝不追加记录 |
| 占用 | ≥ `autoClear.stopPercent` | **跳过本轮**，不锁存；占用降下来后连同未清候选一起恢复 |
| 写法失败 | writer 抛错 | 记 warn，本轮不算清理，候选不 retire |

重读本身不算误判：占位符就是请模型按需重读。熔断看的是**比例**——多数被清目标立刻回来，说明清理在制造工具调用而不是删废料。熔断窗口只保留最近 3 个 tool result 内的记录（`pruneRecent`），所以账本不随会话长度增长。

## 账本

`autoClear.canary: true` 时每个 turn 决策写一行到 `<会话临时目录>/CANARY.jsonl`：

```json
{"at":1794770,"turn":3,"tokens":4697,"gate":true,
 "candidates":[{"blockId":"call_…","seq":41,"tokens":4697,
                "calls":[{"name":"grep","seq":21}],"keys":["grep\u0000pattern=\"needle\""],
                "label":"grep \"needle\"","ageBlocks":12}]}
```

- `seq`：目标 `tool/result` 的会话序号，投影的寻址单位。
- `ageBlocks`：被取代的调用与取代它的调用之间落了多少个 tool result，即"断点离尾部多远"。
- `gate`：这次是否够格执行。

日志写在 `/tmp/clm-<session-id>/`（与 mirror 同目录、同样私有权限），随临时目录消失；不写改模型输入的事件之外的任何会话日志，也不需要新增 manifest 权限。

## 恢复（resumed session）

插件加载时用 `session.snapshotEvents()` 重建选择器：

- 历史里的 `tool/call` / `tool/result` / `tool/ptc-dispatch` 照常喂给选择器，所以插件加载前就死掉的块仍会在**第一个** live turn 边界被报告/清理一次。
- 历史里的 `turn/end` **不重放**：那一刻的批次早就在上一次运行里决定过了，重放会消费候选、让第一个 live 边界无话可说。
- 历史里的 `plugin:oh-my-clm/clear` 记录会 retire 对应目标，并把已清 token 计入预算——否则 resumed 会话会把同一块清第二遍（记录是 log-only，原文还在）。

## 离线重放

同一个选择器可以跑在已存会话上，不需要模型调用：

```bash
npm run build:dsh
npm run canary:replay          # 或 node scripts/canary-replay.mjs <log> [...]
node scripts/canary-replay.mjs --all --sessions-root /path/to/.dsh/sessions
```

会话目录默认 `~/.dsh/sessions`（`os.homedir()`），用 `--sessions-root` 指定其他位置；不再读取 `DSH_HOME`/`HOME` 环境变量。需要宿主之外的 `zstd` 可执行文件（会话日志是 `.jsonl.zstd`）；`scripts/canary-replay.mjs` 随包发布，`npm run canary:replay` 在安装后的包里同样可用。

实测（12 个最大的真实 DSH 会话，共 1.33M tool-result token）：8 个会话有候选、14 个 turn 边界出批次、11 个过闸门、合计 124,669 token、最大单批 73,646 token；4 个会话从头到尾 0 候选。

## 与宿主的分工

- 宿主 `compaction-basic` 在约 80% 占用时压缩整窗，`tool-result-pruner` 在压缩后把超长 tool result 切成头尾。插件不重复这两件事。
- 插件的停手线是 60%：再往上让宿主接手，避免两边在同一段前缀上打架。
- 模型侧永远能按指针重取；`cleanup` 工具仍保留为手动逃生通道。

## 索引与清理结果

消息投影只改模型可见副本，索引必须与它一致——否则模型会看到它已经读不到的正文的 preview。因此 `dsh/index.ts` 的 `clearedMarksOf()` 把日志里的 `plugin:oh-my-clm/clear` 折成 `dsh:<seq>` → `{ label, tokens }`，传给 `renderBlockIndex` / `renderBlockDigest`：

- `blocks` 模式：该行变成 `12. toolResult: [cleared 3.4k tok · read src/x.ts:120-260]`；
- `digest` 模式：该 turn 的估算 token 扣除已清部分，并附 `, 1 cleared`；
- 两种模式的 header 在 `autoClear.enabled` 时改为说明 `[cleared]` 行是重取指针而非正文；
- 索引缓存的失效键里多了 `clearedCount`，新增一条清理记录会在同一步内重渲染。

## 未做

- 错误率回退熔断：需要"清理前后工具错误率"基线，未标定。
- Pi 侧对等实现：Pi 的 seam 是 `turn_end` + mirror 改写，与消息投影不是一套东西；本通道只落 DSH。
- 清理后按指针自动预取：重取仍由模型按需发起，插件不去猜。
