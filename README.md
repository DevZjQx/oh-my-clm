# oh-my-clm

Pi extension + DSH/Cordis plugin。DSH 侧默认关闭一条**自动清理**通道：`turn/end` 把已被同一目标取代的 `read`/`grep`/`glob` 结果换成一行重取指针，记录是 log-only 的 `ignorable` plugin record，消息投影只改模型可见副本；会话日志、surface 和人类 transcript 都不动。手动路径仍保留 mirror + `cleanup`。

## 自动清理（DSH，默认关闭）

`autoClear.enabled: true` 时每个 `turn/end` 结算一次：只清被同一目标后续调用取代的块，闸门 1200 token、2 块或死内容占当前 prompt 的 5%，占用 ≥60% 停手交给宿主 compaction，重读率过高会熔断。结算点留在 turn 边界是因为一次断点要摊到整批块上（实测 4.4 块/批 vs 按步 2.3 块/批，同样的内容多付 31% 重算）；`autoClear.midTurnSuffixTokens` 可单独放开“尾部极短且一个请求内回本”的单块例外，而计时器（`completedSteps` / `stepsSinceCleanup` / `stepsOld`）按步数计。`autoClear.canary: true` 只记账不执行；`npm run canary:replay` 可离线跑已存会话。详见 [自动清理](https://github.com/DevZjQx/oh-my-clm/blob/main/docs/features/auto-clear.md)。

## 手动通道：mirror 与 cleanup

```text
Pi projection ──► /tmp/clm-${sessionId}/LIVE_CTX_MAIN.md ◄── 模型 edit / cleanup
                              │
                              ▼
                 snapshot / 结构 / 配对 / shrink-only 校验
                              │
                              ▼
          Pi: context_edit          DSH: Session.append() replacement
```

- **Pi**：`turn_end` 把 mirror 差异提交为 branch-local `context_edit`；`/tree`、fork、resume 仍由 Pi 处理。
- **DSH**：通过 `Session.append()` 的 `surfaceOp: { op: "replace" }` 改写当前 active surface；append-only session log 保留原始事件。
- **cleanup**：在 host 侧按 1-based editable block ID 直接删除或软卸载，不读取 block body，不受 preview 截断影响。
- **block index**：DSH 把可操作的 ID 区间放进 runtime context；默认 `digest`，每个已完成 turn 一行。
- **自动清理**（DSH，默认关）：turn 边界把被后续调用取代的 tool result 换成 `[cleared … re-read if needed]` 指针，通过宿主消息投影实现——会话日志与人类 transcript 都保留原文。需要宿主提供 `appendPluginRecord` seam（`dsh-session` ≥ 0.2.2-rc.1），否则该通道保持关闭。

## 安装

npm 主包同时包含 Pi extension 与 DSH bundle。

```bash
# Pi：写入 ~/.pi/agent/settings.json；加 --local 写入项目 .pi/settings.json
pi install npm:oh-my-clm
pi install git:github.com/DevZjQx/oh-my-clm

# DSH：安装到指定 profile
dsh plugin --profile <profile> add oh-my-clm
dsh plugin --profile <profile> add github:DevZjQx/oh-my-clm

# 卸载
pi remove npm:oh-my-clm
dsh plugin --profile <profile> remove oh-my-clm
```

固定版本：npm 用 `oh-my-clm@<version>`，GitHub 用 `#<ref>`。DSH 不读取 Pi 设置；安装后重启对应宿主。

从源码试运行：

```bash
pi --extension ./extensions/clm.ts
pi -e .
```

## 使用

整理历史优先用 `cleanup`，一次调用批量给出所有目标：

```text
cleanup({ blockIds: [2, 3, 4] })
cleanup({ ranges: ["3-16"], skipRoles: ["user"] })
cleanup({ offload: [{ blockId: 2, note: "旧测试在 X 上失败，已修" }] })
cleanup({ list: "3-16" })
```

只有需要完整、未截断的正文做 rewrite 时才读 mirror。命令：

```text
/clm
/clm status
/clm mode [blocks|digest|auto]   # 仅 DSH
```

`/clm mode` 是当前进程级覆盖，从下一步生效，重启后回到配置文件的 `index.mode`。没有 `/clm refresh`、`/clm export` 或专用 `/clm-compact`；手动压缩使用宿主原生的 `/compact`。

## 行为约束

1. **mirror 只是编辑面。** 原始 session JSONL / DSH session log 是事实来源；只有当前 projection / surface 被替换。
2. **只改 body。** 保留 `clm-v2`、`CLM_SNAPSHOT`、`CLM_ENTRY` 与 closing marker；body 中形似协议的行保留前导反斜杠。
3. **ID 是 1-based 编辑序号。** 不改 ID、不重排 block；block 1 在 `cleanup` 和 mirror 编辑两条路径上始终保留。
4. **user-authored block 只能省略，不能改写。** 其他 block 可缩短或删除。
5. **所有编辑必须严格缩短上下文。** shrink-only 固定开启；不能安全缩短的编辑整体拒绝，不部分应用。
6. **截断 preview 不能被改写。** 只能省略该 block 或使用 `cleanup`，否则中间未显示内容会永久丢失。
7. **tool 配对级联。** 改写/删除带 tool call 的 assistant block 时，配对的 tool result 一起省略；反向删除 tool result 也会删除 owner assistant。
8. **删除最后一个可编辑 block 时保留 `<!-- CLM_EMPTY -->`。**
9. **非法编辑整体拒绝。** 缺少 header、stale snapshot、未知/重复 ID、role 变化、协议损坏都会拒绝并给出 reason。
10. **mirror 自读不回灌。** 读取 `LIVE_CTX_MAIN.md` 的 tool result 会在后续 projection 中替换为短指针。
11. **turn 外修改会被恢复。** 非 agent turn 内写入 mirror 的内容不会进入 session；下一次同步恢复 canonical projection，并给出一次性 edit notice。
12. **Pi 的 cleanup 顺序。** 一个 step 最多一次 cleanup，且必须在该 step 的任何 mirror 编辑之前。

## 配置

不再读取任何 `CLM_*` 环境变量。配置是一个 JSON 文件，按会话工作目录解析：

1. 用户级 `$XDG_CONFIG_HOME/oh-my-clm/config.json`（未设或非绝对路径时为 `~/.config/oh-my-clm/config.json`）；
2. 项目级 `<cwd>/.oh-my-clm.json`，逐 key 覆盖用户级。

`XDG_CONFIG_HOME` 只决定用户级文件的位置（标准 XDG 语义），不是插件开关：没有任何配置*值*来自环境变量。

只写需要改的 key；其余取默认值。非法值回退到默认值并写一条 warning，不会因为一个拼写错误让插件整体失效。每次请求都会重新读文件，所以改完不需要重启宿主。

```json
{
  "context": { "budgetTokens": 32000 },
  "index": { "mode": "digest" },
  "cleanup": {
    "cacheDiscountPercent": 2,
    "paybackTurns": 10,
    "trigger": { "usagePercent": 70, "stepsSinceCleanup": 40 }
  },
  "autoClear": { "enabled": false, "canary": false }
}
```

| 配置项 | 默认 | 作用 |
| --- | --- | --- |
| `context.budgetTokens` | `0` | Pi 侧近似目标 token；`0` 表示不设显式预算。用量达到约 `0.75 × max(1, budget − 2048)` 时追加同请求 budget nudge。 |
| `context.windowTokens` | `0` | 宿主不提供窗口时的兜底；未知时用量行写 `window unknown`。 |
| `context.fixedTokens` | `0` | DSH 额外计入 shrink-only gate 的固定 token。 |
| `context.maxBlockChars` | `12000` | 单个 block 的 preview 上限。 |
| `context.maxMirrorChars` | `96000` | 全部可编辑 preview 的总上限。 |
| `index.mode` | `digest` | 索引形状：`digest` 或 `blocks`。 |
| `index.previewChars` | `64` | `blocks` 模式每行 preview 字符数。 |
| `index.headBlocks` | `12` | 列表开头保留的 block 数。 |
| `index.tailBlocks` | `40` | 列表尾部窗口宽度。 |
| `index.maxLines` | `40` | `digest` 模式最多列出的 turn 数。 |
| `index.refreshSteps` | `4` | 同一 turn 内最多每几步重渲染一次；`1` 为每步刷新。 |
| `cleanup.resultMode` | `compact` | DSH 结果模式：`compact` / `full` / `none`。 |
| `cleanup.cacheDiscountPercent` | `2` | 缓存命中价占全价的百分比（`2` = 1/50），即候选成本公式中的 `r`。 |
| `cleanup.paybackTurns` | `10` | 断点成本摊到**多少次后续请求**（一次请求 = 一步），即公式中的 `N`。按轮理解会高估成本：一个 turn 实测 11–39 步。 |
| `cleanup.paybackSteps` | `0` | 显式请求数（horizon），覆盖 `paybackTurns`；`0` = 不设。 |
| `cleanup.trigger.usagePercent` | `0` | 用量达到窗口百分比时触发候选；`0` 关闭。 |
| `cleanup.trigger.completedTurns` | `0` | 已完成 turn 数达到该值时触发。turn 太粗（实测 11–39 步），优先用 `completedSteps`。 |
| `cleanup.trigger.completedSteps` | `0` | 已完成 step（请求）数达到该值时触发。 |
| `cleanup.trigger.toolResultSharePercent` | `0` | toolResult 占可编辑 token 的百分比达到该值时触发。 |
| `cleanup.trigger.turnsSinceCleanup` | `0` | 距上次成功清理的 turn 数达到该值时触发。 |
| `cleanup.trigger.stepsSinceCleanup` | `0` | 距上次成功清理的 step 数达到该值时触发。 |
| `cleanup.trigger.maxCandidates` | `3` | 一次触发最多给出的候选区间数。 |
| `cleanup.trigger.minSavingsTokens` | `0` | 小于该估算 token 的 turn 不作为候选。 |
| `autoClear.enabled` | `false` | 真正清理：把被取代的 tool result 换成重取指针。 |
| `autoClear.canary` | `false` | 只记录自动清理决策到 `CANARY.jsonl`，不改模型输入。 |
| `autoClear.minTokens` | `1200` | 一批至少释放的 token；低于它不值得断一次前缀。 |
| `autoClear.minBlocks` | `2` | 或者至少这么多个死块。 |
| `autoClear.minSharePercent` | `5` | 或者死块占当前 prompt 的百分比达到该值；`0` = 只按量。这是抗 rot 判据，不是省钱判据。 |
| `autoClear.stopPercent` | `60` | 占用达到窗口百分比即停手，交给宿主 compaction。 |
| `autoClear.maxTokens` | `40000` | 单会话累计清理上限。 |
| `autoClear.midTurnSuffixTokens` | `0` | 允许在 turn 内清理：死块之后待重算的尾部 ≤ 该 token 数即可，不再要求回本。`0` 关闭。 |
| `host.pluginRecordModule` | `@deepseek-ai/dsh-session` | 提供 `appendPluginRecord` seam 的宿主模块；高级/测试用。 |

自动清理的记录必须是宿主可忽略的 plugin record，所以它需要宿主提供 `appendPluginRecord`（`@deepseek-ai/dsh-session` ≥ 0.2.2-rc.1）。插件目录解析不到宿主包，所以解析器会再从宿主入口（`process.argv[1]`，即 `dsh/lib/bin.js`）和全局模块根兜底；解析出的模块必须是会话所用的同一份 `dsh-session`（否则私有字段写入会失败），导出 `Session` 时会在写入前比对原型。仍然解析不到时插件不会退回 `session.append()`（那会让含记录的会话在重启后被宿主拒绝恢复），而是保持关闭：会话创建时 warn 一次，`/clm` 显示 `stopped (unrecordable)`。`autoClear.canary` 只写 `/tmp/clm-<session>/CANARY.jsonl`，不需要该 seam。

所有触发阈值默认关闭（`0`）。命中后只在该 turn 边界装配一次用量行和候选；候选只取已完成的 turn，按断点后的净收益排序，并固定带 `skipRoles: ["user"]`。Pi 侧另认 `cleanup.trigger.stepsSinceCleanup`（回退 `turnsSinceCleanup`）与 `cleanup.trigger.toolResultSharePercent`，预算 nudge 与 DSH 共用同一套用量行/候选格式。

**计数单位**：陈旧度信号（`completedSteps` / `stepsSinceCleanup` / 候选的 `stepsOld` / 摊销 `N`）按 step 计，因为一个 turn 实测 11–39 步；批次结算、闸门、预算和候选区间仍按 turn，因为一次断点必须摊到多个块上。实测依据见 [自动清理](./docs/features/auto-clear.md#结算点为什么批次价格按-turn-算)。

## DSH 适配

- 发现入口：`dsh-plugin.json`；host entry：`dist/dsh/index.js`；官方安装元数据：`package.json` 的 `dsh.bundle.patch` 与 `cordis.patch.yml`。
- 使用 Cordis 的 `agent/created`、`agent/pre-step`、`session/event`、`systemPrompt.section()`、`systemPrompt.context()`、`tools.register()`；不启动独立 agent loop，不扫描 JSONL。
- `sessionProjections` 通过 `ctx.get("sessionProjections")` 读取，不进 `inject`；服务缺失时只降级用量行。
- 删除写入空 `developer/message` omission；assistant 改写写缩短文本的 `developer/message`；tool result 改写保持原 envelope，只替换 `content`。`assistant/message` 不能作为 replacement。
- 所有 replacement 必须在打开的 turn/step 内执行；没有打开坐标时拒绝 mutation，而不是写入过期事件。
- 自定义 `source.kind`（`oh-my-clm:model-mirror-edit` / `oh-my-clm:runtime-cleanup`）在真实 DSH profile 上的接受度仍需发版前复核。

打包：

```bash
npm run build:dsh:plugin
# 默认输出 artifacts/oh-my-clm-<version>.tgz
node scripts/build-dsh-plugin.mjs --output ./out/oh-my-clm.tgz
```

专用包只含 DSH host、`dist`、manifest、bundle patch、locale、icon；普通 `npm pack` 仍生成 Pi + DSH 完整包。

## 开发

```bash
npm test
npm run check
npm run typecheck
npm pack --dry-run
```

依赖方向固定为 `shared (src/lib) → features (src/features/live-context) → host adapters (extensions, dsh)`。feature 之间不互相导入，host adapter 不承载可复用业务逻辑，不使用 barrel 文件；`npm run check` 会验证这些边界。目录与测试布局见 [项目结构](https://github.com/DevZjQx/oh-my-clm/blob/main/docs/project-structure.md)。

## 文档

- [Live context mirror](https://github.com/DevZjQx/oh-my-clm/blob/main/docs/features/live-context-mirror.md)：Pi 侧 mirror 生命周期、文件协议与校验。
- [Cleanup 与 block index](https://github.com/DevZjQx/oh-my-clm/blob/main/docs/features/cleanup-tool.md)：工具契约、索引、结果模式与配置。
- [DSH surface bridge](https://github.com/DevZjQx/oh-my-clm/blob/main/docs/features/dsh-surface-bridge.md)：Cordis 生命周期与 surface replacement。
- [自动清理](https://github.com/DevZjQx/oh-my-clm/blob/main/docs/features/auto-clear.md)：`autoClear.canary` / `autoClear.enabled`、选择器口径、投影契约、闸门与熔断、离线重放。
- [项目结构](https://github.com/DevZjQx/oh-my-clm/blob/main/docs/project-structure.md)：分层、导入规则、测试与生成物。
- [架构图](https://github.com/DevZjQx/oh-my-clm/blob/main/diagrams/oh-my-clm-plugin.svg)：两个宿主、feature 分层与自动清理链路（源文件在 `diagrams/`）。
- [更新日志](https://github.com/DevZjQx/oh-my-clm/blob/main/changelog.md)。

## 边界

不实现独立 agent runtime、rollback/retry harness、trajectory export、receipt store 或 `dsh-ops` 的工具矩阵。自动清理默认关闭，且**不承诺省算力**：在缓存命中价 0.02× 的端点上去掉断点之后的 token，省下的钱通常抵不过断点重算；它解决的是上下文腐烂，不是账单。token 估算不是 provider 精确 tokenizer，只用于编辑前后比较；宿主窗口仍是硬约束，超限交给宿主原生 auto-compaction / `/compact`。mirror 可能含 reasoning 与 tool output，由宿主负责临时文件生命周期与内容审计。
