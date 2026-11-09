# 审查整改计划（oh-my-clm 0.1.12）

> 追加（2026-11-09）：§5 新增「让 DeepSeek-V4.1-Flash 主动清理上下文」方向，六步按 1~6 顺序排期；**5.1 已实施**（用例 10 红灯转绿），**P1-2 的宿主 usage 校准 + 上限双检已补**（5.2 前置，见 §1 P1-2 实施记录），**5.2 已实施**（用例 11 红灯转绿；触发阈值默认关闭，待真实 V4.1-Flash 会话标定），5.3~5.6 尚未实施；§1~§4 的结论不变。
> 状态：评审草稿 / 整改已完成（验收部分）
> 整改状态（2026-11-09）：§3 的 11 条回归用例，以及一次推送前复核新增的 5 条回归（P1-1 守卫收窄 4 条、I-2 触顶重置 1 条）全部转绿（`npm test` 114/114、`npm run check`、`npm run typecheck` 通过），生产代码与文档已同步；逐项说明见 `changelog.md` 的「0.1.13（当前版本）」。**回归用例转绿不等于第 1 节打回项全部结案**：P1-2 的「宿主 usage 校准 + 估算/上限双检」已实现（2026-11-09，Pi `getContextUsage()` 与 DSH `sessionProjections` 的 `tokenUsage` / `contextPressure` 进入共享门；`npm test` 118/118），§5.2 的用量行与候选触发仍未做；P1-3 的「编辑 diff/审计/最小回滚、审批/签名」仍未实现（P1-3 只落地了运行时来源标签 + 显式保留字黑名单，不是对任意注入指令的内容审计）；§2 改进项中 I-1、I-2 已修，I-3~I-9 及「规则外清单」（安全姿态、真实宿主行为、撤除试验、维护代价）仍需人工复核 / 排期。
> 审查对象：当前 checkout（`package.json` 0.1.12，HEAD `b14b187`）
> 依据：`http://127.0.0.1:3080/dsh-zdiary-kit/view` 的 101 篇笔记（只读知识库，**仅作参考，不作准**）、本仓库源码与文档、仓库自带的 CLM 自评表。
> 自动化基线：`npm test` 98/98 通过、`npm run check` 通过、`npm run typecheck` 通过。
> **下列缺陷均不在现有断言覆盖范围内**——现有测试只核"写下来的规则"，这正是笔记《评估器只核对硬规则，没进规则的代价得人看》所指的盲区。

## 0. 判定口径

- **打回**：违反代码或文档已承诺的硬不变量，或可复现的正确性 / 安全 / 契约缺陷。每条必须给出**复现**与**验收标准**。
- **改进**：不阻断交付，但属于"规则外维度"（安全姿态、复杂度、真实宿主行为、维护代价），需人复核后排期。对应笔记《Practical Loop Engineering》《规则外的代价要人看》的分法。
- 笔记中自标"打折扣 / 存疑"的数字（CLM 零样本收益、五项基准第一、"18 倍"、100 仓库审计）一律不作判据。判定全部落在**插件代码 + 插件自身文档 / 自评表**可验证的范围内。

## 1. 打回清单

### P1-1 改写被截断的 preview 会静默毁掉 canonical 正文（数据丢失）

- **现象**：大 block 的 mirror 只显示 head+tail 截断副本；模型改写该 body 后，截断副本成为新的 canonical 正文，中间内容永久丢失，且因为变短而通过 shrink-only 门。
- **证据**：`src/features/live-context/context-format.ts:366-388`（`compactMirrorText` / `applyMirrorDisplayBudget` 生成 `renderText`）；`src/features/live-context/context-format.ts:1223-1231`（`renderedBaseline !== body` 即 `replace`，替换内容为截断 body）；`src/features/live-context/context-format.ts:1305-1315`（shrink 门）。`README.md:55`、`docs/features/live-context-mirror.md:175/279` 把"截断只影响显示，不改变 canonical source"列为不变量，但只在模型不改该块时成立。
- **复现**：构造 20,018 字符的 toolResult（`maxBlockChars: 500`），渲染得到含 `...[oh-my-clm mirror preview truncated; ...]...` 的 mirror；在截断 body 中插入一行短文本后调用 `planContextEdits(records, parseMirror(edited), { allowGrowth: false })`。实测 `status: applied`，`before/after = 5724/157`，替换文本只含 head+tail，**中间 20,000 字符不在其中**。
- **要求**：`renderText !== undefined` 的块禁止被改写；或提供"取完整正文"的显式通道，并在编辑规划层校验 body 与 canonical 的比例/来源。
- **验收**：新增回归测试断言"编辑截断块 → `rejected` 且 reason 可行动"；`planContextEdits` 对含截断 marker 的 body 一律不产出 `replace`；文档改为如实描述"改写截断块会丢失未显示内容"。

### P1-2 shrink-only 安全门用固定 3.5 chars/token，可被换语种绕过；assistant 字符串正文计 0

- **现象**：唯一的编辑安全门基于 provider-independent 字符估算，中文/emoji/JSON 等脚本下估算与真实 token 严重偏离；assistant 消息 `content` 为字符串时估算直接为 0。
- **证据**：`src/features/live-context/context-format.ts:889`（`CHARS_PER_TOKEN = 3.5`）、`:950-993`（`estimateMessageTokens`，assistant 分支 `:968-982` 只处理数组 content）；`extensions/clm.ts:95-97`、`src/features/live-context/dsh-bridge.ts:583-591` 均以此估算作为 shrink 门；`README.md:180` 自承 `fixedRequestTokens` 不完整。
- **复现**：
  - `estimateMessageTokens({role:'assistant', content:'x'.repeat(350)})` → `0`；同形状 `user`/`toolResult`/`system` → `100`。
  - 100 个 ASCII 字符替换为 90 个汉字：估算 `31 → 28` 判定"收缩"并 `applied`，真实 token 反而增长数倍。
  - 删除一个字符串正文的 assistant block：`before/after` 相同（都计 0）→ 合法清理被 `A compaction must SHRINK context` 误拒。
