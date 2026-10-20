# 更新日志

版本号同时记录在 [`package.json`](./package.json) 和 [`dsh-plugin.json`](./dsh-plugin.json) 中。以下按版本倒序列出使用者可见的变更；更早的实现细节见 git 提交记录和 [`docs/features/live-context-mirror.md`](./docs/features/live-context-mirror.md)。

## 0.1.11（当前版本）

### 修复

- **body 里出现协议字面量不再毁掉整个 mirror。** 此前渲染是把 body 原样写进文件，所以只要某个 block 的正文里有 `[[CLM_ENTRY id=N role=...]]`（典型来源：模型在推理里引用了一段 mirror，或 tool call 参数里带着 mirror 片段），解析器就会把它当成真的块开标记：先是重复 / 未闭合 ID，接着**每一次** cleanup 都被拒（`Cannot remove malformed CLM_ENTRY id=…`，哪怕请求里根本没有那个 ID），最后 `turn_end` 判定编辑非法并静默回滚。现在渲染端给这类行加一个转义反斜杠（`escapeMirrorBody()`），解析端读回时去掉（`unescapeMirrorBody()`），body 逐字往返，已经转义的行再加一层、反复渲染稳定。
- **解析、规划、删除共用一个顶层扫描器。** 新增 `scanMirrorBlocks()` 状态机：block 打开后只有它自己的 closing marker 能改变状态，其余 marker 形状的行一律当正文。`parseMirror()`、`parseCleanupMirror()`、`removeMirrorBlocks()` 都从这里取 span，所以“规划认可的块”和“实际删除的块”不可能不一致；手写未转义的 marker 也不会凭空多出块。
- **cleanup 失败不再半途抛异常。** `removeMirrorBlocks()` 改为返回 `{ ok: true, text } | { ok: false, reason }`：缺 closing marker、重复顶层 ID、目标 span 不存在都会作为带具体 ID 的 `rejected` 结果回来，而不是在 `planCleanup` 通过后于写盘阶段抛错。原因文本同时提示“body 里的 marker 需要转义反斜杠”。
- **被回滚的 mirror 编辑会告知模型。** 以前 `turn_end` 拒绝编辑只发一条 UI 通知，下一次 `syncMirror()` 直接把文件恢复成 canonical projection，模型看到的是“写入成功、内容凭空消失”。现在拒绝原因会以一条一次性的 `<pi-clm-edit-notice>` 用户消息进入下一次请求（`context` 钩子注入，注入后清空），并区分“被拒绝”与“不在 turn 边界内，未提交”。
- **mirror 转义进入协议。** 文件 header 增加一行说明，提示词增加一句“body 里的 marker 行保留前导反斜杠”（Pi 侧仍 ≤1000 字符）。这是 `clm-v2` 的渲染约定而不是新协议版本号：snapshot 仍由 canonical records 计算，转义只影响显示层，因此旧 mirror 文件无需迁移即可被新解析器读回。

### 文档

- **`docs/features/live-context-mirror.md` 新增 §3.1 Body 转义。** 说明转义规则、`escapeMirrorBody()` / `unescapeMirrorBody()` 的往返关系、`scanMirrorBlocks()` 只认顶层标记，以及 §5.3 的“外部修改被回滚时会告知模型”。`README.md` 的编辑规则和 `docs/features/cleanup-tool.md` 的删除语义同步补齐。

## 0.1.10

### 调整

