# Cleanup 与 block index

`cleanup` 是 Pi 与 DSH 共用的历史整理入口。模型按 **1-based editable block ID** 删除 stale、重复或自指内容，不需要读取完整 body，也不会受 mirror preview 截断影响。删除不可逆，因此另有 `offload`：保留 block 的 ID、role 和位置，只把正文换成一行由模型撰写的 `[offloaded: <note>]`。

block index 把可操作的地址放进模型可见的 runtime context，使模型不必先打开 mirror 就能决定删什么。

## 工具契约

```text
cleanup({ blockIds: [2, 3, 4] })
cleanup({ ranges: ["3-16"], skipRoles: ["user"] })
cleanup({ offload: [{ blockId: 2, note: "旧测试套件在 X 上失败，已修" }] })
cleanup({ offload: [{ blockId: 2, note: "..." }], blockIds: [4] })
cleanup({ list: "3-16" })
```

| 参数 | 语义 |
| --- | --- |
| `blockIds` | 显式单块 ID。未知、重复、过期或协议损坏的 ID 整体拒绝。 |
| `ranges` | 包含式区间，如 `"3-16"` 或 `"42"`。越界夹取；覆盖 block 1 时保留 block 1。 |
| `skipRoles` | 在区间内保留指定角色。`["user"]` 可删掉一个 turn 的 tool 噪声而保留人类消息。 |
| `list` | 只读展开：返回区间内逐块行（role + 短 preview），不删除、不写 mirror。 |
| `offload` | 逐块软卸载：保留 ID/role/顺序，正文换成 `[offloaded: <note>]`；可与删除参数混用。 |

规则：

- ID 是当前 mirror/index 的编辑序号；不改 ID、不重排 block。
- `list` 不能与 `blockIds` / `ranges` / `skipRoles` / `offload` 同时出现。
- `offload` 的 note 必须单行、非空、≤240 字符，替换后的估算 token 必须严格小于原正文；note 不能携带保留来源声明（`oh-my-clm … source=/owner=/agent=/trusted=/provenance=`）或 preview 截断 marker。
- `offload` 只允许 `assistant` / `toolResult`。block 1 是 load-bearing 锚点；user-authored 正文只能省略，不能被 note 取代。
- offload 带 tool call 的 assistant 会丢掉 tool call 结构，因此配对 tool result 一起 omit；offload tool result 只是内容改写，owner assistant 保留。
- 显式 ID 1 拒绝；range 覆盖 1 时保留 1。共享的 `loadBearingRecord()` 守卫让 mirror 编辑路径同样无法删除 block 1。
- 配对级联删除单独报告为 `pairedRemovalIds` / `paired`，不混入调用者请求的 ID。
- 删除最后一个可编辑 block 时保留 `<!-- CLM_EMPTY -->`；`offload` 不删除 span，因此不触发 `CLM_EMPTY`。
- 删除与 offload 使用与解析相同的顶层 span 扫描；body 中引用或手写的 `[[CLM_ENTRY ...]]` 不会被当成可删块。
- 损坏（缺 closing marker、重复顶层 ID、目标 span 不存在）返回 `rejected` 与具体 ID；写盘失败返回结果对象，不产生半状态。
- Pi 侧一个 step 最多调用一次 cleanup，且必须在该 step 任何 mirror 编辑之前。同一 step 先改 body 再 cleanup 会整体拒绝，reason 会点明顺序。
- 单次 `list` 结果约 6 KB 字符预算；截断时末尾给出继续读取的区间，不静默返回部分视图。

## block index

DSH 通过 `systemPrompt.context()` 把 `<oh-my-clm-block-index>` 放进 runtime context。索引与 cleanup 使用同一组 1-based ID。

### digest（默认）

每个已完成 turn 一行：包含式 ID 区间、块数、估算 token 成本、该 turn 的第一条 user 消息。正在进行的 turn 只给起始锚点 `IDs N..`，不列出。