- **要求**：优先用宿主精确数据（Pi `ctx.getContextUsage()`、DSH 的 `cacheReadTokens` / `uncachedInputTokens` 与 `usage`）校准；至少补 CJK 感知估算、修复 assistant 字符串正文为 0 的分支，并把安全门从"近似估算"降级为"估算 + 宿主上限双检"。
- **验收**：补跨语种、assistant 字符串正文、图片/toolCall 形状的估算测试；新增"换语种增长"与"删除 0-token 块误拒"两条回归；README 明确估算不是 provider tokenizer。
- **实施记录（2026-11-09）**：`EditPlanOptions.hostUsage` / `CleanupPlanOptions.hostUsage` 与共享的 `calibrateWithHostUsage` 已落地——估算只保留有符号 delta，`beforeTokens` 与硬上限取自宿主精确值；校准后编辑用量仍高于窗口的 95%（`HOST_CAP_HEADROOM`，待 V4.1-Flash 会话标定）即拒绝，大 cleanup 能把用量降到水位以下则放行，避免高水位死锁。Pi 从 `ctx.getContextUsage()` 采集；DSH 从 `sessionProjections.snapshot(session, keys)` 的 `tokenUsage`（`cacheReadTokens + uncachedInputTokens`）与 `contextPressure.contextWindow` 采集，服务缺失时 status 显式标 `~` 降级；`CLM_CONTEXT_WINDOW` 作为窗口兜底。`planContextEdits`、`planCleanup` 与 DSH 的 mutation 门共用同一函数。新增红灯用例（`plan §5.1 gate (P1-2)`）先红后绿，另有 DSH 采集链路测试；`npm test` 118/118、`npm run check`、`npm run typecheck`、`npm pack --dry-run` 全通过。

### P1-3 写权限 = 安全边界，但缺写入时溯源 / 分区 / diff / 回滚；仓库自评表已承认

- **现象**：body 只做结构校验，任意文本（含注入指令、模型自写的越权指令）都会被持久化进后续上下文；DSH 侧还把模型改写文本标成 `user` 来源；Pi 侧把运行时通知/nudge 注入成合成 `user` 消息。
- **证据**：`src/features/live-context/context-format.ts:1213-1232`（任意 body → `replace`）；`src/features/live-context/dsh-bridge.ts:395-413`、`:442-465`（`developer/message` + `source: {kind:"user"}`）；`extensions/clm.ts:407-426`（`role:"user"` 合成消息，不写 session history）；`README.md:205-209`（承认归因丢失）、`README.md:262`（明确不做 receipt store / rollback）。
- **仓库自身结论**：`docs/reference/clm-technical-analysis.md:39` 原文"**无来源标签/审批/签名**……必须配合内容来源标记、不可伪造的用户消息、权限隔离、审计和回滚策略"；`:20`"生产化仍需要更强的结构化上下文编辑协议、权限/审计、缓存精确性保证"。
- **参考笔记**：《可编辑上下文是活的注入通道，写权限就是安全边界》《溯源要在写入时钉死：事后内容扫描守不住被投毒的记忆》。两篇都强调防护必须落在"谁能写、写到哪、有没有来源"这一刻；前者还指出 CLM 论文只把这条列为 future work，没有方案。
- **要求**：
  1. 加模型改不动的**封闭来源字段**（owner / agent / untrusted / system 一类），由代码写入、不从正文解析；
  2. **分区**：系统指令与安全策略只能由运行时写，模型可改区只放历史正文；
  3. 每次编辑留 **diff（谁、何时、改哪段）** 并提供最小回滚；
  4. 运行时生成的通知/nudge 改 `system`/`developer` 角色，不冒充用户消息。
- **验收**：新增"来源字段不可被 body 伪造"测试、diff 可回放测试、DSH replacement 的 `source` 不再为 `user`；`docs/reference/clm-technical-analysis.md` 的"安全与治理"行从 ◐ 升级并有证据。

### P1-4 保护前缀在 compaction 后消失；mirror-edit 删块没有 block-1 守卫

- **现象**：出现 compaction summary 后所有 record 变 unprotected，初始用户任务进入可编辑区并可被删除；另外 `cleanup` 工具保留 block 1，mirror 编辑路径却不保留。
- **证据**：`src/features/live-context/context-format.ts:345-351`（`hasCompaction ? records : 保护首个 user`）；`src/features/live-context/context-cleanup.ts:417`（`preserveFirstBlock` 仅在 `planCleanup`）；`planContextEdits` 全文无 block-1 守卫。`README.md:54` 承诺"初始用户任务受到保护，不会出现在可编辑区域中"，`README.md:56`/`docs/features/cleanup-tool.md:144` 承诺"load-bearing block 1 始终保留"。
- **复现**：
  - 带 `compactionSummary` 的 projection → `user:false`，mirror 含 `Initial task: do X`；删掉该 span → `applied`，`omitted:['e1']`，`before/after = 10/4`。
  - 普通（无 compaction）projection，数组正文：删 mirror 中 `id=1` 的块 → `applied`（`before/after = 14/8`）；同一块走 `planCleanup([1])` → `rejected: Cleanup preserves load-bearing block 1.`