- **提示词点名"改写 tool-call block"这条折叠路径。** 携带 tool call 的 assistant block 被改写时，扩展本来就会一并省略配对的 toolResult（`planContextEdits` 的配对规则，已有测试覆盖），所以"写一句事实 + 收掉原始输出"是一次编辑就能完成的事——不需要新工具，也不需要先把大块输出读回来再摘要。两个宿主的提示词各加一句说明这一点（Pi 同时注明不要改写仍在产出的 step）；两处提示词长度守卫相应校准（Pi `≤ 900` → `≤ 1000`，DSH 维持 `≤ 800`，实际 692）。触发物是模型此前不知道这条路径存在，而不是能力缺失。
- **cleanup 的顺序冲突不再伪装成 stale。** Pi 侧 mirror 在同一个 step 里被改过（先写 body 再调 cleanup），文件的 snapshot 就落后于 live projection，`cleanup` 会整体拒绝——但旧原因只写 "The mirror snapshot is stale"，模型看到的是一个无法行动的 dead end，而实际修法很简单：一个 step 最多一次 cleanup，且放在该 step 任何 mirror 编辑之前。现在命中的是这条可行动原因（共享规划器未改，host 侧按"本 step 已改动"判定），并有回归测试固定"原因可读、mirror 不被重渲染、块不被删除"。实测确认 Pi 的 `turn_end` 是 per-step 触发，跨 step 的多次 cleanup 会正常应用，因此受限的只是同一 step 内的顺序。
- **DSH 提示词不再建议先读再写。** 删掉 `read just the block you are shortening`：它把大 body 回读当成前置步骤，而这正是慢且易丢真的路径（回看时拿到的是截断 preview）；现在只说"改 body，保留协议行"，实际长度 692 字符（上限 800）。

- **npm keywords 补齐到 10 个。** 从 `pi-package`、`pi-extension`、`context-management`、`clm` 扩展为同时覆盖宿主（`pi-coding-agent`、`dsh-plugin`）和概念（`context-engineering`、`live-context`、`llm-context`、`agent-memory`）的词表，让两种搜索意图都能命中：找 Pi 扩展的人和找上下文管理方案的人。keywords 只随版本打包，npm 不提供修改已发布版本的接口，所以只能靠这次发版生效。

### 修复

- **DSH 打包产物的 keywords 不再与 `package.json` 漂移。** `scripts/build-dsh-plugin.mjs` 之前把 `["dsh-plugin", "context-management", "clm"]` 写死在脚本里，每次 `build:dsh:plugin` 都会用这份旧词表覆盖主 `package.json` 的，两边只能靠人工同步。现在改为从 `package.json` 派生并过滤掉 Pi 专属词（`pi-package`、`pi-extension`、`pi-coding-agent`），`dsh-plugin` 固定置为第一个：根包 10 个词、DSH 包 7 个词，共享词只有一处来源。
- **keywords 进入发布前校验。** `scripts/check-dsh-package.mjs` 新增校验：必须是数组、非空、全小写单 token、无重复、保留 `pi-package` 宿主标记。npm 发布后无法修改 keywords，拼写错误只能在 `npm run check` 阶段拦住，否则要等下一次发版才能纠。

### 文档

- **`docs/` 按用途重组。** 平铺文件改为分组目录：`docs/features/`（live-context-mirror、cleanup-tool、dsh-surface-bridge）、`docs/reference/`（CLM 技术分析表、DSH 前缀缓存），`docs/reports/` 保持原样；`package.json` 的发布白名单同步改为目录，根 README 与 `docs/README.md` 的内部链接全部指向新路径。
- **README 不再复述版本历史。** 删掉正文中的版本区间和具体版本号引用，版本说明统一由 [`changelog.md`](./changelog.md) 承担。

## 0.1.9

### 调整

- **移除 Pi 扩展底部状态栏。** 不再通过 `ctx.ui.setStatus` 在 footer 持续显示 `CLM ctx … · N blocks · mirror path`，也不再为 branch 切换或会话关闭写状态。`/clm status` 命令保留，状态信息仍通过通知按需查看；仅服务于状态栏的内部提示状态一并删除。

### 修复

