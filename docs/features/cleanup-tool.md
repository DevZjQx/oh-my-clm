# Cleanup 与 block index

`cleanup` 是 Pi 和 DSH 共用的历史整理入口：模型按 **1-based editable block ID** 删除 stale、重复或自指内容，不需要读取完整 block body，也不会因为 mirror preview 被截断而构造出错误的 `old_string`。block index 则把可删除的地址放进模型可见的 runtime context，让模型不必先打开 mirror 才能决定删什么。

> mirror 协议、snapshot 和 turn_end 校验见 [live-context-mirror.md](./live-context-mirror.md)；DSH 如何把删除应用到 active surface 见 [dsh-surface-bridge.md](./dsh-surface-bridge.md)。

## 1. 为什么优先用 cleanup

- **不依赖正文**：删除计划直接使用 ID 和 host 侧 records，preview 截断、超长 tool output 都不影响。
- **一次调用完成**：所有目标必须批量放进同一个 host-side 工具调用；ID 在删除后会重新编号，分多次调用会更容易指错。
- **保护 load-bearing block**：协议头、`CLM_SNAPSHOT`、block 1 和 user-authored block 的改写限制不会被绕过。
- **配对处理**：删除 assistant tool turn 时，配对的 tool result 会一起删除；反过来删除 tool result 也会删除其 owner assistant，避免下一轮出现孤立的 tool message。
- **可审计**：工具调用和结果事件仍完整保留在 session surface / append-only 日志中。

## 2. 工具契约

```text
cleanup({ "blockIds": [2, 3, 4] })
cleanup({ "ranges": ["3-16"], "skipRoles": ["user"] })
cleanup({ "list": "3-16" })
```

| 参数 | 语义 |
| --- | --- |
| `blockIds` | 显式单块 ID。未知、重复、过期或协议损坏的 ID 会整体拒绝，不部分应用。 |
| `ranges` | 包含式区间，例如 `"3-16"` 或 `"42"`。越界会夹取；覆盖 block 1 时保留 block 1。 |
| `skipRoles` | 在请求的区间内保留指定角色。`["user"]` 可以删掉一个 turn 的 tool 噪声但保留人类消息。 |
| `list` | 只读展开：返回该区间的逐块行（role + 短 preview），不做删除，也不写 mirror。 |

规则：

- ID 是当前 mirror / index 中从 `1` 开始的可读编辑序号；不要改 ID，也不要重排 block。
- `list` 不能和 `blockIds` / `ranges` / `skipRoles` 同时出现，避免“边看边删”。
- 单次 `list` 结果约有 6 KB 字符预算；被截断时末尾会给出继续读取的区间（`... 65 more block(s); call cleanup({ list: "114-178" }) to continue.`），不会静默返回部分视图。
- 显式 ID 1 会被拒绝；range 覆盖 1 时保留 block 1。初始用户任务（protected prefix）不在可编辑区域中。
- 配对级联删除通过 `pairedRemovalIds` / `paired` 单独报告，不会混进调用者请求的 ID。
- 用户消息只能保留或省略，不能被 cleanup 改写；cleanup 只做删除。
- Pi 侧一个 step（一次 assistant 响应及其 tool call）最多调用一次 cleanup，并且要在该 step 任何 mirror 编辑之前。Pi 的 `turn_end` 在每个 step 结束时触发（见 Pi `docs/json.md`），每次提交都会刷新 mirror 基线，所以跨 step 的多次 cleanup 是正常且安全的；同一 step 内先改 body 再 cleanup 则会整体拒绝——文件一旦在提交前被改过，它的 snapshot 就落后于 live projection，cleanup 不静默重渲染也不删除任何 block，并在 reason 里点明顺序。
- 删除最后一个可编辑 block 时，mirror 保留 `<!-- CLM_EMPTY -->`。
- 删除使用与解析相同的顶层 span：body 里引用（或手写）的 `[[CLM_ENTRY ...]]`、`[[/CLM_ENTRY ...]]` 不会被当成可删块，所以“某个 block 的正文里贴了 marker”不会再把删除变成切错范围的静默损坏。
- 真的损坏（缺 closing marker、重复顶层 ID、目标 span 不存在）会作为 `rejected` 返回并给出具体 ID；`removeMirrorBlocks()` 失败时返回结果对象而不是抛异常，因此不会出现“规划通过、写盘到一半失败”的半状态。