- **要求**：compaction 后仍保留受保护锚点（首条 user 或 summary 本身）；把 block-1 保留下沉到共享编辑规划层，让两条删除路径一致。
- **验收**：新增"compaction 后初始任务不可删""mirror 编辑删 block 1 被拒"两条回归；`docs/features/live-context-mirror.md:165` 的例外说明补齐理由或删除。

### P1-5 `CLM_CLEANUP_RESULT=none` 把拒绝也吞成空串

- **现象**：copy 模式为 `none` 时，被拒绝的 cleanup 返回空字符串，模型看不到失败原因，无法采取下一步。
- **证据**：`src/features/live-context/context-cleanup.ts:713`（`if (copy === "none") return "";` 在状态判断之前）；`README.md:234` 把 `none` 描述为"只抑制删除/拒绝确认"；测试 `test/features/live-context/context-cleanup.test.ts:196` 只覆盖 applied→`""`。与 `changelog.md:18`（0.1.11 特意加 `<pi-clm-edit-notice>`，"被回滚的 mirror 编辑会告知模型"）自相矛盾。
- **复现**：`formatCleanupToolResult({status:'rejected', reason:'Unknown cleanup block ID: 99.', copy:'none'}, 'none')` → `""`；同值 `compact` → `cleanup rejected; Unknown cleanup block ID: 99.`
- **要求**：`none` 只压成功确认；`rejected` / `listed` 必须始终可见。
- **验收**：补"rejected + none 仍返回 reason"回归；README/changelog 口径统一。

### P1-6 权限声明与实际行为不符，且声明的隔离不生效

- **现象**：社区 manifest 声明读写范围 `workspace`，实际写入系统临时目录；文档自己说明该权限不是运行时强制隔离。
- **证据**：`dsh-plugin.json:14-24`（`scope: "workspace"`）、`src/lib/clm-paths.ts:4`（`CLM_TEMP_ROOT = "/tmp"`）、`README.md:195`、`docs/features/dsh-surface-bridge.md:14`。
- **要求**：按实际边界据实声明（host temp）并去掉"隔离"暗示，或真正落地该权限；提交插件清单时不能保留装饰性 permission。
- **验收**：`test/package/dsh-manifest.test.ts` 增加权限 scope 与实际写入根目录的一致性断言；`cordis.patch.yml` 与 manifest 口径一致。

## 2. 改进清单

> 不阻断交付，但需排期；其中"规则外维度"必须由人复核，不能只靠加测试。对应笔记《监督的瓶颈是检查带宽》《经验要带产物和外部证据，才进得了训练》《配置按半衰期管理》。

| # | 项 | 证据 | 动作 | 优先级 |
|---|---|---|---|---|
| I-1 | Pi 扩展状态是模块级全局，未按 session 分键 | `extensions/clm.ts:248-252`；DSH 已按 session 分键 `dsh/index.ts:459`、`changelog.md:93` | 改为 `Map<sessionId, State>`；新增多 session 交错测试（现有测试全为单 session） | 高 |
| I-2 | 预算 nudge 无停止条件、去重守卫失效 | `extensions/clm.ts:364-380`（nudge 不写 history，`messages.some(含 marker)` 永远看不到自己的 nudge）；`docs/features/dsh-surface-bridge.md:85`（DSH 无预算机制） | 加"每轮必须进步 / 连续两轮不进步即中止 / 轮数上限"四件套（笔记《Practical Loop Engineering》）；DSH 补预算或显式声明不提供 | 高 |
| I-3 | `/clm mode` 为进程级全局覆盖 | `dsh/index.ts:117/374-375`、`README.md:148`（自承影响所有 session） | 改为 session 级 override；按笔记《harness 的边界画在进程和终端上》把共享事实与会话状态分开 | 中 |
| I-4 | 无 diff / 审计 / 回滚，改写是单向棘轮 | `docs/features/live-context-mirror.md:190`（"恢复原文只能靠原始日志或 branch 切换"）、`README.md:205-209`（DSH 改写后不再进 mirror，连 cleanup 都碰不到） | 编辑留痕 + 最小回滚命令；文档明确"改错只能靠宿主日志"的代价 | 高 |
| I-5 | 未验证边界缺外部证据 | `docs/features/dsh-surface-bridge.md:97-101`（真实 DSH 持久化、`session/flush`、restart recovery、fork/surface、sandbox `/tmp`、模型是否真会用 turn-level cleanup）、`docs/reports/README.md:15` | 补真实 profile 验证报告；做**撤除试验**（关掉插件跑同一批长任务 A/B，笔记《可学性要在撤掉脚手架之后量》《配置按半衰期管理》），并同时报准确率、成本、延迟、安全 | 高 |
| I-6 | 代价不可观测 | `docs/reference/clm-technical-analysis.md:34-36/43`（Prefix-reuse FLOPs、SCR、ATIF-CTX 全 ❌；14 项中 ✅ 仅 2 项）、`docs/reference/dsh-prefix-cache.md:39`（改前缀导致全量 miss） | 至少记录编辑位置/频率与宿主 cache-hit 变化；加编辑位置护栏；README 显式写明"不承诺省算力"。笔记《上下文管理该归模型自己》《CLM 源笔记》把"代价要可算"列为三条硬约束之一 | 高 |
| I-7 | 提示词与文档口径互相矛盾 | `extensions/clm.ts:174`（"do not read or print the file" 与 "rewrite only from a complete current body"、self-read 保护并存）；`README.md:234` 说 Pi 固定 `full`，实际 `cleanupToolResult` 默认 `compact`（`context-cleanup.ts:659`）；`dsh/index.ts:351` 的 `?? "blocks"` 与默认 `digest` 不符 | 统一口径；提示词长度守卫（`extension.test.ts` / `dsh-bridge.test.ts`）继续生效 | 中 |
| I-8 | 静默失败与临时文件生命周期 | `dsh-bridge.ts:226-245`（索引节流最多 4 步返回旧文本，注释自承"可 omit newer blocks"）；`dsh/index.ts:221-223`（`catch { return "" }`，索引无声消失）；`README.md:184`（`/tmp/clm-*` 清理推给宿主，shutdown 无清理，内含 reasoning / 工具输出） | 异常时记日志并显式标记 stale；session shutdown 清理或加 TTL。笔记《常驻记忆的容量上限要对 agent 可见》《记忆的主键别绑在检索索引上》都强调"静默空/静默丢最贵" | 中 |
| I-9 | 可编辑范围远窄于 CLM，对外定位需诚实 | `docs/reference/clm-technical-analysis.md:28/31`（不能新增/重排、无 fit 模式、user 只能省略、tool 结构被压平） | 明确写成"受限 live-context 层"；不要迁移论文"更准更省"结论（笔记《CLM 源笔记》已标 9B 两处口径 28.8 vs 34.7 / 39.9 vs 37.7 不一致、弱模型结论不成立） | 中 |
| I-10 | 把打回项写成回归测试 | `npm test` 98/98 全过却未覆盖上述任何一条 | 每条打回项至少一条断言；维护一张"规则外清单"（安全姿态、复杂度、真实宿主行为、维护代价）由人复核，对应笔记《规则外的代价要人看》 | 高 |