- **Pi 会话内 `cleanup` 不再恒被 stale 快照拒绝。** Pi 在请求时写 mirror（`context` 钩子 → `syncMirror`），随后才把带本次 `cleanup` 调用的 assistant 消息追加进 projection，因此工具执行时 records 总比文件多一条，`planCleanup` 的 `CLM_SNAPSHOT` 指纹校验必然失败——实测同一会话连续 4 次删除都返回 `The mirror snapshot is stale; refresh it before cleanup.`，只有 `list` 可用。现在 `executePiCleanup` 会在计划删除前重新同步 mirror，但仅当磁盘内容仍逐字节等于本扩展上次渲染的文本（即没有未合并的模型编辑），否则保持原有的 stale 拒绝，避免覆盖尚未应用到 session 的编辑。新增两条回归测试：一条让 projection 在 sync 之后继续增长并断言删除成功，一条断言磁盘上的未提交编辑不会被重新渲染冲掉。

## 0.1.8

### 修复

- **npm 页面 README 的文档链接改为绝对 GitHub 地址。** npm 包的 README 渲染页不解析仓库相对路径，`./docs/...`、`./changelog.md` 等链接会落到不存在的 npm 页面。现在 README 中的文件链接全部指向 `https://github.com/DevZjQx/oh-my-clm/blob/main/...`；同时在 `package.json` 补充 `repository`、`homepage` 和 `bugs` 元数据，让 npm 页面能正确显示仓库入口。

## 0.1.7

### 新增

- **Turn digest 索引现在是默认（`CLM_INDEX_MODE=blocks` 可回退）。** 索引不再只能逐个列 block：digest 模式每个已完成 turn 一行，给出包含式 ID 区间、块数、估算 token 成本和该 turn 的第一条 user 消息；正在进行的 turn 只给稳定锚点 `IDs N..`。文本在一个 turn 内字节不变，DSH 的快照去重因此命中，索引只在 turn 边界追加。用 `CLM_INDEX_LINES`（默认 40）限制列出的 turn 数。在 7 个真实会话上回放：blocks 模式 224 条快照 / 1.09MB，digest 预测 40 条 / 约 36KB（约 30 倍），见 E-028。真实会话里已经实测：切换后 2 条 digest 快照分别是 684 B 与 749 B，当前渲染与线上文本逐字节一致；同一 turn 内继续追加 block 不再产生新快照。`CLM_INDEX_MODE=blocks` 或 `/clm mode blocks` 可随时回到旧索引。
- **`cleanup` 支持区间和角色过滤。** 新增 `ranges: ["3-16"]`（包含式）与 `skipRoles: ["user"]`，可以直接删掉一个 turn 的 tool 噪声而保留人类消息。显式 `blockIds` 仍然严格校验未知 ID；range 越界夹取，range 覆盖 block 1 时保留 block 1。两个宿主（Pi / DSH）的 schema、prompt 与结果格式同步更新。
- **配对级联删除单独上报。** 工具结果新增 `pairedRemovalIds`，文本结果写成 `Paired (not requested): 42`，不再把“没请求却被删”的 ID 混进 `removed`。这正是 `session-08a1d65f` 里 42 被误认为索引错误的来源（E-028）。
- **`/clm mode [blocks|digest|auto]`（DSH）。** 进程环境只在启动时读取，无法在运行中 A/B；新增命令在当前进程里切换索引形状（`indexModeOverride`），并清空所有缓存的索引文本，从下一步生效；`auto` 撤销进程级覆盖、回到 `CLM_INDEX_MODE`（默认 `digest`）。系统提示里的索引说明改为模式中立，因此切换后不会残留旧形状的描述；`/clm status` 会显示当前模式。
- **`scripts/measure-session-index.mjs`。** 只读脚本，从 `~/.dsh/sessions` 的真实日志统计索引快照数、字节、步间隔、cleanup 调用形态，并给出 blocks/digest 对比；`--project .` 只看当前项目，`--json` 输出结构化结果。
- **`cleanup({ list: "A-B" })` 只读展开。** 索引会命名被省略的区间，但看不到区间里是什么；新增的 `list` 参数返回该区间的逐块行（role + 短 preview），不删除、不写 mirror、不依赖 snapshot，两个宿主都支持。它只能单独使用，不能和 `blockIds`/`ranges`/`skipRoles` 混在一次调用里，避免“边看边删”。单次结果有约 6 KB 字符预算，截断时末尾给出继续读取的区间，而不是静默返回部分视图。`CLM_CLEANUP_RESULT=none` 不会吞掉 listing 内容（它只压缩删除确认）。
- **Digest 增加最大省略 turn 一行。** turn 数超过 `CLM_INDEX_LINES` 时，被折叠的 turn 按估算 token 排序取前三，写成 `... largest omitted turns: 21-24 (4.1k tok), 31-33 (2.9k tok).`。它只读已完成 turn，所以仍然在一个 turn 内字节稳定；回答的是“看不见的那段里哪一段最值得回收”。