```text
<oh-my-clm-block-index>
Editable blocks by cleanup ID; ranges are inclusive. One line per turn; call cleanup({ ranges: ["A-B"] }) to omit a turn, cleanup({ list: "A-B" }) to read its rows.
1-2. assistant+toolResult ×2 (35 tok): I inspected the repository and found a small TypeScript project.
3-4. turn ×2 (17 tok): user (10 tok) + 1 noise: Keep the important repository fact.
IDs 5.. (current turn, not listed): One more turn.
</oh-my-clm-block-index>
```

文本在一个 turn 内逐字节不变，DSH 只在 turn 边界追加一条快照。`index.maxLines` 限制列出的 turn 数；被折叠的 turn 按估算 token 排序，最多取三个写成 `... largest omitted turns: A-B (x tok), ...`。

### blocks

`index.mode: "blocks"` 改为逐 block 列表，附 role 和单行 preview（`index.previewChars`，默认 64 字符）。列前 `index.headBlocks` 个 block（默认 12，开头“别动”锚点）加最近 `index.tailBlocks` 个（默认 40）；中间连续区间用 `... N editable block(s) omitted (IDs A-B).` 标出。

### 刷新

索引的静态协议放在 system prompt，随 prompt 缓存；runtime context 只携带动态行。同一 turn 内最多每 `index.refreshSteps`（默认 4）步重渲染一次，按“打开中的 turn + 已关闭 step 数”计数；`1` 恢复每步刷新。追加 block 不重编号，删除会重编号，因此 cleanup 或 mirror edit 生效后立即清空缓存并重渲染；compaction 也保守失效。

DSH 的 `/clm mode [blocks|digest|auto]` 在当前进程切换索引形状并清空缓存，从下一步生效；`auto` 回到配置文件的 `index.mode`（默认 `digest`）。这是进程级覆盖，影响当前进程所有 session。

## 结果模式

`cleanup.resultMode` 只在 DSH host bridge 中读取；Pi 侧固定 `compact` 语义。

| 值 | 行为 |
| --- | --- |
| `compact`（默认） | 成功只返回一行确认；拒绝仍返回 `cleanup rejected; <reason>`；刷新后的 index 在下一次刷新出现。 |
| `full` | 结果后附带刷新后的索引（拒绝时也附带）。 |
| `none` | 只抑制成功确认；`rejected` 始终返回可行动 reason，`list` 始终返回行内容。 |

结果模式只影响模型可见结果，不改变工具调用记录。

动作报告示例：`cleanup applied; removed 2 block(s): 2-3.`；软卸载为 `cleanup applied; offloaded 1 block(s): 2.`；混用时分别列出，配对删除单列 `Paired (not requested): 3.`。

## 配置

以下配置项只在 DSH host bridge 中读取；Pi 侧没有 block index。写进 `~/.config/oh-my-clm/config.json` 或项目级 `.oh-my-clm.json`。

| 配置项 | 默认 | 作用 |
| --- | --- | --- |
| `index.mode` | `digest` | 索引形状：`digest` / `blocks`。 |
| `index.previewChars` | `64` | `blocks` 模式每行 preview 字符数。 |
| `index.headBlocks` | `12` | 列表开头保留的 block 数。 |
| `index.tailBlocks` | `40` | 列表尾部窗口宽度。 |
| `index.maxLines` | `40` | `digest` 模式最多列出的 turn 数。 |
| `index.refreshSteps` | `4` | 同一 turn 内最多每几步重渲染一次。 |
| `cleanup.resultMode` | `compact` | `compact` / `full` / `none`。 |

清理触发阈值与缓存计价见根 [README](../../README.md#配置)。

## 宿主差异

- **Pi**：通过 `registerTool` 注册；参数校验与删除计划用共享 `parseCleanupArgs` / `planCleanup`。工具执行时写 mirror，持久化仍由随后的 `turn_end` 生成 branch-local `context_edit`。若磁盘内容仍等于上次渲染文本，工具后会重新同步；存在未提交编辑时保持 stale 拒绝。
- **DSH**：直接基于当前 `Session` 的 canonical records 按 ID 执行，不读 mirror；删除通过 `Session.append()` 的 surface replacement 落入 active surface，并在工具返回前写完新的 canonical mirror。细节见 [dsh-surface-bridge.md](./dsh-surface-bridge.md)。