## 3. 验证方式

整改后按现有开发检查全跑一遍，并补充回归：

```bash
npm test
npm run check
npm run typecheck
npm pack --dry-run
```

需新增的回归用例（对应第 1 节）：

1. 编辑含截断 marker 的 body → `rejected` 且 canonical 不丢；
2. `estimateMessageTokens` 对 assistant 字符串正文、CJK、emoji、toolCall 形状的估算一致；
3. 换语种使真实 token 增长的编辑被拒；
4. 来源字段不可由正文伪造；DSH replacement 的 `source` 不为 `user`；
5. compaction 后初始任务不可删；mirror 编辑删 block 1 被拒；
6. `rejected` + `CLM_CLEANUP_RESULT=none` 仍返回 reason；
7. manifest 权限 scope 与实际写入根目录一致；
8. 多 session 交错时 `state` 不串台、通知不送错会话；
9. nudge 连续无进展时中止（轮数上限 / 连续两轮不进步）。

> 笔记《Practical Loop Engineering》的建议在这里适用：把验证写成可重复执行的程序（起真实宿主、跑 cleanup、看结果），而不是"你检查一下"。
>
> §5 六步的红灯用例接在上面 9 条之后编号 10~15，写在各步的「红灯」行内（不重复列出）。进入整改时先让这些断言变红、确认 `npm test` 失败，再动生产代码；本次只修改计划文档，不改任何生产代码。

## 4. 参考笔记（仅作视角，不作判据）

全量查看了 `/dsh-zdiary-kit/view` 的 101 篇笔记（8 篇日记 + MEMORY.md + 搜索/标签页），与本题相关的主要是：

- 《CLM：把上下文当文件交给模型自己改，零样本就赢过所有 harness 压缩策略》
- 《上下文管理该归模型自己，harness 只保证改动能同步回活上下文》
- 《可编辑上下文是活的注入通道，写权限就是安全边界》
- 《溯源要在写入时钉死：事后内容扫描守不住被投毒的记忆》
- 《常驻记忆的容量上限要对 agent 可见》《记忆写入用 schema 定字段与合并方式》
- 《生产记忆系统的共同骨架》《召回是装配一份预算内的上下文》
- 《评估器只核对硬规则，没进规则的代价得人看》《监督的瓶颈是检查带宽》
- 《Addy Osmani〈Practical Loop Engineering〉》《Addy Osmani〈Audit your Agent files〉》《配置按半衰期管理》
- 《经验要带产物和外部证据，才进得了训练》《可学性要在撤掉脚手架之后量》
- 《记忆的主键别绑在检索索引上》《跨 agent 的上下文管理，本质是给对面装一个范围受控的读窗口》

笔记自身的"打折扣"说明未采信为结论：CLM 强模型零样本收益、Atria Dawn 五项基准第一（官方口径、无第三方复现）、"18 倍"为两类百分比相除而非统计检验、100 仓库配置审计数字。

> §5 追加参考（2026-11-09，知识库已增至 115 篇，仅作视角，不作判据）：《预查注入：把资料在请求前塞好，不靠模型自觉调工具》《不思考是能力不是开关》《常驻记忆的容量上限要对 agent 可见》《召回是装配一份预算内的上下文》《门控看不到自己的盲区》《上下文缩短不等于降本》《语义层按使用者分叉》《DeepSeek-V4.1-Flash：全局 KV 压到 890 B/token》《CCM：把压缩从阈值事件改成每步动作》《ContextPilot：工具集补上记忆与软卸载》《Thinking Inertia》《同一份语义层，塞进提示掉 5 分、做成工具涨 12 分》《自演化系统的承重件是门控》《注意力的选择该由模型说出来》《上下文淘汰要在训练时模拟》。其中 CCM 零样本掉分、ContextPilot 与 CLM 的收益数字均为单实验室 / 论文自报口径，只用来定方向，不作验收判据。

