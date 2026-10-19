# oh-my-clm 事实核查报告（2026-10-20）

> **文档结构说明**：本报告写于文档重组前，文中的 `docs/how-it-works.md`、`docs/dsh-cache-explained.md`、`docs/CLM技术分析表.md` 路径和行号都指向当时结构。当前对应文档为 [live-context-mirror.md](./features/live-context-mirror.md)、[dsh-prefix-cache.md](./reference/dsh-prefix-cache.md) 和 [clm-technical-analysis.md](./reference/clm-technical-analysis.md)。

> **修复状态（2026-10-20 后续）**：本报告第 1–8 节记录修复前的核查结果，行号指向修复前版本。F1–F13、版本叙事、内部证据文件和低优先级完整性问题已经修复，修复后的验证见第 9 节。

## 0. 结论摘要

本轮把 [`README.md`](../README.md)、[`changelog.md`](../changelog.md)、[`docs/`](./) 下的公开文档、`docs/reports/` 的证据文件，与当前源码、测试、构建产物以及本机安装的 DSH `0.2.0-rc.2` 做了逐条对照。

- **核心机械契约基本属实**：mirror 路径与权限、cleanup 的 ID/区间/`skipRoles`/`list`、block 1 保护、配对删除、shrink-only 门、Pi `context_edit`、DSH `Session.append(surfaceOp: replace)`、`tool/result` content-only 改写、append-only 原始日志、索引默认值与节流键，都能在源码与测试中找到对应实现。
- **发现 13 组公开文档与实现不一致**，其中 8 组是直接错误（不是措辞问题）：DSH content edit 使用 `assistant/message`、`defineTool` 注册、mutation 只在 `step/start` 后发生、pre-step 会等待队列、`CLM_CLEANUP_RESULT=none` 对 listing 的行为、DSH estimator 全部走 fallback、mirror 上限“固定”、发布白名单按目录描述。
- **版本叙事不一致**：源码和产物仍是 `0.1.6`，但 `changelog.md` 把当前行为放在“未发布”，`roadmap.md` 称之为 `0.1.7`，而重新构建的 `artifacts/oh-my-clm-0.1.6.tgz` 已经包含这些行为。
- **内部证据文件有历史漂移**：`docs/reckless/` 与 `docs/reports/README.md` 仍描述 `assistant/message` 和 `defineTool`；`dsh-host-test-report-current.txt` 的 95 项通过记录已被当前 harness 的 99 项取代。
- **真实 DSH profile 持久化、restart/fork、模型是否会主动 cleanup/list** 仍未被本轮验证；文档本身也把这些标为 unresolved，这部分没有虚假“已证明”的表述。

本轮核查时没有修改源码或既有文档；后续修复记录见第 9 节。

## 1. 核查方法与基线

- 逐条阅读 [`README.md`](../README.md)、[`changelog.md`](../changelog.md)、[`docs/how-it-works.md`](./how-it-works.md)、[`docs/project-structure.md`](./project-structure.md)、[`docs/reports/README.md`](./reports/README.md)、`docs/reckless/*.md`、[`docs/dsh-cache-explained.md`](./dsh-cache-explained.md)。
- 对照源码：`extensions/clm.ts`、`src/lib/*.ts`、`src/features/live-context/*.ts`、`dsh/index.ts`。
- 对照测试：`test/**/*.test.ts`、`test/harness/clm-dsh-host-test.mjs`。
- 对照宿主：本机安装的 `@deepseek-ai/dsh-session@0.2.0-rc.2` 与 `@deepseek-ai/dsh-agent-loop`，以及官方仓库 commit `1517a4dbca0a2789ff1d41ba439600f8547d23fa`。
- 运行检查：`npm test`、`npm run check`、`npm run typecheck`、DSH mock harness、`npm pack --dry-run`、DSH-only 打包。

复现结果见第 7 节。

## 2. 需要修正的公开文档描述

### F1. DSH content edit 被说成会追加 `assistant/message`（高）