## 3. block index

DSH 会通过 `systemPrompt.context()` 把 `<oh-my-clm-block-index>` 放进模型可见的 runtime context。索引和 `cleanup` 使用同一组 1-based ID，因此模型可以直接从聊天上下文里得到删除地址。

### digest（默认）

每个已完成 turn 一行：包含式 ID 区间、块数、估算 token 成本和该 turn 的第一条 user 消息。正在进行的 turn 只给稳定的起始锚点 `IDs N..`，不列出——它还在增长，工具对也可能尚未结算，本来就不是安全的删除目标。

```text
<oh-my-clm-block-index>
Editable blocks by cleanup ID; ranges are inclusive. One line per turn; call cleanup({ ranges: ["A-B"] }) to omit a turn, cleanup({ list: "A-B" }) to read its rows.
1-2. assistant+toolResult ×2 (35 tok): I inspected the repository and found a small TypeScript project.
3-4. turn ×2 (17 tok): user (10 tok) + 1 noise: Keep the important repository fact.
IDs 5.. (current turn, not listed): One more turn.
</oh-my-clm-block-index>
```

因此摘要文本在一个 turn 内字节不变，DSH 的快照去重会命中，索引只在 turn 边界追加一次。`CLM_INDEX_LINES`（默认 40）限制列出的 turn 数；被折叠的 turn 再按估算 token 排序，最多取三个写成一行 `... largest omitted turns: 21-24 (4.1k tok), 31-33 (2.9k tok).`。

### blocks

`CLM_INDEX_MODE=blocks` 切回逐个 block 的列表。它附带 role 和单行短 preview，默认 preview 64 字符，列前 12 个 block（开头任务的“别动”锚点）加**最近 40 个**；中间的连续区间用一行 `... N editable block(s) omitted (IDs A-B).` 标出。

```text
<oh-my-clm-block-index>
Editable blocks by cleanup ID; call cleanup({ blockIds: [...] }) to omit them, cleanup({ list: "A-B" }) to read a range's rows.
1. assistant: I inspected the repository and found a small TypeScript project.
2. toolResult: A very large command output that is no longer useful.
…（1–12 行是开头的“别动”锚点，中间省略）
... 148 editable block(s) omitted (IDs 13-160).
161. toolResult: the failing test run from an earlier turn
…
200. user: Keep the important repository fact.
</oh-my-clm-block-index>
```

预算偏向最近内容，因为清理目标是那里刚产出、模型还记得的 stale tool 噪声；中点附近的 block 既不记得、也不是删除对象。`CLM_INDEX_MIDDLE` 已改名为 `CLM_INDEX_TAIL`，旧名作为回退别名保留。

### 刷新与失效

索引的静态协议（tag 含义、cleanup 使用纪律、block 1 与 protected block 规则）放在系统提示词里，随 system prompt 一起缓存；runtime-context 只携带动态行。`blocks` 模式下同一个 turn 内索引最多每 `CLM_INDEX_REFRESH_STEPS`（默认 4）步重渲染一次；节流按“打开中的 turn + 已关闭 step 数”计数，因为 DSH 在 `agent/pre-step` 渲染索引时下一步的 `step/start` 还没写入（旧 turn/step 键因此从未命中，见 E-027）。

追加新 block 不会重编号，所以缓存索引里列出的 ID 始终有效；删除会重编号，`cleanup` 或 mirror edit 生效后会立即清空缓存并重渲染，compaction 事件也会保守失效。`CLM_INDEX_REFRESH_STEPS=1` 恢复每步刷新。

DSH 的 `/clm mode [blocks|digest|auto]` 在当前进程里切换索引形状并清空缓存，从下一步开始生效；`auto` 撤销进程级覆盖，回到 `CLM_INDEX_MODE`（默认 `digest`）。这是进程级覆盖，会影响当前进程中的所有 session。

## 4. 结果模式

`CLM_CLEANUP_RESULT` 只在 DSH host bridge 中读取；Pi 侧固定为 `full` 语义。