### 调整

- **两个宿主的系统提示收紧，并统一 mirror 的定位。** DSH 的 `promptText()` 从 12 条 bullet / 约 4.1 KB 降到 4 句 / 679 字符；Pi 的 `promptAppendix()` 从 14 条 bullet / 约 2.7 KB 降到 2 段 / 735 字符（含 mirror 路径），预算 nudge 从 3 句压到 2 句，`cleanup` 的 `promptGuidelines` 从 5 条减到 2 条。删掉的是：工具 API 复述（`blockIds`/`skipRoles`/`list` 已在 `cleanupParameters` 里由 schema 说明）、`CLEANUP_DISCIPLINE` 常量（最后一个使用处随之下线）、mirror 文件格式细节（`CLM_ENTRY`/`CLM_EMPTY`）、索引刷新节奏、编辑校验与回滚、宿主与 sandbox 的 `/tmp` 差异、session 事件时序，以及 `CLM_CLEANUP_RESULT`/`CLM_CONTEXT_BUDGET` 等运维开关。保留的是模型真正需要的一条：mirror 可编辑（shrink 压缩），但删除优先走 `cleanup`。DSH 的系统提示段是进程级静态文本，只能给 `/tmp/clm-<session-id>/LIVE_CTX_MAIN.md` 模板；具体路径由 runtime context 在 block index 上方以 `Mirror:` 一行给出，模型不必猜 session id，也不必去 `ls` sandbox 的 `/tmp`。`dsh-bridge.test.ts`（800 字符）、`extension.test.ts`（900 字符）与 `clm-dsh-host-test.mjs` 都加了长度上限和“不含 API 参数 / 环境变量”的断言，两个 prompt 旁的注释写明同一约束，防止这些内容再次长回来。
- **`blocks` 窗口从“中点 25 块”改为“head 12 + 最近 40 块”。** 索引的唯一用途是把模型还记得的内容翻译成 ID 和区间：中点附近的 block 既不记得（64 字符 preview 也重建不了），也不是清理对象，而最近几轮刚产出的 tool 噪声才是。用 200 字符 fixture 测量：200 块索引从 70 行 / 5,559 B 降到 56 行 / 4,486 B，同时覆盖了原来完全不出现的尾部 40 块；中间区间仍由一行省略行命名。真实会话回放里唯一一次真正依赖窗口的长会话 cleanup（`ranges: ["171-177"]`，当时 383 块）目标原本落在省略区间 41–178 内，新窗口覆盖 334–383，仍然要靠 `cleanup({ list })` 或 mirror 才能定位——这正是把预算从“位置覆盖”转向“最近可识别内容 + 按需展开”的依据。
- **`CLM_INDEX_MIDDLE` 改名为 `CLM_INDEX_TAIL`。** 它现在表示尾部窗口宽度（默认 40）；旧环境变量名仍作为回退值读取，避免已有 profile 的覆盖静默失效。`BlockIndexOptions.middleBlocks` 同步改为 `tailBlocks`，`selectMiddleWindow` 被 `selectTailWindow` 取代。
- **两种索引的说明行同步更新。** `blocks` 与 `digest` 的 caption 都提到 `cleanup({ list: "A-B" })`；系统提示里的 `cleanup` 说明、`CLEANUP_DISCIPLINE` 和索引契约都改为“不确定某个区间里是什么就先 `list`，而不是猜着删”——区间删除本身仍然可用，listing 是消除不确定性的廉价手段，不是强制前置。
- **DSH 系统提示不再解释宿主内部持久化机制。** 移除了 `Session.append()` 的 surface-replacement seam、`sourceEventSeqs` 约束、`developer/message` 归因，以及“这是 DSH surface replacement，不是 Pi 的 branch-local `context_edit`”等说明——它们只关系到 bridge 实现，和模型该做什么无关，只会分散注意力。只保留一条可执行规则：bridge 会校验每次编辑，无法应用的编辑会被拒绝并恢复 canonical mirror，重新读取 mirror 而不是盲目重试。两个测试改为断言提示词不含这些实现细节，防止再次漏回。
- **Block index 的 middle 改为以会话中点为中心。** 此前 middle 紧接在 head 之后，长会话里只能看到开头 64 条。现在 `CLM_INDEX_MIDDLE`（默认 25）表示一段以中点为中心的窗口：200 块会话列出 1–40 和 88–112，head 与窗口之间、窗口之后的 block 不列出。窗口在贴近 head 或末尾时会整体平移以保持宽度，短会话里仍表现为紧接 head 的连续段。
- **Block index 用省略行标出被跳过的 ID 区间。** 此前 head 与窗口之间、窗口之后的 block 静默消失，ID 从 40 直接跳到 88 只能靠系统提示里的一句话解释，列表末尾也容易被误当成会话末尾。现在每个未列出的连续区间都会插入一行 `... N editable block(s) omitted (IDs A-B).`（head 与窗口之间一行，窗口之后一行）；全部列出时不加任何省略行。只有 65 块以上的会话才会出现，两行合计约 100 bytes（200 字符 fixture 下 200 块索引为 70 行 / 约 5.6KB）。
- **系统提示里的 block index 说明收紧为一句。** 索引现在自带省略行和 `cleanup` 调用提示，系统提示不再复述 head/middle 尺寸、省略行格式和“从索引里选 ID”，只保留索引存在与刷新节奏，`promptText()` 也不再读取 `CLM_INDEX_HEAD`/`CLM_INDEX_MIDDLE`（尺寸仍由 `optionsFor()` 决定）。
- **Block index 按 turn 节流并瘦身。** DSH 只在 runtime-context 快照文本变化时追加新快照；此前索引每步都随新 block 变化，导致每步一条完整快照，长会话持续累积重复索引。现在：
  - 静态协议（tag 含义、cleanup 纪律、block 1/protected 规则）移入 `oh-my-clm:live-context` 系统提示段，索引只保留 tag、一行提示和块行。
  - 单块 preview 默认 64 字符；索引改为 head 40 + middle 24（共 64 条），移除 tail 和中间摘要；新增 `CLM_INDEX_PREVIEW`、`CLM_INDEX_HEAD`、`CLM_INDEX_MIDDLE`（`CLM_INDEX_TAIL` 移除）。
  - 同一 turn 内最多每 `CLM_INDEX_REFRESH_STEPS`（默认 4）步重渲染一次；`cleanup`/mirror edit 生效后立即失效，compaction 事件保守失效；`CLM_INDEX_REFRESH_STEPS=1` 恢复每步刷新。
  - 预期：80 块索引从约 9.9KB 降到约 5.5KB（200 字符 fixture，只列前 64 条）；100 步 turn 的索引快照从 100 条降到约 25 条。