## 5. 方向：让 DeepSeek-V4.1-Flash 主动清理上下文（待排期，六步按序）

> 状态：5.1~5.4 已实施（2026-11-09，用例 10~13 先红灯后转绿；5.2 的触发阈值默认关闭，待真实会话标定），5.5~5.6 待排期。对应上一轮「先定方向」的结论。本节 6 项按 §0 判为**改进 / 排期项**，不新增打回项；§1 / §2 的既有结论不变。判定仍落在插件代码 + 真实 V4.1-Flash session 日志，笔记仅作视角（见 §4 追加）。

### 5.0 方向、顺序与验收口径

**方向**：把「主动」拆成 **代码定触发 + 候选确认 + 动作归模型**。

- **触发（when）** 由插件在请求前用确定性信号判定，不占用模型判断；
- 模型不再回答开放题「要不要清」，而是**核对一份装配好的、预算内的清理候选**（具体 ID 范围 + 预计省 token + 一句理由）；
- **怎么改仍归模型**：保留否决 / 改范围，不退化成 harness 硬压缩。

依据：现在不主动并非模型特性，而是插件没有触发——DSH 静态提示结尾写着 "Nothing else is required of you."（`dsh/index.ts:158`），Pi 的 budget nudge 默认关闭（`extensions/clm.ts:71/398`）；全押在模型自发调用 `cleanup` 这个类型化新动作上，而《预查注入不靠模型自觉》《上下文管理归模型》与 ContextPilot / CCM 的零样本结果都指向「只给接口 / 只给工具不成立」。

**顺序理由（1→6 的依赖）**：

1. 先改提示词——零成本，且是后面所有触发的载体；
2. 在 DSH 落地触发 / 用量 / 候选——核心机制；
3. 把 Pi 现有的独立 nudge 收编到同一通道——双宿主一致；
4. 补软卸载，降低「删错不可逆」的风险——触发变频繁之前必须有；
5. 给新触发装审计抽查流——防止门控只学自己放行的样本；
6. 用遥测与撤除 A/B 验收全部。

> 只读的基线采集从第 1 步起**并行**开始，不占顺序；第 6 步只做对照实验与结论。

**三条硬约束（贯穿 1~6）**：

- **低频、边界触发**：DeepSeek API 命中价约为 miss 的 1/10~1/30（`docs/reference/dsh-prefix-cache.md`），cleanup 是 surface replacement，会打断前缀；《上下文缩短不等于降本》/ CCM 显示每步压缩反而更贵（Opus +31%、Kimi +106%）。**禁止「每轮主动清一次」**，只在子任务边界、一次批量。
- **目标模型标定**：阈值与 Effort 修正（max 档输出 token ≈2.5×，上下文涨得更快）只在 V4.1-Flash 上重测，不从别的模型搬（《语义层按使用者分叉》：换模型搬策略至少掉 5.7 分）。候选要做成动作层可直接确认的，不要让它先在长思维链里声明（DA 笔记：thinking 模式下声明式方案失效）。
- **动态文本 turn 内字节稳定**：候选与用量行按 turn 边界计算、turn 内不变，命中 DSH 快照去重；否则 `systemPrompt.context` 每步追加一份快照，反而给每轮加税（`dsh-bridge.ts:246-266` 的节流可复用）。

**验收口径**：不以「模型自发 cleanup 次数」为成功标准，而以 ① 触发后被执行 / 被否决 / 被改写的比例、② 上下文峰值、③ 缓存命中率（`cacheReadTokens` 占比）、④ 任务成功率 四项为准。**能力天花板写进文档**：ContextPilot 69.40、CCM+蒸馏 86.72 那种「每步自己管理」是 SFT/RL 训出来的，插件做不到；插件只承诺「触发可靠 + 确认成本低 + 代价可算」。

**开工方式（沿用 §3 口径）**：六步各自**先写红灯回归用例**、确认 `npm test` 变红，再动生产代码；本节只改计划文档。

### 5.1 提示词：删掉劝退句，补上「何时清」

- **现状 / 证据**：`dsh/index.ts:152-160` 静态段结尾 "Nothing else is required of you." 明确劝退；全段只讲「怎么清」（Prefer `cleanup` / 改 mirror body），没有一句「何时清」。`extensions/clm.ts:178-184` 的 Pi `promptAppendix` 同样是 "To free context, ..." 的条件句。静态段随 system prompt 每轮注入，是 standing tax（`dsh-bridge.test.ts` 有长度守卫）。
- **动作**：
  1. 删除劝退句；
  2. 静态段加**一条**带触发条件的策略句，例如「完成一个子任务、或收到清理候选时，用一次 `cleanup` 删掉该子任务已结算的 tool 噪声，再继续」——依据 CLM 的 in-context 指令 "Compact at sub-question boundaries"（边界压缩率 0.34→0.77）与 "Compact to 4k tokens once you reach Y tokens"（首次压缩点推到 30.9K）；
  3. 具体用量 / 候选细节**不进静态段**，留给 5.2 的动态 context；Pi 附录同步同一口径，顺手消掉 I-7 的口径不一致；
  4. 保持 `test/features/live-context/dsh-bridge.test.ts` 与 `test/adapters/extension.test.ts` 的提示词长度守卫继续通过。
