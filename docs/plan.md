# 审查整改计划（oh-my-clm 0.1.12）

> 状态：评审草稿 / 整改已完成（验收部分）
> 整改状态（2026-11-09）：§3 的 11 条回归用例，以及一次推送前复核新增的 5 条回归（P1-1 守卫收窄 4 条、I-2 触顶重置 1 条）全部转绿（`npm test` 114/114、`npm run check`、`npm run typecheck` 通过），生产代码与文档已同步；逐项说明见 `changelog.md` 的「0.1.13（当前版本）」。**回归用例转绿不等于第 1 节打回项全部结案**：P1-2 的「宿主 usage 校准 + 估算/上限双检」、P1-3 的「编辑 diff/审计/最小回滚、审批/签名」仍未实现（P1-3 只落地了运行时来源标签 + 显式保留字黑名单，不是对任意注入指令的内容审计）；§2 改进项中 I-1、I-2 已修，I-3~I-9 及「规则外清单」（安全姿态、真实宿主行为、撤除试验、维护代价）仍需人工复核 / 排期。
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