### 修复

- **K=4 索引节流此前从未生效。** DSH 在 `agent/pre-step` 组装 runtime context，然后才追加 `step/start`；上一步的 `step/end` 已经写入，所以渲染时没有打开的 step，旧缓存键 `{turn, step}` 永远写不进去，索引每步都重新渲染。7 个真实会话的 224 条快照间隔全部是 1 步（223 次）或 2 步（1 次），从没出现过 4。缓存键改为“打开中的 turn + 已关闭 step 数”，108 步模拟从 108 段不同文本降到 27 段（E-027）。
- **README 的索引说明纠正。** 此前写作“没有 tail 或省略摘要”，实际从 0.1.6 起每个未列出的连续区间都有省略行；现已按 blocks/digest 两种模式重写。
- **DSH bridge state 统一按 session id 键。** `agent/created` 之前按 agent id 保存，而 `cleanup` 工具按 session id 读取；两者不同时 cleanup 拿不到 state，索引缓存也不会在删除后失效。现在 `agent/created`、`session/event`、`agent/disposed` 和 cleanup 查找都使用 session id。

## 0.1.6

### 新增

- **DSH 插件新增 `/clm` 命令。** 与 Pi 扩展的 `/clm status` 对齐，`/clm` 和 `/clm status` 等价。命令从当前 session surface 实时计算状态，显示 mirror 路径、artifact 是否与 canonical projection 一致、字节数、可编辑/保护 block 数、preview/canonical token 估算、DSH surface 节点数、shrink-only 策略和 mirror 限制；未知参数返回 `Usage: /clm [status]`。它是纯只读命令：不写 mirror、不追加 session event、不依赖缓存，因此在第一次 bridge pass 之前也能工作。新增 host mock 测试覆盖注册、状态文本、`in sync`/`missing` 判定和参数校验。