- **红灯（用例 10）**：DSH 断言 `promptText()` 不含劝退句、含触发条件句、渲染长度不超上限；Pi 断言附录同口径、且不再同时出现 "do not read or print the file" 与 "rewrite only from a complete current body" 的自相矛盾。
- **依赖 / 风险**：静态段每轮都付，新增只许一句；这是 5.2 候选的载体，必须先落地。
- **实施记录（2026-11-09）**：用例 10 先写红灯断言并确认 `npm test` 失败，再改生产代码转绿——`dsh/index.ts` 删掉劝退句、两宿主各加一条「子任务边界用一次 `cleanup`」触发句、`extensions/clm.ts` 消掉 I-7 的自相矛盾（同时删去冗余的 "during an agent turn" 腾出 standing-tax 预算；self-read 保护仍由代码保证）。长度守卫 DSH 779/800、Pi 987/1000；`npm test` 116/116、`npm run check`、`npm run typecheck`、`npm pack --dry-run` 全通过。**进入 5.2 前须先补 P1-2 的宿主 usage 校准**——已于 2026-11-09 补齐（`CHARS_PER_TOKEN = 3.5` 仍用于估算 delta，`beforeTokens` 与硬上限改取宿主精确值；详见 §1 P1-2 实施记录）；具体用量 / 候选细节仍不进静态段。

### 5.2 代码侧触发 + 用量可见 + 候选装配（核心，DSH 先行）

- **现状 / 证据**：`dsh/index.ts:205-224` 的 `blockIndexContextText` 已具备「每轮现算、只作用该轮」的动态通道，`dsh/index.ts:467-475` 是现成挂载点，**不需要新宿主能力**；但 DSH 无预算机制（`docs/features/dsh-surface-bridge.md:85`、I-2），用量只在手动 `/clm status` 里出现（`dsh/index.ts:333-355`），且是 3.5 chars/token 估算（P1-2 的宿主校准已于 2026-11-09 补上，`options.hostUsage` 已可用；§5.2 只需把它显示出来并据此触发）。
- **动作**：
  1. **用量可见**：动态 context 头部加一行 `~X/Y tokens (Z%) · N editable blocks · last cleanup at turn K`；X 优先取宿主真实 usage（DSH `tokenUsage` 的 `cacheReadTokens` + `uncachedInputTokens`，或 API `prompt_cache_hit/miss_tokens`），取不到才退回估算并保留 `~` 标记，绝不静默（对应《常驻记忆上限不能静默截断》Hermes 头部 "67% — 1,474/2,220 chars"）。
  2. **触发判定（代码）**：用量 ≥ 阈值、或已完成 turn 数 ≥ N、或 `toolResult` 占比超线、或距上次清理 ≥ M 个 turn，任一命中即在 **turn 边界**算一次；阈值与 Effort 档位挂钩，在 V4.1-Flash 会话上标定。
  3. **候选装配**：命中后把已完成 turn 按「可省 token × 陈旧度」排序，取前几个组成 `ranges`，附预计节省与一句理由，写进同一个 `<oh-my-clm-block-index>`；模型只做确认 / 改范围，答案空间从开放生成降为核对（《不思考是能力不是开关》《召回是装配一份预算内的上下文》《预查注入》）。同源 V4-Flash 在《Thinking Inertia》里开放题显式推理率 99.9%、给候选答案时直答率大幅上升，是这一改形的直接理由。候选 ID 必须落在当前 editable 区间且不含 block 1。
  4. **turn 内字节稳定**：候选与用量行按 turn 边界计算、turn 内不变，复用 `dsh-bridge.ts:246-266` 的节流与快照去重；compaction / cleanup 后按 `dsh/index.ts:536-540` 的既有逻辑失效缓存。
- **红灯（用例 11）**：`test/features/live-context/dsh-bridge.test.ts` 断言「用量行含百分比」「命中阈值产出具体 ranges + 预计节省」「未命中不产出候选」「同一 turn 内渲染文本字节不变」「候选 ID 全部合法且不含 1」。
- **依赖 / 风险**：依赖 5.1 的策略句；受前缀缓存约束，只能低频触发；真实 usage 取不到时的降级必须显式标注 `~`，否则退回静默估算等于没修 P1-2。
- **实施记录（2026-11-09）**：用例 11 先写红灯断言并确认 `npm test` 失败，再改生产代码转绿。新增 `src/features/live-context/context-trigger.ts`（纯函数 `planCleanupTrigger` / `formatUsageLine` / `renderCleanupCandidates`），阈值全部默认 `0`（关闭）——`CLM_TRIGGER_PCT`、`CLM_TRIGGER_TURNS`、`CLM_TRIGGER_TOOL_RATIO`、`CLM_TRIGGER_SINCE`，另有 `CLM_TRIGGER_CANDIDATES`（默认 3）、`CLM_TRIGGER_MIN_TOKENS`（默认 0）与 `CLM_CONTEXT_WINDOW`（估算模式的窗口兜底）；机制先以可关闭形态交付，标定后再打开。`dshTriggerView` 在 DSH 动态 context 头部输出用量行（宿主精确值优先，缺失标 `~`，窗口未知写 `window unknown`）；命中阈值时把候选写进同一个 `<oh-my-clm-block-index>`：只取已完成 turn、按「可省 token × 陈旧度」排序、永不包含 block 1 与当前 turn，并给出可直接确认的 `cleanup({ ranges, skipRoles: ["user"] })` 与每区间理由（推送前复核补：turn 以 user 块开头，裸区间会连人类请求一起删掉，因此候选固定带 `skipRoles: ["user"]`，引用的节省数字也已扣除被保留的 user 块）。用量行与候选按 `(已完成 turn 数, 触发配置)` 缓存，同一 turn 内逐字节不变；`cleanup` / mirror edit 生效与 compaction 后失效。`npm test` 123/123、`npm run check`、`npm run typecheck`、`npm pack --dry-run`、`npm run build:dsh:plugin` 全通过。

