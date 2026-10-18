# 更新日志

版本号同时记录在 [`package.json`](./package.json) 和 [`dsh-plugin.json`](./dsh-plugin.json) 中。以下按版本倒序列出使用者可见的变更；更早的实现细节见 git 提交记录和 [`docs/how-it-works.md`](./docs/how-it-works.md)。

## 未发布（内部结构整理）

### 新增

- **`cleanup` 使用纪律进入模型可见上下文。** 新增导出常量 `CLEANUP_DISCIPLINE`（`src/features/live-context/context-format.ts`），同时用于 DSH 的 `<oh-my-clm-block-index>` 末尾和 Pi 的 system prompt，避免两侧措辞漂移。内容只有两条可机械执行的规则：把要删的 ID 合并在一次调用里（删完会重新编号，不要用旧 ID 连续调用）；tool-call block 与配对结果一起删、优先清理 assistant/tool-result 噪声而不是 user turn、拿不准的 ID 留到下次。两个 host 的 `blockIds` 参数说明也补上“一次调用传完”的提示。索引净增约一行。

### 调整

- **源码改为 `src/lib` + `src/features/live-context` 两层。** 共享的 mirror 文件写入和路径解析移到 `src/lib`；mirror 协议、cleanup 和 DSH bridge 移入 `src/features/live-context`；Pi/DSH 入口路径保持不变。
- **测试按层分组。** `test/` 现在镜像源码分层（`lib`、`features/live-context`、`adapters`、`package`），手动 mock-host harness 移到 `test/harness/`。
- **`dsh-clm/` 只保留构建输出。** 历史验证报告移到 `docs/reports/` 并补充说明；`dsh-clm/` 改为 gitignore 的 tgz 输出目录。
- **删除已移除功能的空占位文件。** 移除 `src/compact.ts`、`src/trajectory.ts` 和同名的空测试。
- **新增单向依赖检查。** `scripts/check-boundaries.mjs` 接入 `npm run check`，检查 `shared → feature → host adapter` 的导入方向、跨 feature 导入和 barrel 文件。目录职责见 [`docs/project-structure.md`](./docs/project-structure.md)。

发布包中的入口仍然是 `extensions/clm.ts` 和 `dist/dsh/index.js`；`package.json` 的 `files` 白名单和 `tsconfig.dsh.json` 已同步新的源码路径。

## 0.1.4（当前版本）

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