## 0.1.5

### 新增

- **`cleanup` 结果默认紧凑化，新增 `CLM_CLEANUP_RESULT`。** DSH 的 cleanup 工具结果默认只返回一行确认（状态 + 请求/移除 ID），不再附带刷新后的 block index——同一份索引已经由 `systemPrompt.context` 在每步动态重渲染，重复拷贝只是噪声。`CLM_CLEANUP_RESULT=full` 恢复附带索引的旧行为，`none` 只压缩删除/拒绝确认（后续加入的 listing 不受影响）；工具调用与结果事件本身仍完整保留在 session surface 中。Pi 扩展没有索引拷贝，行为不变。
- **`cleanup` 使用纪律进入模型可见上下文。** 新增导出常量 `CLEANUP_DISCIPLINE`（`src/features/live-context/context-format.ts`），同时用于 DSH 的 `<oh-my-clm-block-index>` 末尾和 Pi 的 system prompt，避免两侧措辞漂移。内容只有两条可机械执行的规则：把要删的 ID 合并在一次调用里（删完会重新编号，不要用旧 ID 连续调用）；tool-call block 与配对结果一起删、优先清理 assistant/tool-result 噪声而不是 user turn、拿不准的 ID 留到下次。两个 host 的 `blockIds` 参数说明也补上“一次调用传完”的提示。索引净增约一行。

### 修复

- **DSH 插件里 `cleanup` 工具每次调用都报 `INVALID_TOOL_OUTPUT`。** 0.1.5 让 `cleanup` 结果带上 `copy` 字段供渲染层选择输出长度，但 DSH 会先用工具声明的 `output.schema`（`additionalProperties: false`）校验返回值的每个属性，未声明的 `copy` 直接让整次调用失败：`tool "cleanup" returned invalid output: "value.copy" is not a declared property`，清理实际上已生效却拿不到结果。现在 `copy` 只作为宿主侧渲染状态保留在 `executeDshCleanup` 的返回值里，`dsh/index.ts` 在 return 前把它剥离，渲染改由 `CLM_CLEANUP_RESULT` 重新解析。新增测试用 DSH 自己的 `validateJsonSchemaValue` 校验三种 copy 模式下的返回值，防止再次携带未声明字段。
- **DSH 插件管理器不显示自定义图标。** DSH 通过 `readPluginMeta` 解析 `<pkg>/package.json` 读取顶层 `icon`，而这个路径受 `exports` 约束；原 `exports` 没有 `"./package.json"`，解析被 `ERR_PACKAGE_PATH_NOT_EXPORTED` 静默跳过，只剩 `locale` 里的标题/描述，图标回退到默认图。根包和 `build:dsh:plugin` 生成的专用包现在都导出 `./package.json`，`check-dsh-package` 与 manifest 测试也会校验 `icon` 和这两个导出，防止回归。