### 5.3 收编 Pi 的独立 nudge 到同一次请求

- **现状 / 证据**：`extensions/clm.ts:396-431` 的 `contextBudgetNudge` 会另起一个 "context-only turn"，要求模型停下手头工作；且 `CLM_CONTEXT_BUDGET` 默认 0（`:71`），`if (budget <= 0) return undefined`（`:398`）使触发默认完全关闭。`extensions/clm.ts:458-485` 的 `context` handler 已是 request-scoped `transformContext`、不写 session history，正是收编的位置。
- **动作**：
  1. 把 nudge 从「额外一个回合」改成「同一请求的 system 行」，内容对齐 5.2 的候选确认格式（《预查注入》：把这一步折进同一次请求）；
  2. 预算默认跟随宿主真实窗口（`ctx.getContextUsage()?.contextWindow`），不再要求手动设 env 才有触发；
  3. 保留 I-2 的四件套：每轮必须进步 / 连续两轮不进步即中止 / 轮数上限（`MAX_NUDGE_ROUNDS`）/ 触顶重置；
  4. 注入角色保持 `system`（P1-3 已修的口径，不要退回合成 user）。
- **红灯（用例 12）**：`test/adapters/extension.test.ts`（或 `session-integration.test.ts`）断言「未设 `CLM_CONTEXT_BUDGET` 时用量过高仍注入」「不产生额外 assistant turn」「连续两轮无进展后中止」「注入角色为 system」。
- **依赖 / 风险**：与 5.2 共用候选格式，必须同一步调；改成同请求注入后 `messages.some(含 marker)` 的旧去重守卫仍不可靠，中止条件以 state 里的四件套为准。
- **实施记录（2026-11-09）**：用例 12 先写红灯断言并确认 `npm test` 失败，再改生产代码转绿。`extensions/clm.ts` 的 `contextBudgetNudge` 不再声称 "context-only turn"，也不再要求模型停手：它改为在同一次请求里追加一条 `system` 行，内容为 5.2 的用量行 + 可直接确认的 `cleanup({ ranges, skipRoles: ["user"] })` 候选（复用 `formatUsageLine` / `assembleCleanupCandidates` / `renderCleanupCandidates`，候选装配从 `planCleanupTrigger` 抽出为纯函数）。预算默认取宿主窗口（`ctx.getContextUsage()?.contextWindow`），未设 `CLM_CONTEXT_BUDGET` 也会在真实水位触发；用量优先取宿主精确值，取不到才退回估算并保留 `~`。**推送前复核补**：显式设了预算时，用量行与 `usage Z%` 信号统一以该预算为分母（原先信号用宿主窗口，`CLM_CONTEXT_BUDGET=32000` + 200k 窗口会渲染成“usage 15% ≥ 75%”），并新增该场景的回归用例。I-2 四件套原样保留：每轮必须进步、连续两轮无进展即中止、`MAX_NUDGE_ROUNDS` 上限、压力消失 / 真实收缩后重置；注入角色仍是 `system`。静态附录里的触发句同步改成「确认候选或做一次编辑，然后继续任务」，长度守卫 Pi 996/1000。`formatUsageLine` 新增 `turnWord`，Pi 用 `step` 计数（Pi 在 `turn_end` 按 step 提交），并在 state 里记录 `lastCleanupStep`。

### 5.4 软卸载：给删除一个低损、可保留要点的替代

- **现状 / 证据**：`context-cleanup.ts:543-548` 的 edits 只有 `replacement: null`（`reason: "omit"`），清理是单向棘轮；I-4 / P1-3 的 diff、审计、最小回滚仍未实现（本文件开头状态行），`README.md:205-209` 承认改写后连 cleanup 都碰不到原文。笔记对应 CLM 涌现的 `[Searched: X. No relevant results.]` 视图压缩、ContextPilot 的软卸载（summarize / foldHistory）。
- **动作**：
  1. 给 `cleanup` 增加一种动作形态 `offload`：保留 ID / role / marker 与块结构，正文换成一行短占位 `[已卸载: <一句关键事实>]`；要点由**模型填**，插件不引入第二个 summarizer；
  2. 走 mirror 的 `replace` / DSH 的 content replacement 落地，占位必须严格变短并通过 shrink-only 门；
  3. 与 `omit` 可在同一 call 内混用；配对级联、block 1 守卫、`removeMirrorBlocks` 的顶层 span 规则（`context-cleanup.ts:607-655`）全部沿用；
  4. 保留占位使「删错」从永久丢失变成留得住要点，5.2 的触发才敢更频繁命中。