- 位置：[`docs/how-it-works.md:150`](./how-it-works.md#L150)、[`docs/reckless/decision-record.md:170`](./reckless/decision-record.md#L170)、[`docs/reckless/evidence-ledger.md:219`](./reckless/evidence-ledger.md#L219)。
- 文档说法：“内容编辑追加 `assistant/message` 或 `tool/result` replacement。”
- 实际：bridge 对 assistant 的改写**从不**追加 `assistant/message`，而是追加带缩短文本的 `developer/message`；`assistant/message` 只作为输入事件出现。实现见 [`dsh-bridge.ts:446-469`](../src/features/live-context/dsh-bridge.ts#L446-L469)，注释见 [`dsh-bridge.ts:419-430`](../src/features/live-context/dsh-bridge.ts#L419-L430)。
- 宿主依据：DSH 明确禁止 `assistant/message` 携带 `sourceEventSeqs`（`node_modules/@deepseek-ai/dsh-session/lib/index.js:313`），而 replacement 又必须引用所有被遮蔽节点。
- 正确表述：`tool/result` content-only replacement、`developer/message` omission/assistant rewrite；README 第 154、156 行和 changelog 的 0.1.1 条目已经是正确说法。
- 建议：把 how-it-works 与内部决策记录统一为 README/changelog 的表述。

### F2. `ctx.tools.register(defineTool(...))` 与 harness 的 `defineTool` 断言（高）

- 位置：[`docs/how-it-works.md:150`](./how-it-works.md#L150)、[`docs/reckless/decision-record.md:190`](./reckless/decision-record.md#L190)、[`docs/reckless/evidence-ledger.md:271`](./reckless/evidence-ledger.md#L271)、[`docs/reports/README.md:11`](./reports/README.md#L11)、[`test/harness/clm-dsh-host-test.mjs:391`](../test/harness/clm-dsh-host-test.mjs#L391)。
- 文档说法：cleanup 通过官方 `ctx.tools.register(defineTool(...))` 注册，由 `defineTool` 在 `execute` 前做 schema 校验。
- 实际：DSH entry 注册的是**普通对象**，没有导入 `defineTool`；`dsh/index.ts:226-232` 还明确解释了为什么不能导入 `@deepseek-ai/dsh-tools`（避免 profile 里出现第二份 host 包，导致工具调度器 Symbol 不一致）。注册调用见 [`dsh/index.ts:477-483`](../dsh/index.ts#L477-L483)。
- harness 也没有 `defineTool`：mock 的 `tools.register` 只是保存 definition 并直接调用 `execute`（[`clm-dsh-host-test.mjs:59-66`](../test/harness/clm-dsh-host-test.mjs#L59-L66)）。第 391 行所谓 “defineTool rejects malformed numeric IDs” 实际是 `parseCleanupArgs` 在 `execute` 内拒绝了 `3.5`（[`dsh/index.ts:295-297`](../dsh/index.ts#L295-L297)），不是 schema 前置校验。
- 正确表述：`ctx.tools.register(<plain definition>)`；参数校验由共享 `parseCleanupArgs` 完成；DSH 的 output schema 在返回值阶段由宿主校验。
- 建议：改掉 how-it-works、decision-record、E-020、reports README 和 harness 断言名称；不要把 `defineTool` 写成当前实现。

### F3. “mutation 只在 `step/start` 打开新 step 后执行”（高）

- 位置：[`README.md:147`](../README.md#L147)。
- 文档说法：“实际 mutation 延迟到 `Session.append()` 发布完成、且 `step/start` 打开新 step 之后执行。”
- 实际：bridge 在 `tool/result`、`user/message`、`step/start` 三种事件上都会排队 reconcile（[`dsh/index.ts:524-535`](../dsh/index.ts#L524-L535)）。当模型用文件工具编辑 mirror 时，触发的是 `tool/result`；此时当前 step 仍然打开，mutation 在 `tool/result` 发布完成后的微任务里就会执行，不需要等下一个 `step/start`。对应回归测试见 [`dsh-bridge.test.ts:830-846`](../test/features/live-context/dsh-bridge.test.ts#L830-L846)：只 append 了 `tool/result`，没有 `step/start`，编辑仍然被应用。
- 只有 `agent/pre-step` 里因为当时没有 open step 而无法应用的待处理编辑，才需要等 `step/start`。
- 正确表述：`tool/result` / `user/message` 在当前 step 内应用；pre-step 的待处理编辑在 `step/start` 后应用。
- 建议：按 how-it-works 第 150 行的正确版本改写 README，或明确区分“当前 step 内 tool/result 触发”和“pre-step 延迟到 step/start”。

### F4. “`agent/pre-step` 只等待已排队的收敛”（中高）

- 位置：[`README.md:147`](../README.md#L147)、[`docs/how-it-works.md:150`](./how-it-works.md#L150)、[`docs/reckless/decision-record.md:200`](./reckless/decision-record.md#L200)。
- 文档说法：pre-step 会等待已经排队的 reconcile 完成，只是不执行 mutation。
- 实际：pre-step 只在 `dshOpenTurnStep(session)` 为真时才 `await enqueueReconcile(...)`（[`dsh/index.ts:508-518`](../dsh/index.ts#L508-L518)）。DSH 的真实顺序是 pre-step 在 `step/start` 之前，上一步已经 `step/end`，所以这里通常是 `undefined`；此时 pre-step 直接 `return next()`，**既不等待也不 mutation**。只有“不 mutation”这半句成立。
- 测试 [`dsh-bridge.test.ts:886-890`](../test/features/live-context/dsh-bridge.test.ts#L886-L890) 也显示：pre-step 看到的是“编辑原样留在 mirror 里”，并没有等待队列收敛。
- 正确表述：pre-step 不执行 mutation；在当前 DSH 时序下它也不会等待队列。真正保证下一请求前收敛的是此前 `tool/result`/`user/message` 上排队的微任务，以及随后的 `step/start`。
- 建议：要么修正文档，要么在 pre-step 无条件等待已有队列（如果这是设计承诺），并加一条测试断言。

### F5. `CLM_CLEANUP_RESULT=none` 被说成“不产生结果文本”（高）

- 位置：[`README.md:183`](../README.md#L183)、[`docs/how-it-works.md:76`](./how-it-works.md#L76)。
- 文档说法：`none` 则不产生结果文本。
- 实际：`none` 只压缩**删除/拒绝确认**；`cleanup({ list: "A-B" })` 的只读 listing 在任何 copy 模式下都返回行内容（[`context-cleanup.ts:707-711`](../src/features/live-context/context-cleanup.ts#L707-L711)）。测试明确断言 `formatCleanupToolResult(listed, "none") === listed.rows`（[`context-cleanup.test.ts:360`](../test/features/live-context/context-cleanup.test.ts#L360)）。
- changelog 已经写对：“`CLM_CLEANUP_RESULT=none` 不会吞掉 listing 内容（它只压缩删除确认）”；README/how-it-works 与之矛盾。
- 建议：改成“`none` 只抑制删除/拒绝确认；listing 始终返回内容”。

### F6. “DSH 的 `reasoning`、`tool-call`、`tool` 仍走 fallback 估算”（高）

- 位置：[`README.md:127`](../README.md#L127)。
- 文档说法：共享层不导入 Pi runtime，所以 DSH 的 `reasoning`、`tool-call`、`tool` 和其他自有消息形状仍走 fallback 估算。
- 实际：共享 estimator **显式处理**了这些形状：
  - role `tool` → 映射为 `toolResult`（[`context-format.ts:727-741`](../src/features/live-context/context-format.ts#L727-L741)）；
  - assistant 的 `reasoning` 文本计入（[`context-format.ts:842`](../src/features/live-context/context-format.ts#L842)）；
  - `toolCall` / `tool-call` 的 name + arguments 计入（[`context-format.ts:846-848`](../src/features/live-context/context-format.ts#L846-L848)）；
  - `estimateMessageTokens` 的 `tool` case（[`context-format.ts:830-831`](../src/features/live-context/context-format.ts#L830-L831)）。
  只有未识别的“其他自有消息形状”才走 fallback。
- 这与 [`docs/how-it-works.md:176`](./how-it-works.md#L176) 的“同时接受 DSH 的 reasoning、tool-call/tool 等词汇”一致，README 第 127 行与 how-it-works 自相矛盾。
- 建议：改成“显式处理 reasoning/tool-call/tool；未识别的 DSH 形状走 fallback”。

### F7. “mirror 显示上限固定”与“没有可调 mirror limit”（中高）

- 位置：[`README.md:123`](../README.md#L123)、[`docs/how-it-works.md:213`](./how-it-works.md#L213)、[`docs/how-it-works.md:342`](./how-it-works.md#L342)。
- 文档说法：显示上限固定为单 block 12000 字符、总 mirror 96000 字符；项目没有实现可调 mirror limit。
- 实际：Pi 侧确实固定（`extensions/clm.ts` 直接使用 `DEFAULT_MAX_*`）；DSH 侧会读取 `CLM_MAX_BLOCK_CHARS` 和 `CLM_MAX_MIRROR_CHARS`（[`dsh/index.ts:178-179`](../dsh/index.ts#L178-L179)）。README 第 183 行自己就列出了这两个开关。
- 正确表述：Pi 固定；DSH 默认 12k/96k，可按环境变量覆盖。
- 建议：把“固定”限定到 Pi，或明确 DSH 的默认值与覆盖方式；删除“没有可调 mirror limit”这句的绝对化表述。

### F8. 发布白名单按目录描述，与实际 `files` 数组不一致（中高）

- 位置：[`README.md:233`](../README.md#L233)。
- 文档说法：发布白名单包含 `src/lib/`、`src/features/live-context/`。
- 实际：[`package.json:8-24`](../package.json#L8-L24) 的 `files` 逐个列出文件：
  - `src/lib/clm-files.ts`、`src/lib/clm-paths.ts`；
  - `src/features/live-context/context-cleanup.ts`、`context-format.ts`、`dsh-bridge.ts`。
  新增 `src/lib/` 或 `src/features/live-context/` 下的文件不会自动进入 npm 包。`dsh/`、`dist/`、`locale/` 才是目录级包含。
- 另外，`files` 含 `docs`，所以当前工作树的 `npm pack` 实际会把 `docs/reckless/` 也打进去；这与 `.gitignore` 把 `docs/reckless` 标为内部材料的意图不一致（见第 4 节）。
- 建议：要么把 `files` 改成目录级，要么在 README 中按实际文件列表描述；如果 `docs/reckless` 不应发布，加 `.npmignore` 或把 `docs` 改为更窄的列表。

### F9. “`auto` 撤销会话内覆盖”与进程级 override（中）

- 位置：[`README.md:97`](../README.md#L97)。
- 文档说法：`auto` 撤销“会话内覆盖”。
- 实际：`indexModeOverride` 是模块级全局变量（[`dsh/index.ts:117`](../dsh/index.ts#L117)），`/clm mode` 会修改它并清空**所有** session 的 `state.blockIndex`（[`dsh/index.ts:374-375`](../dsh/index.ts#L374-L375)、[`488-491`](../dsh/index.ts#L488-L491)）。切换是进程级的，会影响同一进程中的所有 session。
- changelog 的“在当前进程里切换索引形状”是准确的；README 的“会话内覆盖”不准确。
- 建议：改为“进程内覆盖（影响当前进程的所有 session）”。

### F10. budget nudge 的“只做一次 mirror 编辑”与触发阈值（中）

- 位置：[`README.md:109`](../README.md#L109)。
- 文档说法：接近目标时要求模型只做一次 mirror 编辑。
- 实际：nudge 文本允许 `cleanup` **或**一次 mirror 编辑（[`extensions/clm.ts:345-348`](../extensions/clm.ts#L345-L348)）；触发条件是 `tokens >= floor(0.75 * max(1, budget - 2048))`（[`extensions/clm.ts:341-343`](../extensions/clm.ts#L341-L343)），即大约预算的 75% 减 2K，不是“接近 100% 目标”。
- 建议：改成“nudge 允许一次 cleanup 或一次 mirror 编辑；阈值约为 `0.75 × (budget - 2048)`”。

### F11. “branch 切换自动刷新 mirror”（中低）

- 位置：[`README.md:103`](../README.md#L103)。
- 文档说法：扩展会在 session start、branch 切换和请求前自动刷新 mirror。
- 实际：`session_tree` 处理器只清空 snapshot、设置状态文本，并不写 mirror（[`extensions/clm.ts:373-377`](../extensions/clm.ts#L373-L377)）。真正的刷新发生在下一次 `context` hook 的 `syncMirror`。因此“branch 切换时刷新”应改为“branch 切换后标记待刷新，下一次请求前刷新”。
- 建议：改文档，或在 `session_tree` 中直接调用 `syncMirror`（后者会改变行为，需要测试）。

### F12. cleanup 与普通编辑的事件类型被混写（中低）

- 位置：[`README.md:154`](../README.md#L154)。
- 文档说法：cleanup 和普通编辑会追加 `tool/result` content replacement 或 `developer/message` replacement。
- 实际：cleanup 的 plan 全部是 `replacement: null`（[`context-cleanup.ts:564-568`](../src/features/live-context/context-cleanup.ts#L564-L568)），因此只追加空 `developer/message` omission；`tool/result` content replacement 只用于普通 mirror 编辑中**改写** tool result 的场景（[`dsh-bridge.ts:472-484`](../src/features/live-context/dsh-bridge.ts#L472-L484)）。
- 建议：拆成两句：“cleanup → 空 developer/message omission；普通 mirror 编辑 → tool/result content replacement 或 developer/message assistant rewrite”。

### F13. how-it-works 把 `CLM_CLEANUP_RESULT` 写成通用开关（中低）

- 位置：[`docs/how-it-works.md:76`](./how-it-works.md#L76)。
- 文档说法：默认情况下工具结果只有一行确认；设置 `CLM_CLEANUP_RESULT=full` 可附带索引，`none` 则不返回文本。
- 实际：`CLM_CLEANUP_RESULT` 只在 DSH host entry 中读取（[`dsh/index.ts:168-170`](../dsh/index.ts#L168-L170)）；Pi 的 `formatCleanupToolResult` 不接受该环境变量，默认就是 `full` 语义（没有索引可附带）。此外 `none` 不吞 listing（见 F5）。
- 建议：明确标注为 DSH-only，并说明 listing 例外。

## 3. 版本与发布状态

- `package.json` 与 `dsh-plugin.json` 都是 `0.1.6`（[`package.json:3`](../package.json#L3)、[`dsh-plugin.json:6`](../dsh-plugin.json#L6)）。
- `changelog.md` 顶部有很长的“未发布”段（[`changelog.md:5`](../changelog.md#L5)），把 digest 默认、`cleanup({ list })`、head 12 + tail 40、`/clm mode` 等当前行为都放在未发布；`0.1.6` 段只增加 `/clm` 命令（[`changelog.md:39`](../changelog.md#L39)）。
- `docs/reckless/roadmap.md:30` 把同一批工作称为 `0.1.7`。
- 但重新构建的 `artifacts/oh-my-clm-0.1.6.tgz` 已经包含 `DEFAULT_BLOCK_INDEX_HEAD = 12`、`DEFAULT_BLOCK_INDEX_TAIL = 40`、`largest omitted turns`，即这些“未发布/0.1.7”行为已经被打进 `0.1.6` 产物。
- README 第 213、220 行仍写“0.1.0–0.1.6”，与当前工作树和产物不一致。

**判断**：这是发布元数据与 changelog 状态不一致，不是单句错字。要么把版本升到 `0.1.7` 并把“未发布”改成 `0.1.7`，要么把当前行为明确标为 `0.1.6` 的 unreleased build，并修正 README 的版本范围。继续用 `0.1.6` 打包会让“同一版本号对应不同内容”。

## 4. 内部证据与历史报告漂移

这些文件在 `.gitignore` 中被忽略（`docs/reckless`），或属于历史报告；如果只把它们当“内部笔记”，影响小于公开文档。但它们被 `docs/reports/README.md` 当作证据引用，仍值得清理。下面的 `docs/reckless/*` 链接只在当前工作树有效；如果这些文件不随仓库提交，请把它们当成本地核查笔记。

- [`docs/reckless/decision-record.md:170`](./reckless/decision-record.md#L170)：仍写 content edit 追加 `assistant/message`（同 F1）。
- [`docs/reckless/decision-record.md:190`](./reckless/decision-record.md#L190)：仍写 `ctx.tools.register(defineTool(...))`（同 F2）。
- [`docs/reckless/decision-record.md:200`](./reckless/decision-record.md#L200)：仍写 pre-step “only waits for already-queued convergence”（同 F4）。
- [`docs/reckless/decision-record.md:316`](./reckless/decision-record.md#L316)：仍写“默认仍是 `blocks` 模式，直到 Step 4 的 live 信号出现”；同一文件第 328 行又写“E-030 之后默认改为 `digest`”。当前代码默认是 digest（[`dsh/index.ts:124-127`](../dsh/index.ts#L124-L127)）。
- [`docs/reckless/evidence-ledger.md:219`](./reckless/evidence-ledger.md#L219)：E-016 仍写 “appends standard `assistant/message`…”。
- [`docs/reckless/evidence-ledger.md:271`](./reckless/evidence-ledger.md#L271)：E-020 仍写 `defineTool(...)`。
- [`docs/reckless/evidence-ledger.md:368`](./reckless/evidence-ledger.md#L368)：E-028 仍写“默认仍是 blocks”“`cleanup({ list: true })` 尚未实现”；当前默认 digest，且 `cleanup({ list: "A-B" })` 已实现并测试。
- [`docs/reckless/evidence-ledger.md:410`](./reckless/evidence-ledger.md#L410)：E-031 写 harness `97 passed`；当前实际为 `99 passed, 0 failed, 1 observation`。
- [`docs/reports/dsh-host-test-report-current.txt:117`](./reports/dsh-host-test-report-current.txt#L117) 与 `:125`：记录 `95 passed`，observation 是“agent.id/session.id mismatch 时 session/event sync 被静默跳过”。当前 harness 输出为 `99 passed`，observation 已变为“session/event sync still matched (state is session-scoped)”（[`clm-dsh-host-test.mjs:563`](../test/harness/clm-dsh-host-test.mjs#L563)）。这是因为后续把 state 改为按 session id 键（E-024）。
- [`docs/reports/README.md:15`](./reports/README.md#L15)：称当前证据是 E-016、E-020、E-021；实际最新的是 E-031，且 E-016/E-020 已含过期描述。
- [`docs/reckless/roadmap.md`](./reckless/roadmap.md) 的回退项仍写 `cleanup({ list: true, ranges: [...] })`；实现签名是 `cleanup({ list: "A-B" })`，不能与删除参数同用。

### 其他低优先级完整性

- [`docs/project-structure.md`](./project-structure.md) 的目录树没有列出 `docs/README.md`、`docs/CLM技术分析表.md`、`docs/dsh-cache-explained.md` 和 `docs/reckless/`；[`docs/README.md`](./README.md) 也没有列出 `dsh-cache-explained.md`。这是文档索引不完整，不是行为错误。
- [`docs/project-structure.md:92`](./project-structure.md#L92) 写 `npm test` 运行 `node --test "test/**/*.test.ts"`；实际 `package.json` 脚本还带 `--experimental-strip-types`（[`package.json:49`](../package.json#L49)）。
- [`README.md:62`](../README.md#L62) 的“DSH 只会在 turn 边界追加一条快照”对普通追加成立，但 `cleanup`、mirror edit 和 compaction 会清空缓存并在同一 turn 内重渲染（[`README.md:189`](../README.md#L189) 已说明）。建议加“正常追加时”，避免读者把“只在 turn 边界”理解成绝对约束。

## 5. 已核实的关键契约

以下不是“文档自己声称”，而是本轮从源码/测试/宿主源码核到的：

| 主题 | 结论 | 证据 |
|---|---|---|
| mirror 路径 | `/tmp/clm-${encodeURIComponent(sessionId)}/LIVE_CTX_MAIN.md`，session 隔离 | [`clm-paths.ts:9-20`](../src/lib/clm-paths.ts#L9-L20)、[`clm-paths.test.ts`](../test/lib/clm-paths.test.ts) |
| 权限 | 目录 `0700`、文件 `0600`，临时文件 + rename | [`clm-files.ts:8-30`](../src/lib/clm-files.ts#L8-L30) |
| 协议 | `clm-v2`、`CLM_SNAPSHOT`、`CLM_ENTRY`、`CLM_EMPTY` | [`context-format.ts:4-7`](../src/features/live-context/context-format.ts#L4-L7)、[`context-format.ts:657-721`](../src/features/live-context/context-format.ts#L657-L721) |
| cleanup 参数 | `blockIds` 严格、`ranges` 夹取、`skipRoles`、`list` 只读且不能与删除同用 | [`context-cleanup.ts:185-295`](../src/features/live-context/context-cleanup.ts#L185-L295) |
| block 1 / 配对 | 显式 ID 1 拒绝；range 覆盖 1 时保留；assistant↔toolResult 级联；`pairedRemovalIds` 单独上报 | [`context-cleanup.ts:432-581`](../src/features/live-context/context-cleanup.ts#L432-L581) |
| shrink-only | 编辑后 token 必须严格小于编辑前；cleanup 同样 | [`context-format.ts:1173-1186`](../src/features/live-context/context-format.ts#L1173-L1186)、[`dsh-bridge.ts:587-595`](../src/features/live-context/dsh-bridge.ts#L587-L595) |
| token estimator | 3.5 chars/token、按消息 rounding、system sections + tools、图片 4800 chars | [`context-format.ts:759-862`](../src/features/live-context/context-format.ts#L759-L862)；Pi host bundle 中同名常量与分支一致 |
| Pi 持久化 | `turn_end` 返回 `context_edit`；原始 JSONL 不变；branch 隔离 | [`extensions/clm.ts:394-431`](../extensions/clm.ts#L394-L431)、[`session-integration.test.ts`](../test/adapters/session-integration.test.ts) |
| DSH replacement | `tool/result` 只改 `content`；assistant 改写/omission 用 `developer/message`；都带 `sourceEventSeqs` | [`dsh-bridge.ts:399-484`](../src/features/live-context/dsh-bridge.ts#L399-L484) |
| DSH step 坐标 | omission/assistant rewrite 使用 append 时打开的 `turn`/`step`；无 open step 拒绝 | [`dsh-bridge.ts:351-391`](../src/features/live-context/dsh-bridge.ts#L351-L391)、[`dsh-bridge.ts:503-624`](../src/features/live-context/dsh-bridge.ts#L503-L624) |
| DSH dedupe | runtime-context 文本不变则不 append | 本机 `dsh-agent-loop/lib/index.js:298-340` |
| pre-step 时序 | pre-step 在 `step/start` 之前；索引渲染时下一步 step 尚未写入 | 本机 `dsh-agent-loop/lib/index.js:902-910`、`968` |
| 节流键 | “打开中的 turn + 已关闭 step 数” | [`dsh-bridge.ts:230-276`](../src/features/live-context/dsh-bridge.ts#L230-L276) |
| 索引默认 | digest 默认；blocks head 12 + tail 40；preview 64；digest lines 40；refresh 4 | [`context-format.ts:15-36`](../src/features/live-context/context-format.ts#L15-L36)、[`context-format.ts:499`](../src/features/live-context/context-format.ts#L499)、[`dsh/index.ts:124-127`](../dsh/index.ts#L124-L127) |
| `/clm` | Pi `/clm` = `/clm status`；DSH `/clm status` + `/clm mode`；都不提供 `/clm refresh` | [`extensions/clm.ts:478-487`](../extensions/clm.ts#L478-L487)、[`dsh/index.ts:357-400`](../dsh/index.ts#L357-L400) |
| 打包 | 完整包 34 files；DSH-only 包 13 files，不含 `src/*.ts`/test | 见第 7 节 |

## 6. 未核实或外部资料类断言

以下不是“已确认错误”，而是本轮没有足够证据确认，建议在文档中保留为 unresolved 或补来源：

- **真实 DSH profile 的安装、activation、flush、restart、fork**：README 自己已经标为未验证；本轮没有运行真实 profile。
- **模型是否真的会主动调用 `cleanup` / `list`，以及 digest 是否降低清理频率**：E-030 已明确标为 unresolved；本轮没有 provider 实验。
- **`dsh-plugin.json` 的 Community permissions 不被强制执行**：README 有这句判断；本机 DSH 0.2.0-rc.2 的插件管理器代码中没有找到对应的运行时权限执行路径，但也没有做正向测试。建议保留“当前不应被描述为强制隔离”的谨慎措辞。
- **E-027/E-028 的 7 个历史 session 回放数字**（224 条快照、1.09 MB、40 次 digest、约 36 KB）：本轮只能从当前项目日志看到 2 个 session / 11 条快照，无法复现历史 7 个 session 的统计；这些是历史测量，不是当前可复现结果。
- **`docs/dsh-cache-explained.md` 的外部数字**：官方 Context Caching 文档只说明“请求边界、公共前缀、固定 token 间隔”会持久化前缀，没有给出“1024 token 激活阈值 / 256 token 对齐”的表述；该文引用的是第三方仓库/社区博客。`97–99%`、`99.93%`、`70.5% → 86.9%`、Discussion #3304/#2064 等数字本轮未逐一复核。建议把具体机制数字标为社区观测，不要把 `[2]` 这类第三方来源写成官方结论。
- **`docs/CLM技术分析表.md` 的上游论文/benchmark 数字**：该文基于 `facebookresearch/context-language-models` 固定 commit，本轮没有重跑上游实验；其中的表格属于文献整理，不是本项目实测。

## 7. 复现命令与结果（核查时，0.1.6）

以下为修复前基线；修复后的复验见第 9 节。在本机 `/home/deepseek-agent/oh-my-clm`：

```text
npm test
  -> 88 tests, 88 pass, 0 fail

npm run check
  -> Module boundaries OK: 16 files, 25 relative imports
  -> tsc -p tsconfig.dsh.json
  -> DSH package check passed: dist/dsh/index.js

npm run typecheck
  -> tsc --noEmit && tsc -p tsconfig.dsh.json --noEmit (exit 0)

node test/harness/clm-dsh-host-test.mjs .
  -> 99 passed, 0 failed, 1 observation
  -> observation: agent.id/session.id mismatch — session/event sync still matched (state is session-scoped)

npm_config_cache=/tmp/npm-cache-clm npm pack --dry-run --json
  -> 34 files, 506250 bytes unpacked, 161455 bytes packed
  -> 包含 docs/reckless/{decision-record,evidence-ledger,roadmap}.md

npm_config_cache=/tmp/npm-cache-clm npm run build:dsh:plugin
  -> artifacts/oh-my-clm-0.1.6.tgz
  -> 13 files: README.md, cordis.patch.yml, dist/*, dsh-plugin.json, icon.svg,
     locale/{en,zh}.json, package.json
```

说明：直接运行 `npm pack` / `npm run build:dsh:plugin` 在本机会因 `~/.npm/_cacache` 只读而 `EROFS` 失败；这是环境限制，不是项目打包逻辑错误。上面的结果使用 `npm_config_cache=/tmp/npm-cache-clm` 绕过。

## 8. 建议的修正顺序

1. **先修公开文档的直接错误**：F1–F8。这些会让集成者按错误契约写代码或排查问题。
2. **再处理版本/发布状态**：把 `0.1.6` vs `未发布` vs `0.1.7` 统一；否则重新打包会继续产生“同版本不同行为”的产物。
3. **同步内部证据文件**：至少修正 `docs/reports/README.md`、`dsh-host-test-report-current.txt` 的计数和 observation，避免把历史断言当当前证据。
4. **最后处理措辞类问题**：F9、F10、F11、F12、F13，以及文档目录树/命令示例的完整性。

## 9. 修复状态与复验（2026-10-20 后续）

### 9.1 修复项

| 项目 | 状态 | 修复位置 |
| --- | --- | --- |
| F1 DSH content edit 事件类型 | 已修复 | `docs/how-it-works.md`、`docs/reckless/decision-record.md`、`docs/reckless/evidence-ledger.md` 统一为 `developer/message` / content-only `tool/result`，并注明 `assistant/message` 从不作为 replacement |
| F2 `defineTool` 注册 | 已修复 | `docs/how-it-works.md`、`decision-record.md`、`evidence-ledger.md`、`docs/reports/README.md` 改为普通 definition + 共享 parser；harness 断言名称同步 |
| F3 mutation 时机 | 已修复 | `README.md`、`how-it-works.md`、`decision-record.md` 区分 `tool/result`/`user/message` 当前 step 与 `step/start` 延迟 |
| F4 pre-step 等待语义 | 已修复 | 同上，明确无 open step 时不等待，只把编辑留给 `step/start` |
| F5/F13 `CLM_CLEANUP_RESULT` | 已修复 | `README.md`、`how-it-works.md` 标注 DSH-only；`none` 只压缩删除/拒绝确认，listing 始终返回内容 |
| F6 estimator fallback | 已修复 | `README.md` 改为显式处理 `reasoning`/`tool-call`/`tool`，仅未识别形状走 fallback |
| F7 mirror 上限 | 已修复 | `README.md`、`how-it-works.md` 区分 Pi 固定与 DSH 环境变量覆盖 |
| F8 发布白名单 | 已修复 | `package.json` 的 `files` 显式列出公开 docs 和源码目录；`npm pack` 不再包含 `docs/reckless/`；README 同步 |
| F9 auto / 进程级 override | 已修复 | `README.md`、`changelog.md`、`dsh/index.ts` 状态文本统一为 process override |
| F10 budget nudge | 已修复 | `README.md` 写明 `cleanup` 或一次 mirror 编辑，阈值约 `0.75 × max(1, budget - 2048)` |
| F11 branch 刷新 | 已修复 | `README.md` 改为 branch 切换标记待刷新、下一次 `context` hook 刷新 |
| F12 cleanup 事件类型 | 已修复 | `README.md` 拆开 cleanup omission 与普通 mirror replacement |
| 版本叙事 | 已修复 | `package.json`、`dsh-plugin.json`、`changelog.md`、`README.md` 统一到 `0.1.7`；重建 `artifacts/oh-my-clm-0.1.7.tgz` |
| 内部证据漂移 | 已修复 | `decision-record.md`、`evidence-ledger.md`、`docs/reports/README.md`、`dsh-host-test-report-current.txt`、`roadmap.md` 同步当前默认值、事件类型、计数和签名 |
| 低优先级完整性 | 已修复 | `docs/project-structure.md`、`docs/README.md`、`README.md` 的目录树/命令/正常追加措辞 |
| 外部资料标注 | 已修复 | `docs/dsh-cache-explained.md` 标为社区观测；`docs/CLM技术分析表.md` 标为文献整理、未重跑 |

### 9.2 复验结果

```text
npm test
  -> 88 tests, 88 pass, 0 fail

npm run check
  -> Module boundaries OK
  -> tsc -p tsconfig.dsh.json
  -> DSH package check passed

npm run typecheck
  -> exit 0

node test/harness/clm-dsh-host-test.mjs .
  -> 99 passed, 0 failed, 1 observation
  -> observation: agent.id/session.id mismatch — session/event sync still matched (state is session-scoped)

npm_config_cache=/tmp/npm-cache-clm npm pack --dry-run --json
  -> 31 files, no docs/reckless/

npm_config_cache=/tmp/npm-cache-clm npm run build:dsh:plugin
  -> artifacts/oh-my-clm-0.1.7.tgz, 13 files
```

未复验项与第 6 节相同：真实 DSH profile 的安装/restart/fork、`session/flush`、模型是否会主动 `cleanup`/`list`，以及外部资料中的具体数字。它们仍是 unresolved，不应被本报告的修复状态误读为已证明。

---

*第 1–8 节保留修复前核查结果；第 9 节记录修复与复验。*