### 调整

- **Mirror 协议头改为宿主中立的 `clm-v2`。** 原 `<!-- pi-clm-v2 -->` 由 Pi 扩展和 DSH bridge 共用，但名字暗示它只属于 Pi；现在写入统一为 `<!-- clm-v2 -->`。旧头不再被识别：升级后 `/tmp` 里遗留的 mirror 会在下一次同步被新头重写，按旧头编辑则会被拒绝。协议识别、自读保护和 cleanup 错误文案现在都从 `MIRROR_VERSION` / `MIRROR_HEADER` 单一来源派生，避免版本升级时再次漂移。
- **源码改为 `src/lib` + `src/features/live-context` 两层。** 共享的 mirror 文件写入和路径解析移到 `src/lib`；mirror 协议、cleanup 和 DSH bridge 移入 `src/features/live-context`；Pi/DSH 入口路径保持不变。
- **测试按层分组。** `test/` 现在镜像源码分层（`lib`、`features/live-context`、`adapters`、`package`），手动 mock-host harness 移到 `test/harness/`。
- **构建产物目录从 `dsh-clm/` 改名为 `artifacts/`。** 历史验证报告早已移到 `docs/reports/`，但 `dsh-clm/` 和源码目录 `dsh/` 名字过于接近，容易被当成同级的源码/产物对而误合并。输出目录改为 `artifacts/` 并继续 gitignore；`scripts/build-dsh-plugin.mjs` 的默认输出、README、项目结构文档同步更新，`dsh/`、`dist/dsh/` 这些宿主约定路径保持不变。
- **删除已移除功能的空占位文件。** 移除 `src/compact.ts`、`src/trajectory.ts` 和同名的空测试。
- **新增单向依赖检查。** `scripts/check-boundaries.mjs` 接入 `npm run check`，检查 `shared → feature → host adapter` 的导入方向、跨 feature 导入和 barrel 文件。目录职责见 [`docs/project-structure.md`](./docs/project-structure.md)。
- **更换插件图标。** `icon.svg` 改为“长度递减的上下文块 + 琥珀色清理徽标”的扁平图标，对应 shrink-only 的上下文整理动作；深色圆角底保证在浅色和深色界面中都可用，16–48px 下仍能辨认。

发布包中的入口仍然是 `extensions/clm.ts` 和 `dist/dsh/index.js`；`package.json` 的 `files` 白名单和 `tsconfig.dsh.json` 已同步新的源码路径。

## 0.1.4

### 调整

- **block index 改为头部 40 + 尾部 40。** 当可编辑 block 超过 80 个时，runtime context 只列出前 40 个和后 40 个，中间的 ID 区间用一行摘要表示；这样长会话仍能看到最新 block 的 ID，同时避免索引无限增长。`cleanup` 的结果仍然返回清理后的完整 head/tail 索引。

## 0.1.3

### 新增

- **block ID 进入聊天上下文。** DSH bridge 现在通过 `systemPrompt.context()` 注册一个 `oh-my-clm:block-index` runtime context，列出当前可编辑 block 的 1-based ID、role 和短 preview；`cleanup` 的结果也会带上刷新后的 index。模型可以直接按 index 里的 ID 清理 stale block，不需要先读 `LIVE_CTX_MAIN.md` 找内容或 ID。runtime-context snapshot 本身不是用户 block，会从 mirror records 中排除，因此不会成为 cleanup 目标，也不会让 index 递归列出自身。只有需要完整正文做 rewrite 时才需要打开 mirror。

## 0.1.2

### 修复

