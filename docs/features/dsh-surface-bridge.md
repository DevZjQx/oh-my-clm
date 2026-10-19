# DSH surface bridge

仓库同时提供 Pi extension 和 DSH/Cordis plugin 两个入口。DSH 侧复用 `src/features/live-context/context-format.ts` 的 mirror、解析、snapshot 和编辑规划，但不使用 Pi 的 branch-local `context_edit`；合法编辑通过 DSH 原生 `Session.append()` 的 surface replacement 写入当前 active surface，append-only session log 仍保留原始事件。

> mirror 文件协议和 Pi 生命周期见 [live-context-mirror.md](./live-context-mirror.md)；cleanup 参数和 block index 见 [cleanup-tool.md](./cleanup-tool.md)。

## 1. 入口与契约

- 社区插件发现入口是 [`dsh-plugin.json`](../../dsh-plugin.json)，host entry 为构建后的 `dist/dsh/index.js`。
- 官方 bundle 安装元数据位于 `package.json` 的 `dsh.bundle.patch` 和 [`cordis.patch.yml`](../../cordis.patch.yml)。
- DSH 生命周期使用官方 Harness 的 Cordis `agent/created`、`agent/pre-step`、`session/event`、`systemPrompt.section()`、`systemPrompt.context()` 和 `tools.register()` 扩展点，不自己启动 agent loop，也不扫描 session JSONL。
- cleanup 直接对当前 session surface 执行按 ID 的 native replacement，不读取 mirror 文件。
- `systemPrompt.context()` 负责把 block index 放进模型可见的 runtime context；`source.kind === "runtime-context"` 的 snapshot 会从 mirror records 中排除，避免 index 递归列出自身。
- 在 DSH 0.2.0-rc.2 中，实际生效的是 bundle 元数据；`dsh-plugin.json` 的 Community permissions 目前不应被描述为运行时强制隔离。

## 2. 生命周期与 surface 适配

DSH 入口是 [`dsh/index.ts`](../../dsh/index.ts)，发布发现清单是 [`dsh-plugin.json`](../../dsh-plugin.json)。它遵循官方 `deepseek-harness` 的 Cordis host plugin 形态：使用 `apply(ctx)`、`systemPrompt.section()` 和 agent/session 事件，而不是自己启动 agent loop 或扫描 session JSONL。

```text
DSH session.surface + session.snapshotEvents()
                 │
                 ▼
同一份 buildMirrorRecords/renderMirror/parseMirror/planContextEdits
                 │
                 ▼
/tmp/clm-${sessionId}/LIVE_CTX_MAIN.md ──编辑──> snapshot/安全/shrink 校验
                                      │
                                      ├─ Session.append(surfaceOp=replace)
                                      │       └─ current surface / deriveMessages
                                      └─ canonical mirror（原始 log 保留）
```

DSH 的 `Session` surface 是由官方框架从已提交事件增量投影出来的；bridge 只读取 `surface.nodes` 和事件快照来适配 `ProjectionEntryLike`。它通过 `systemPrompt.context()` 注册 `oh-my-clm:block-index`，DSH 会把该 contribution 作为 sourced user-role runtime-context snapshot 追加到模型历史；bridge 同时把 `source.kind === "runtime-context"` 的 snapshot 从 mirror records 中排除，因此它们既不会出现在可编辑 block 里，也不会让 index 列出自身。cleanup 工具通过 `ctx.tools.register(<普通 tool definition>)` 注册；DSH 在返回阶段按声明的 output schema 校验结果，参数校验由共享 `parseCleanupArgs` 在 `execute` 内完成（正整数、唯一性和 active-surface 约束）。cleanup 直接基于当前 surface 的 canonical records 按 ID 执行，不经过 mirror 文件，并在工具返回前写完新的 canonical mirror。`session/event` 是 DSH 的 append-event 观察入口，但回调仍处于当前 `Session.append()` 的发布栈内，所以 bridge 只排队 reconcile，等事件发布完成后再串行检查文件。`agent/pre-step` 运行在 `step/start` 之前，此时 DSH 还没有打开新 step，因此它不执行 mutation；只有 session 仍有 open turn/step 时才等待已排队的收敛，否则直接返回，把待处理编辑留给 `step/start`。真正的 mutation 由 `tool/result`、`user/message`（当前 step 内）或 `step/start`（pre-step 推迟的编辑）触发，确保下一次模型请求看到已经收敛的 projection。编辑通过 snapshot、结构安全和 shrink-only 校验后，bridge 使用官方 `Session.append()` 的 surface replacement seam：assistant 内容编辑追加缩短文本的 `developer/message` replacement，tool result 追加 content-only `tool/result` replacement；删除追加使用 append 时打开的 `turn`/`step`（正数）的空 `developer/message` replacement；assistant 改写同样使用这一对坐标，`tool/result` 则严格保持原事件 envelope、只改 `content`。`assistant/message` 从不作为 replacement 追加，因为 DSH 禁止它携带 `sourceEventSeqs`，而 replacement 又必须引用所有被遮蔽节点。若当前没有打开的 turn/step，bridge 拒绝 mutation 而不是写入坐标过期的事件。所有 replacement 都用 `{ op: "replace", startSeq, endSeq }`，非 assistant replacement 同时提供覆盖目标的 `sourceEventSeqs`。DSH 的 surface fold 会立即遮蔽旧节点，`deriveMessages()` 因而使用新内容；原始事件仍留在 append-only session log 中，mirror 随后重写为新的 canonical projection。DSH 文件工具可访问宿主侧的 `/tmp`，sandbox 内 bash 不应被假定能访问同一目录。