| 值 | 行为 |
| --- | --- |
| `compact`（默认） | 删除/拒绝只返回一行确认；刷新后的 block index 会在下一次索引刷新后出现。 |
| `full` | 在结果后附带刷新后的索引。 |
| `none` | 只抑制删除/拒绝确认；`cleanup({ list: "A-B" })` 的只读 listing 在任何模式下都返回行内容。 |

结果模式只影响模型可见的结果，不改变工具调用记录本身。

## 5. 宿主差异

### Pi

`cleanup` 通过 Pi `registerTool` 注册，参数校验和删除计划使用共享的 `parseCleanupArgs` / `planCleanup`。工具执行时写入 mirror，真正的持久化仍由随后的 `turn_end` 生成 branch-local `context_edit`。如果工具调用后 projection 比文件多一条，扩展会在磁盘内容仍等于上次渲染文本时重新同步 mirror；磁盘上存在未提交的模型编辑时则保持 stale 拒绝，避免冲掉尚未应用的修改——此时拒绝原因直接提示"cleanup 要在该 step 任何 mirror 编辑之前，且一个 step 只能一次"，而不是笼统的 snapshot stale。

### DSH

`cleanup` 直接基于当前 `Session` 的 canonical records 按 ID 执行，不读取 mirror 文件；删除通过 `Session.append()` 的 surface replacement 落入当前 active surface，并在工具返回前写完新的 canonical mirror。参数校验同样在 `execute` 内完成。细节见 [dsh-surface-bridge.md](./dsh-surface-bridge.md)。

## 6. 配置

以下变量只在 DSH host bridge 中读取；Pi 侧没有 block index，cleanup 结果固定为 `full` 语义。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `CLM_INDEX_MODE` | `digest` | 索引形状：`digest` 或 `blocks`。 |
| `CLM_INDEX_PREVIEW` | `64` | `blocks` 模式每行 preview 字符数。 |
| `CLM_INDEX_HEAD` | `12` | 列表开头保留的 block 数（“别动”锚点）。 |
| `CLM_INDEX_TAIL` | `40` | 列表尾部窗口宽度；旧名 `CLM_INDEX_MIDDLE` 作为回退别名。 |
| `CLM_INDEX_LINES` | `40` | digest 模式最多列出的 turn 数。 |
| `CLM_INDEX_REFRESH_STEPS` | `4` | 同一个 turn 内最多每几步重渲染一次；`1` 表示每步刷新。 |
| `CLM_CLEANUP_RESULT` | `compact` | DSH 结果模式：`compact` / `full` / `none`。 |

用 `node scripts/measure-session-index.mjs --project .` 可以从真实 session 日志核对索引快照数、字节数、步间隔和 cleanup 调用形态；它同时给出 `blocks` 与 `digest` 的对比，以及 digest 的预测重渲染次数。

## 7. 实现与测试

| 位置 | 职责 |
| --- | --- |
| `src/features/live-context/context-cleanup.ts` | 双宿主共用的参数解析、ID/区间校验、block 1 保护、配对删除和完整 span 删除。 |
| `src/features/live-context/context-format.ts` | 共享 records、block ID 和索引渲染（`renderBlockDigest` 等）。 |
| `extensions/clm.ts` | Pi 工具注册、mirror 写入和 `turn_end` 持久化。 |
| `dsh/index.ts` | DSH 工具注册、索引 runtime context 和 active-surface cleanup。 |
| `test/features/live-context/context-cleanup.test.ts` | ID 校验、block 1 保留、截断 preview、完整 span 删除和配对失败测试。 |
| `test/features/live-context/context-format.test.ts` | 索引渲染、协议、截断和 gate 测试。 |

## 8. 验证

关键不变量：

1. cleanup 按 ID 在一次工具调用内完成 host-side mutation；
2. preview 截断和 `old_string` 不会影响删除；
3. block 1、协议头、`CLM_SNAPSHOT` 保留；
4. assistant tool call 与 tool result 级联处理，不留下孤立 message；
5. 未知、重复、过期 ID 和 role 变化整体拒绝；
6. `list` 只读，不写 mirror，不能与删除参数同用；
7. 结果模式不改变工具调用记录，也不吞掉 listing 内容；
8. Pi 侧 mirror 已带本 step 改动时，cleanup 以可行动的 `rejected` 结束，既不静默重渲染，也不删除任何 block。