- **`developer/message` 的 turn/step 必须取 append 时真正打开的 step。** 0.1.0/0.1.1 在批量 cleanup 时为每个目标 assistant/tool-result 事件复制它自己的 `turn`/`step`，或对没有 turn/step envelope 的 `user/message` 回退为 `0`。DSH 把 `developer/message` 当作 step-scoped 事件：重放要求 `turn`/`step` 为正数，并且必须等于日志当前打开的 turn/step。被清理的目标通常来自更早的 step，而 cleanup 本身运行在最新的 step 中，于是追加了坐标过期的事件：轻则加载/重放时报 `developer/message turn must be positive`，重则把不匹配的事件持久化，下一次加载报 `developer/message does not match an open turn and step`，整个 session 无法恢复。0.1.2 从 session log 推导 append 时真正打开的 turn/step，omission 和 assistant 改写都使用这一对坐标；`tool/result` 改写仍严格保持原 event envelope，只改 `content`（DSH 只允许 content-only rewrite）。此外，`agent/pre-step` 运行在 `step/start` 之前，此时没有打开的 step，bridge 不再在那里执行 mutation，而是把待处理编辑留到 `step/start` 事件之后应用；没有打开的 step 时 mutation 会安全拒绝，不再写入损坏事件。已经由旧版本写入的损坏 session 不会自动恢复，需要用 session repair 脚本或备份修复。

## 0.1.1

### 修复

- **不要把 DSH host 包放进 `dependencies`。** 0.1.0 在 `dependencies` 中声明了 `@deepseek-ai/dsh-tools`。pnpm 会把这份 host 包安装/提升到 profile 的 `node_modules`，于是 profile 内的 `@deepseek-ai/dsh-tools` 副本会遮蔽 dsh 安装自带的同一模块。`dsh-agent-loop` 用模块级 `Symbol("@deepseek-ai/dsh-tools.scheduler")` 访问工具调度器，两份模块各有一个 Symbol 实例，结果 `ctx.tools[TOOL_RUNTIME_SCHEDULER]` 为 `undefined`。症状是每个工具调用都已经写入 `tool/call`，但紧接着整步失败并补写一条 `TOOL_OUTCOME_UNKNOWN`/`interrupted` 结果：

  ```text
  The tool call was interrupted after it was recorded, but no result was durably recorded. ...
  ```

  0.1.1 不再在运行时的任何位置导入 `@deepseek-ai/dsh-tools`（cleanup 工具直接返回纯 JSON tool definition，并复用 `parseCleanupArgs` 做参数校验），`@deepseek-ai/dsh-tools` 只作为可选 `peerDependencies` 保留给 DSH 的兼容性检查，因此安装插件不会再向 profile 注入 host 包副本。若旧版本已经安装，先移除 profile 里的残留副本再重启（例如重新执行 `dsh plugin --profile <name> remove oh-my-clm` 后安装新包，或删除 profile 的 `node_modules/@deepseek-ai` 中由该插件带入的副本）；仅禁用 bundle 不足以恢复。

- **普通 mirror 改写被 DSH 拒绝。** 0.1.0 把 assistant block 的缩短结果写回 `assistant/message`。DSH 要求每个 surface replacement 用 `sourceEventSeqs` 覆盖所有被遮蔽节点，却又禁止 `assistant/message` 携带 `sourceEventSeqs`（它内嵌 provider stream），因此这类改写必然失败：缺少引用时报 `sourceEventSeqs must include every shadowed surface node`，补上引用后又报 `assistant/message ... cannot carry sourceEventSeqs`。0.1.1 改用可携带引用的 `developer/message` 承载 shorter assistant text（omission 仍是空 `developer/message`），`tool/result` 仍按 DSH 的 content-only 规则改写；assistant tool-call 被改写时配对的 tool result 仍会一起 omit，避免孤立 tool message。由于 `developer/message` 不属于 mirror 的可编辑区域，被改写的 assistant block 在后续 mirror 中不再出现，这是 DSH surface 语义的直接结果。

## 0.1.0

- 初始版本：Pi live-context 扩展（projection → live mirror → `cleanup`/`context_edit`）与最小 DSH bridge 的初始实现。
