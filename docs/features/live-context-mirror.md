# Live context mirror

Pi 侧把当前 branch 的下一次 projection 镜像成普通文件，让模型在 agent turn 内整理；扩展只把通过校验的差异转成 Pi 原生、branch-local 的 `context_edit`。不修改原始 session JSONL，也不额外发送 compaction LLM 请求。

## 数据与生命周期

| 数据 | 作用 | 是否被改写 |
| --- | --- | --- |
| Pi session JSONL | 完整历史与 branch 来源 | 否 |
| Pi projection | 下一轮实际可见的上下文 | 由 Pi 重算 |
| `/tmp/clm-${sessionId}/LIVE_CTX_MAIN.md` | projection 的可编辑镜像 | 模型可在 turn 内修改 |

1. `before_agent_start`：在 system prompt 末尾加入 `<pi-clm-live-context>` 协议说明。
2. `context`：用 `buildSessionProjection()` 构建 records，渲染 mirror；需要时在同一次请求追加临时 `system` budget nudge。
3. agent turn：模型调用 `cleanup`，或通过 host-side edit/write 缩短 body。
4. `turn_end`：读取 mirror，校验后提交 `context_edit`；拒绝时整体不应用，并通过一次性 `<pi-clm-edit-notice>` 说明原因。
5. 下一轮：Pi 按当前 branch 重算 projection；原始 entry 仍可审计。

路径由 session ID 决定，不由 `cwd` 决定。turn 之外对 mirror 的写入会在下一次同步时恢复为 canonical projection。生命周期钩子的实现与理由见 `extensions/clm.ts`。

## 文件协议

协议版本 `clm-v2`，Pi 与 DSH 共用：

```markdown
<!-- clm-v2 -->
<!-- CLM_SNAPSHOT 6e4c2a1f8b7d9012 -->
<!-- Edit block bodies only. Keep CLM_ENTRY and closing markers intact. -->
<!-- A body line that must read as a marker or comment gains one leading backslash; keep it. -->
<!-- id is the editable block's ordinal; do not change it or reorder blocks. -->
<!-- Delete an editable block to omit that message; use CLM_EMPTY when deleting the last one. -->
<!-- The protected initial task is intentionally not shown here. -->

[[CLM_ENTRY id=1 role=assistant]]
我检查了 README，并发现项目使用 TypeScript。
[[/CLM_ENTRY id=1]]

[[CLM_ENTRY id=2 role=toolResult]]
测试全部通过。
[[/CLM_ENTRY id=2]]
```

- `CLM_SNAPSHOT` 是 canonical records 的 16 位 SHA-256 前缀；失配拒绝编辑，不会把整份文件当作删除。
- 每个 block 对应一个 projection entry；`id` 是从 `1` 开始的可编辑序号，内部 opaque ID 只存在于映射中。
- `role` 只能是 `user`、`assistant`、`toolResult`、`custom`；改 role 拒绝。
- 只改 body。保留 header、snapshot、起止 marker 与顺序。
- body 中形似协议的行在渲染时加一个前导反斜杠；解析时去掉一层，因此 body 逐字往返、snapshot 不变。
- 删除所有可编辑 block 时保留 header 与 `<!-- CLM_EMPTY -->`；缺 header 的空文件拒绝。
- 解析只认顶层 span：block 打开后，只有自己的 closing marker 能改变状态。

## 编辑与校验

模型只能修改已有 block 的 body 或删除已有 block，不能新增 block 注入消息。`planContextEdits()` 为每个 record 生成 `keep` / `replace` / `omit`，再整体校验：版本、snapshot、ID、role 与 closing marker 必须匹配；user-authored block 只能省略；截断或自引用省略的 block 不能改写；伪造来源声明拒绝；block 1 始终保留；编辑后的估算上下文严格短于编辑前。任一失败整体拒绝，不部分应用。

shrink-only 固定开启，没有配置开关可以关闭。`estimateMessageTokens()` 只用于 before/after 比较，不是 provider tokenizer。校准细节见 `context-format.ts`。

### tool 配对

assistant block 含 tool call 时，改写或删除它会级联省略配对的 tool result；删除 tool result 也会删除 owner assistant。不要改写仍在产出的 step 里的 block，留到下一个 step。级联与拒绝原因见 `context-cleanup.ts`。

### 外部修改与自读

只有 agent turn 内的变化会作为候选 edit；其他进程直接写 mirror 时，下一次同步恢复 canonical projection，并给出一次性 `<pi-clm-edit-notice>`。读取 `LIVE_CTX_MAIN.md` 的 tool result 会在未来 projection 中替换为短指针，避免 mirror 自我复制。

## 命令与配置

```text
/clm status
```

显示 mirror 路径与大小、editable/protected block 数、preview/canonical token 估算、Pi context usage、预算状态、shrink-only 策略和当前 branch 的 context edit 数。命令只读。没有 `/clm refresh`、`/clm export` 或 `/clm-compact`；手动压缩用 Pi 原生 `/compact`。

```json
// <项目>/.oh-my-clm.json
{ "context": { "budgetTokens": 32000 } }
```

`context.budgetTokens`：近似目标 token。用量达到约 `0.75 × max(1, budget − 2048)` 时，在同一次请求追加临时 `system` nudge；nudge 不写入 session，也不产生额外 turn。其余配置项见根 [README](../../README.md#配置)。

Pi 侧 mirror 上限来自 `context.maxBlockChars`（默认 `12000` 字符/block）与 `context.maxMirrorChars`（默认 `96000` 字符）。截断只影响 preview，canonical source 完整；改写截断块会被拒绝。

## 限制

- 只有文本 block 编辑，不是完整结构化 message patch；不能新增或重排 block。
- rewrite 是单向棘轮：恢复原文只能靠原始日志或 branch 切换。
- 内容审计、审批/签名、编辑 diff/回滚不在本扩展内；shrink gate 不能替代事实核查。
- mirror 可能包含 reasoning 与 tool output，宿主负责临时文件生命周期与访问审计。
