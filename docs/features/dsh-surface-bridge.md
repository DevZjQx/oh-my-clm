# DSH surface bridge

仓库同时提供 Pi extension 与 DSH/Cordis plugin。DSH 侧复用 `context-format.ts` 的 mirror、解析、snapshot 和编辑规划，但不使用 Pi 的 branch-local `context_edit`；合法编辑通过 `Session.append()` 的 surface replacement 写入当前 active surface，append-only session log 保留原始事件。

## 入口与生命周期

- 发现入口：`dsh-plugin.json`；host entry：构建后的 `dist/dsh/index.js`。官方 bundle 元数据在 `package.json` 的 `dsh.bundle.patch` 与 `cordis.patch.yml`。
- 使用 Cordis 的 `agent/created`、`agent/pre-step`、`session/event`、`systemPrompt.section()`、`systemPrompt.context()`、`tools.register()`；不启动 agent loop，不扫描 JSONL。
- `systemPrompt.context()` 注册 block index；`source.kind === "runtime-context"` 的 snapshot 从 mirror records 中排除。
- `session/event` 回调处于 `Session.append()` 发布栈内，因此只排队 reconcile；mutation 由 `tool/result`、`user/message`（当前 step 内）或 `step/start` 触发。
- cleanup 直接对当前 session surface 按 ID 执行，不读取 mirror。文件工具运行在宿主侧时能访问宿主 `/tmp`；sandboxed bash 的 `/tmp` 不保证相同。

`sessionProjections` 的读取方式、reconcile 顺序、open turn/step 的等待条件与 `source.kind` 派生在 `dsh-bridge.ts`。

## Replacement 语义

| 操作 | DSH replacement |
| --- | --- |
| cleanup 删除 | `replacement: null`，追加空的 `developer/message` omission。 |
| cleanup `offload` | tool result 追加 content-only `tool/result` replacement；assistant 追加缩短文本的 `developer/message` replacement；带 tool call 的 assistant 级联 omit 配对 result。 |
| 普通 mirror 编辑改写 tool result | content-only `tool/result` replacement，保持原 envelope，带 `sourceEventSeqs: [targetSeq]`。 |
| 改写 assistant | 追加缩短文本的 `developer/message` replacement。 |
| 删除 assistant | 追加空 content 的 `developer/message` replacement。 |

约束：

- `assistant/message` 不能作为 replacement：DSH 禁止它携带 `sourceEventSeqs`，而 replacement 必须引用所有被遮蔽节点。改写文本以 developer 身份进入模型可见历史。
- 所有 omission 与 assistant 改写使用 append 时打开的 `turn` / `step`（正数）；没有打开坐标时拒绝 mutation，不写坐标过期的事件。
- replacement 统一用 `{ op: "replace", startSeq, endSeq }`；非 assistant replacement 同时提供覆盖目标的 `sourceEventSeqs`。
- `source.kind` 由规划器来源派生：`oh-my-clm:model-mirror-edit` 或 `oh-my-clm:runtime-cleanup`，不冒充 `user`。mirror body 中出现保留来源声明会被整体拒绝。
- 不生成 proposal/receipt 文件，不注册自定义 session event；reconcile 在事件回调之外串行执行，避免 reentrant append failure。
- 若运行时没有已验证的 `Session.append()` owner，bridge 拒绝编辑并恢复 canonical mirror，不退回 mirror-only 状态。

原始事件仍保留在 append-only log；`deriveMessages()` 使用新的 surface。Pi 的 branch-local 语义不能被假定适用于 DSH。

## 打包

```bash
npm run build:dsh:plugin
# 默认输出 artifacts/oh-my-clm-<version>.tgz
node scripts/build-dsh-plugin.mjs --output ./out/oh-my-clm.tgz
```

专用包只含 DSH host、运行时 `dist`、manifest、bundle patch、locale、icon；Pi extension、TypeScript 源码、测试与开发依赖不进入。`@deepseek-ai/dsh-tools` 只是可选 peer，用于兼容性检查，不产生运行时依赖。普通 `npm pack` 生成 Pi + DSH 完整包。

## 配置

配置来自 `~/.config/oh-my-clm/config.json` 与项目级 `.oh-my-clm.json`（后者逐 key 覆盖前者）；插件不读取环境变量。完整配置表见根 [README](../../README.md#配置)，索引开关见 [cleanup-tool.md](./cleanup-tool.md#配置)。

这些配置只影响 preview、shrink-only gate 的近似估算、索引或模型可见结果，不改变 DSH 的 context window。

## 未验证边界

- 真实 DSH profile 中的持久化、`session/flush`、restart recovery 与 fork/surface 语义；
- sandboxed bash 是否共享宿主 `/tmp`；
- 模型是否会在真实长任务中主动使用 turn-level `cleanup`；
- `autoClear.midTurnSuffixTokens` 在 `step/end` 写清理记录：与已验证的 `turn/end` 写入共用同一个 `appendPluginRecord`，但开启前值得先在真实 profile 上跑一次；
- 自定义 `source.kind` 在真实 profile 上的接受度。发版前需复核。
- `cleanup.resultMode` 的 `full` / `none` 依赖 `execute` 返回的对象实例被原样交给 `render`；若某个宿主在校验后传入副本，这两个模式会静默退回 `compact`。

mock host harness 位于 `test/harness/clm-dsh-host-test.mjs`，构建 `dist` 后运行：

```text
node test/harness/clm-dsh-host-test.mjs .
```