- **红灯（用例 13）**：`test/features/live-context/context-cleanup.test.ts` 断言「offload 后块仍在、正文变短且含占位标记」「占位不破坏 `CLM_SNAPSHOT` / 配对」「offload 与 omit 混用后总 token 严格下降」「body 内引用 marker 不被误当顶层块」。
- **依赖 / 风险**：占位替换同样打断前缀缓存，5.0 的低频约束继续适用；本步只解决「丢要点」，**不替代** I-4 的 diff / 回滚，两者都要留痕。
- **实施记录（2026-11-09）**：用例 13 先写红灯断言并确认 `npm test` 失败，再改生产代码转绿。`cleanup` 新增 `offload: [{ blockId, note }]`：保留 ID / role / 顶层 marker 与块顺序，只把正文换成一行 `[offloaded: <note>]`（`offloadBody` / `OFFLOAD_PREFIX`，`MAX_OFFLOAD_NOTE_CHARS = 240`）；要点由模型填，插件不引入第二个 summarizer。占位文本保留英文，与其余模型可见字符串同语种（计划里的 `[已卸载: …]` 是示意）。校验沿用既有口径：未知 / 重复 / 与 `blockIds`·`ranges` 冲突的 ID 整体拒绝，`list` 仍只读，block 1 拒绝，user / custom 拒绝（改写人类正文），单条 note 必须单行且**按估算 token 严格短于原正文**（防止绕过 shrink-only）。落地走同一条顶层 span 扫描：`context-format.ts` 新增 `rewriteMirrorBlocks({ remove, replace })`，Pi 在工具里改写 mirror、`turn_end` 仍按 `planContextEdits` 提交 `replace`；DSH 走既有 `appendContentReplacement`（toolResult 内容改写、assistant 变成 developer/message），offload assistant tool-call 块时沿用配对级联把配对结果 omit。`cleanupToolResult` / `formatCleanupToolResult` 如实报告 `offloadedBlockIds`（`cleanup applied; offloaded 1 block(s): 2.`）。`reservedBodyReason` 从 mirror 编辑路径抽出，offload note 复用同一保留字检查。`npm test` 132/132、`npm run check`、`npm run typecheck`、`npm pack --dry-run`、`npm run build:dsh:plugin` 全通过。

### 5.5 触发器的审计抽查流（防门控盲区）

- **现状 / 证据**：5.2 新增的代码判定本身就是门控；《门控看不到自己的盲区》——「只在自己放行的样本上学，被压掉的永远不被纠正」；《自演化系统的承重件是门控》——选择是承重件。当前无任何触发决策记录。
- **动作**：
  1. 每次触发记一条只读决策记录：命中信号、阈值、候选 ranges、模型是确认 / 否决 / 改写、随后 N 步的任务结果；不写 session history、不改正文；
  2. 留一条**与分数无关的随机抽查**：即使未命中阈值也以小概率注入一次候选，并标记 `probe`，用来观察「没放行其实该放行」的漏判；
  3. 抽查结果单独统计，不进触发阈值的主反馈回路，避免自证；
  4. 遥测字段为 5.6 提供数据。
- **红灯（用例 14）**：断言「未命中阈值时 probe 仍可产出候选且被标记」「决策记录字段齐全且不含注入正文」「probe 不计入主触发计数」。
- **依赖 / 风险**：抽查会增加少量请求，需设上限并做成可开关；这一步是 5.6 能得出因果结论的前提。

### 5.6 遥测与撤除 A/B 验收

- **现状 / 证据**：`scripts/measure-session-index.mjs` 已能量索引快照数 / 字节 / 步间隔与真实 `cleanup` 调用形态（`:167-176`、`:243-254`），但**不含**缓存命中率、上下文峰值、任务成功率、触发决策；I-5（未验证「模型是否真会用 turn-level cleanup」）、I-6（代价不可观测，`docs/reference/clm-technical-analysis.md:34-36/43` 的 Prefix-reuse FLOPs / SCR / ATIF-CTX 全 ❌）仍未结案。
- **动作**：
  1. **基线采集**（从第 1 步起并行、只读、不改生产代码）：在真实 V4.1-Flash 长会话日志上量四项——cleanup 自发 / 触发次数、上下文峰值、缓存命中率（`cacheReadTokens` 占比）、任务成功率；
  2. **补遥测字段**：触发次数、确认 / 否决 / 改写比例、每次清理省下 token、清理位置距前缀头部的距离、命中率变化；
  3. **撤除试验**：「关掉插件」与「开插件但关掉触发」两组跑同一批长任务 A/B（《可学性要在撤掉脚手架之后量》《配置按半衰期管理》），同时报准确率、成本、延迟、安全四类指标；
  4. 把「能力天花板」与验收口径写进 README：不承诺省算力、不迁移 CLM 论文的「更准更省」结论（I-9）。
- **红灯（用例 15）**：断言「遥测字段可从 session 日志复算」「撤除对照可复现（同一批任务 / 同配置）」「缓存命中率退化超过阈值时告警或拒绝更激进的触发」。
- **依赖 / 风险**：需要真实 V4.1-Flash 长任务样本；拿不到就明确写成「未验证边界」，不用合成日志下结论（I-5）。

### 5.7 六步与既有清单的对应

| 本节步 | 关联既有项 | 关系 |
|---|---|---|
| 5.1 | I-7（提示词口径） | 顺手统一，不新增打回 |
| 5.2 | I-2、I-6、P1-2 | 已实施（2026-11-09，阈值默认关闭待标定）；I-6 的代价可观测仍待 5.6 |
| 5.3 | I-2 | 已实施（2026-11-09，同请求 system 行 + 宿主窗口默认预算）；四件套不变 |
| 5.4 | I-4、P1-3 | 已实施（2026-11-09，`offload` 保留要点）；不替代 diff / 审计 / 回滚 |
| 5.5 | I-10（规则外清单） | 新增一条需人复核的维度 |
| 5.6 | I-5、I-6、I-9 | 撤除试验 + 诚实定位 |

红灯用例编号 10~15，细节见各步「红灯」行；本次只修改计划文档，不改任何生产代码。