这不是 Pi 的 branch-local `context_edit`：DSH 采用当前 `Session` 的 append-only surface replacement 和它自己的 fork/persistence 语义。它也不需要 proposal、receipt 或自定义 session event。若运行时对象没有已验证的 `Session.append()` owner，bridge 会拒绝编辑并恢复 canonical mirror，而不是退回“看似应用”的 mirror-only 状态。DSH 文件工具运行在宿主侧；sandboxed bash 可能看见隔离的 `/tmp`，因此脚本只有在实际写到了 host-side mirror、且在工具返回前完成写入时才会被 bridge 采纳。

这部分依据官方 `deepseek-harness` commit `1517a4dbca0a2789ff1d41ba439600f8547d23fa` 的 `dsh-session`、surface fold、compaction replacement 和 session persistence 契约实现；`dsh-ops` 只作为 manifest/host-entry 形态的参考，不作为需要复制的工具矩阵。

## 3. 编辑语义：与 Pi 的差异

bridge 会对 mirror 编辑执行与 Pi 侧相同的 snapshot、结构安全和 shrink-only 校验；合法编辑通过 DSH 原生 `Session.append()` 的 `surfaceOp: { op: "replace" }` seam 写入当前 session，处理后再把 mirror 重写为新的 canonical DSH projection。

| 操作 | DSH replacement |
| --- | --- |
| cleanup 删除 | 全部是 `replacement: null`，因此只追加空的 `developer/message` omission。 |
| 普通 mirror 编辑改写 tool result | 追加 content-only `tool/result` replacement，保持原 event envelope，并带 `sourceEventSeqs: [targetSeq]`。 |
| 改写 assistant | 追加缩短文本的 `developer/message` replacement。 |
| 删除 assistant | 追加空 content 的 `developer/message` replacement。 |

DSH 明确禁止 `assistant/message` 携带 `sourceEventSeqs`，而每个 replacement 又必须引用所有被遮蔽的节点，所以 assistant block 不能原地替换成另一个 assistant message。改写后的文本以 developer 身份进入模型可见历史，不再归属原模型回复。

原始事件仍保留在 append-only session log 中，`deriveMessages()` 使用新的 surface。所有 omission 和 assistant 改写都使用 append 时真正打开的 `turn`/`step`（正数）；若当前没有打开的 turn/step，bridge 拒绝 mutation，而不是写入坐标过期的事件。

它不生成 proposal/receipt 文件，也不注册自定义 session event；reconcile 在事件回调之外串行执行，避免 `Session.append()` reentrant failure。host entry 不复制 `dsh-ops` 的 Rust 工具、shell、PTC 或 TUI 矩阵，只做 live-context 适配。DSH 仅依赖 host 提供的 Cordis 生命周期，运行时不导入 Pi 的 coding-agent 包。

## 4. 安装与打包

安装 DSH bundle 时，按官方 Harness 的插件管理流程把本仓库目录（或 `npm pack` 产物）交给当前 profile；不要手写 profile 的 `package.json`、`dsh.profile` 或 `cordis.patch.yml`。外部 E-012 报告验证了 DSH 0.2.0-rc.2 的安装、Cordis activation、system prompt 和真实 mirror/file-tool 路径；本地实现另外依据官方 Harness commit `1517a4dbca0a2789ff1d41ba439600f8547d23fa` 的 `Session.append()` / surface replacement 契约，通过 mock seam 回归测试验证 active-surface mutation。

如果要交给 DSH 插件管理器安装，使用专门的 DSH 打包脚本：

```bash
npm run build:dsh:plugin
# 默认输出：artifacts/oh-my-clm-<version>.tgz

# 也可以指定输出目录或具体文件
node scripts/build-dsh-plugin.mjs ./out
node scripts/build-dsh-plugin.mjs --output ./out/oh-my-clm.tgz
```

这个脚本会先编译并检查 host entry，再生成只包含 DSH host、运行时 `dist`、manifest、bundle patch、locale、icon 的 npm tgz；Pi extension、TypeScript 源码、测试文件和开发依赖不会进入该专用包。`@deepseek-ai/dsh-tools` 仅作为可选 peer 声明用于兼容性检查，不产生运行时依赖，也不得改回 `dependencies`（原因见 [changelog.md](../../changelog.md) 的 0.1.1 说明）。普通 `npm pack` 仍用于构建同时包含 Pi 与 DSH 内容的完整包。

## 5. 配置

host bridge 可选读取以下变量；它们只影响 mirror preview、shrink-only safety gate 的近似估算或模型可见结果，不改变 DSH 的 context window。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `CLM_MAX_BLOCK_CHARS` | 与 Pi 相同的固定值 | 单个 block 的 preview 上限。 |
| `CLM_MAX_MIRROR_CHARS` | 与 Pi 相同的固定值 | 所有可编辑 preview 的总上限。 |
| `CLM_CONTEXT_FIXED_TOKENS` | 无 | 额外计入 shrink-only gate 的固定 token。 |
| `CLM_CLEANUP_RESULT` | `compact` | `compact` / `full` / `none`，只影响 cleanup 的模型可见结果。 |

block index 的 `CLM_INDEX_*` 开关、`/clm mode` 和 `cleanup` 结果语义见 [cleanup-tool.md](./cleanup-tool.md#6-配置)。`CLM_CONTEXT_BUDGET` 是 Pi 侧的目标预算和 nudge 开关，DSH bridge 不实现预算机制。

## 6. 验证与未验证边界

当前 DSH 契约是 **native `Session.append()` surface replacement** 加 **step-scoped `developer/message` 坐标**。mock host harness 位于 `test/harness/clm-dsh-host-test.mjs`；构建 `dist` 后运行：

```text
node test/harness/clm-dsh-host-test.mjs /home/deepseek-agent/oh-my-clm
```

它检查 cleanup 工具定义和共享参数解析、动态 `<oh-my-clm-block-index>` runtime context、默认 compact 结果、直接删除 active surface、工具返回前写完 canonical mirror、open turn/step 元数据、append-only 事件日志、`surfaceOp.replace` surface nodes、assistant/tool 配对、严格 shrink-only 拒绝、`agent/pre-step` 延迟到 `step/start`、私有产物权限，以及不生成 proposal/receipt 文件。当前本地输出为 `dsh-host-test-report-current.txt`（99 passed, 0 failed, 1 observation），说明和历史报告的适用范围见 [reports/README.md](../reports/README.md)。

仍未验证的边界：

- 真实 DSH profile 中的持久化、`session/flush`、restart recovery 和 fork/surface 语义；
- sandboxed bash 是否共享宿主 `/tmp`；
- 模型是否会在真实长任务中主动使用 turn-level `cleanup`。

## 7. 代码结构

| 位置 | 职责 |
| --- | --- |
| [`dsh/index.ts`](../../dsh/index.ts) | Cordis host entry：system prompt、agent/session 生命周期、索引 runtime context、工具注册和文件 I/O。 |
| [`src/features/live-context/dsh-bridge.ts`](../../src/features/live-context/dsh-bridge.ts) | DSH surface 适配、mirror 生命周期、安全校验和 `Session.append()` replacement mutation；cleanup 直接走 active surface。 |
| [`src/features/live-context/context-format.ts`](../../src/features/live-context/context-format.ts) | Pi/DSH 共用的 record 构建、mirror 渲染/解析、snapshot 和编辑规划。 |
| [`dsh-plugin.json`](../../dsh-plugin.json) | DSH Community v0.15 host manifest；`cordis.patch.yml` 是官方 bundle 安装层。 |
| [`test/features/live-context/dsh-bridge.test.ts`](../../test/features/live-context/dsh-bridge.test.ts) | surface replacement、reentrant append、pre-step 延迟、配对和拒绝路径测试。 |
| [`test/package`](../../test/package) | manifest 和发布元数据契约测试。 |
