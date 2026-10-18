# oh-my-clm 0.1.0 — DSH 可用性测试报告

- 被测包：`oh-my-clm-0.1.0.tgz`（`/home/deepseek-agent/dsh-plugins-dev/oh-my-clm-0.1.0.tgz`）
- 宿主：`dsh 0.2.0-rc.2`（`/home/deepseek-agent/.local/lib/node_modules/@deepseek-ai/dsh`），Node v26.11.1
- 结论：**在 DSH 侧可用，且已进入正式使用状态**。包能被官方 `dsh plugin add` 识别为 bundle、能被 composer 组装、能在真实 profile 中挂载（fiber active），并在真实 system prompt 中贡献自己的段落；还已在**运行中的 web profile** 里由一次真实 agent turn 生成了 mirror。
- mirror / patch 逻辑 61 项功能检查全部通过；mirror 的**生成**与**被编辑**两条路径都已在真实环境实测。
- 唯一没跑的一跳：编辑 mirror 之后由宿主在下一个 pre-step 写出 `LIVE_CTX_MAIN.patch.json`（真实服务里未跑，mock 层已覆盖同一逻辑）。

---

## 1. 包完整性（静态检查）

| 检查 | 结果 |
| --- | --- |
| `dist/dsh/index.js`、`dist/src/*.js` 语法 | `node --check` 全部通过 |
| `dsh-plugin.json` / `package.json` / `locale/*.json` JSON 解析 | 通过 |
| manifest 与 `package.json` 引用的文件（entry、icon、locale、bundle patch） | 全部存在 |
| 入口依赖 | 只依赖 `node:fs` / `node:path`，无宿主包运行时依赖（不会因缺 peer 包而 import 失败） |

## 2. DSH 契约核对（对照真实类型声明）

逐项确认插件使用的宿主 API 在 `dsh 0.2.0-rc.2` 中真实存在且形状一致：

- `agent/created`、`agent/pre-step`、`agent/disposed` → `@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts`
- `session/event` → `@deepseek-ai/dsh-session`
- `systemPrompt.section()` / `getSectionOrder()` → `@deepseek-ai/dsh-system-prompt`
- session 事件形状：`user/message`（data 即消息）、`assistant/message` / `tool/result`（data.message）
- 消息形状：`ToolResultMessage.role === 'tool'`、`ToolCallBlock.type === 'tool-call'`、`ReasoningBlock.text`

→ 插件的 `editableRole()`（`tool` → `toolResult`）与 `toolCallIds()`（`tool-call`）都按真实形状处理。

## 3. 功能测试（mock 宿主，61 项全通过）

脚本：`clm-dsh-host-test.mjs`；报告：`clm-host-test-report.txt`。
被测对象是 **profile 中真正安装的那份副本**（`~/.dsh/profiles/clmtest/node_modules/oh-my-clm`）。

覆盖：

1. 模块契约（`name` / `apply` / `inject`）
2. system prompt 段落注册（名称、序数回退 3240、跟随宿主 `TOOL_EDIT` 序数、文案含 mirror/patch 路径）
3. agent 生命周期接线（`agent/created` → agent 级 `agent/pre-step`、`session/event`、`next()` 仍被调用）
4. mirror 生成（协议头、16 位十六进制快照、初始用户任务受保护不出现、assistant/toolResult 可编辑、重复同步幂等）
5. 合法缩短编辑 → 生成 patch（协议 `oh-my-clm-dsh-patch-v1`、`host: dsh`、`status: applied`、token 下降、会话日志未被改写）
6. shrink-only 门禁（变长编辑被拒并给出 SHRINK 原因）
7. 拒绝矩阵：快照过期、文档损坏、未知 id、重复 id、role 被改、user-authored 改写
8. 省略与 tool 配对（改写 assistant tool turn 时自动 omit 配对的 tool result，不留孤立结果）
9. `session/event` 驱动的同步；非 surface 事件被忽略
10. 释放语义（`agent/disposed` 清理状态、effect disposer 摘除监听）

健壮性：空 session id、无 session 的 agent 都只 `logger.warn`，不抛出、不中断 pre-step。

## 4. 真实 DSH profile 安装与挂载

全部在**新建的临时 profile** 中进行，未触碰当前运行 GUI 的 `web` profile。

1. `dsh plugin --profile clmtest add <tarball>` → pnpm 安装成功，且 **DSH 自动把 `oh-my-clm` 写进 `dsh.profile.bundles`**（说明官方插件管理器认可它是合法 bundle）。
2. `dsh --profile clmtest --dump-config` → 组装树中出现独立层：

```yaml
# == oh-my-clm
- id: oh-my-clm-live-context
  name: oh-my-clm
  config: {}
```

3. 真实挂载探针（在 base-only profile 里插一个诊断插件，等待 loader 稳定后读取真实 loader 与真实 systemPrompt）：

```json
{
  "probe": "clm-mount-probe",
  "entry": {
    "id": "include:oh-my-clm-live-context",
    "name": "oh-my-clm",
    "disabled": false,
    "fiberState": 2
  },
  "promptSection": {
    "name": "oh-my-clm:live-context",
    "chars": 1062,
    "mentionsMirror": true,
    "mentionsPatch": true,
    "head": "<oh-my-clm-dsh-live-context>\nThe DSH bridge mirrors the current session surface to `/tmp/clm-<session-id>/LIVE_CTX_MAIN."
  },
  "promptSectionCount": 18,
  "errors": []
}
```

`fiberState: 2` = Cordis ACTIVE，即真实 `apply(ctx)` 已执行；段落出现在真实 assembled system prompt（共 18 段）中。
（探针 profile 与探针行已在测试后删除，脚本保留为 `clm-mount-probe.mjs`。）

## 4.5 正式安装到当前 web profile（已生效，无需重启）

按用户确认执行：

```bash
dsh plugin --profile web add /home/deepseek-agent/dsh-plugins-dev/oh-my-clm-0.1.0.tgz
```

结果：

- `~/.dsh/profiles/web/node_modules/oh-my-clm/` 已安装；
- `~/.dsh/profiles/web/package.json` 自动追加依赖并把 `oh-my-clm` 写入 `dsh.profile.bundles`；
- `dsh --profile web --dump-config` 组装树末尾出现 `# == oh-my-clm` 层；
- **运行中的 web profile 已热挂载该插件**：本次请求的 system prompt 中已实际出现
  `<oh-my-clm-dsh-live-context>` 段落（与 `dist/dsh/index.js` 的 `promptText()` 文本一致），
  说明真实 `apply(ctx)` 在运行中的服务里执行，且没有出现"段落重名"之类的加载错误；
- 安装后 GUI 仍正常响应（`http://127.0.0.1:3080/` → HTTP 401，即服务在线并要求鉴权）。

回滚：`/home/deepseek-agent/dsh-plugins-dev/web-profile-package.json.bak` 是安装前的 profile 清单；
恢复后用 `dsh plugin --profile web remove oh-my-clm`（或手工删除依赖与 bundle 项）并重启 profile 即可。

沙箱限制（影响验证方式，不影响插件功能）：本 agent 的 shell 运行在 `bwrap --tmpfs /tmp` 中，
且 PID namespace 隔离，因此**shell 读不到宿主机 /tmp**，也**无法自行重启 GUI 进程**。
（后经实测：DSH 文件工具运行在宿主侧，可以读到 `/tmp/clm-<sessionId>/`；只有 shell 看不到，详见第 9 节。）

## 4.6 真实运行服务里的 mirror 生成（已实测）

为验证「挂载之后创建的 agent 是否真的挂钩子」，正式安装后派了一个 subagent（新 agent）执行一轮真实 turn：

- subagent 的 `DSH_SESSION_ID` = `eaeb7e4c-4e8d-4c44-babd-00b18035026b`（裸 UUID；主会话 id 形如 `session-<uuid>`）；
- 在宿主机读到插件生成的 `/tmp/clm-eaeb7e4c-4e8d-4c44-babd-00b18035026b/LIVE_CTX_MAIN.md`（30 行），结构如下：

```text
<!-- pi-clm-v2 -->
<!-- CLM_SNAPSHOT aec7f758382c1011 -->
...
[[CLM_ENTRY id=1 role=user]]        <- 运行时上下文注入（初始任务本身受保护，未出现）
[[CLM_ENTRY id=2 role=assistant]]   <- 含 reasoning 文本 + bash tool-call
[[CLM_ENTRY id=3 role=toolResult]]  <- 配对的工具结果
```

结论：`agent/created → agent/pre-step → buildDshProjectionEntries → renderMirror → 写文件`
整条链路在真实服务里跑通，「初始用户任务受保护」也符合预期。

补充实测：用 DSH 文件工具（`edit`）对宿主 `/tmp` 的 mirror 做了一次改短编辑，**写入成功**（测试后已还原原文）。
即真实环境里「模型编辑 mirror」这条路径是通的，**不需要放宽沙箱**（详见第 9 节）。

## 5. 发现与风险

1. **`dsh-plugin.json`（manifestVersion 0.15）在 DSH 0.2.0-rc.2 中是死文件。** 全量检索该 DSH 安装：没有任何代码读取 `dsh-plugin.json`、`contributes`、`x-display`、`x-prompt-sections`；DSH 自己的清单版本是 `package.json.dsh.manifestVersion = 1`。真正生效的只有 `package.json` 的 `dsh.bundle.patch`。→ 用这个社区 manifest 发布/审核生态的元数据（含 `permissions`）在本版本不会被消费。
2. **`permissions` 不被强制。** 声明的是 `scope: workspace` 读写，但 manifest 不被读取，实际写入目标是 `/tmp/clm-<sessionId>/`（工作区之外）。权限声明当前只是文档。
3. **mirror 漂移（观察项，非崩溃）。** 一次编辑被处理（无论 applied 还是 rejected）后，文件被标记为 `lastProcessedMirror`，因此 mirror **不会**立刻回到 canonical 投影，而是保留模型改过的文本，直到投影本身发生变化（新事件）才被重写。README 里 Pi 侧“下一次同步恢复 canonical”的描述在 DSH 侧不成立。
4. **`agent.id === session.id` 是隐式依赖。** 状态表用 `agent.id` 写入、用 `session.id` 读取；DSH 运行时有 `if (id !== agent.session.id) throw`，所以产品内不可达，但这是个未文档化的耦合。
5. **mirror 会把模型的 reasoning 明文写进 `/tmp`。** 实测 assistant 块里包含 reasoning 文本（例如 `The user wants me to run exactly one bash command and report its output verbatim.`）。也就是说思维内容会落到 `/tmp/clm-<sessionId>/LIVE_CTX_MAIN.md`，属于临时目录中的明文副本，需要考虑同机可见性与清理策略。
6. **`bash` 的 `/tmp` 与文件工具的 `/tmp` 不是同一个。** 见第 9 节；这是部署/沙箱事实，不是插件缺陷。

## 6. 遗留缺口（未验证）

- **真实服务里的 patch 生成**：mirror 生成已在真实 turn 实测（4.6），mirror 可被 `edit` 也已实测；但「编辑之后由宿主在下一个 pre-step 校验并写出 `LIVE_CTX_MAIN.patch.json`」这一跳没有在真实服务里跑完（当时那个 subagent 已 disposed、插件随之清掉了状态，无法续跑）。mock 层 61 项覆盖了同一段 `planContextEdits` + `patchFromPlan` 逻辑。
- HMR / bundle 热更新的内部细节、`plugin_manager install_bundle`（该 action 名在 dsh 0.2.0-rc.2 中不存在）。
- Pi 侧扩展（`extensions/clm.ts`）未测试：本机没有 Pi runtime，包也未附带测试目录（`package.json` 的 `npm test` 指向未发布的 `test/`）。

## 7. 现在的状态与怎么验证

- **当前 web profile（这个 GUI）已安装并已生效**：插件段落已出现在运行中服务的 system prompt 里。
- 生成的产物在宿主机的 `/tmp/clm-<sessionId>/LIVE_CTX_MAIN.md`（以及编辑后的 `LIVE_CTX_MAIN.patch.json`）。
  在宿主机执行 `ls -d /tmp/clm-*` 即可看到。
- 注意：本次挂载发生在**本会话的 agent 已经创建之后**（会话日志里没有新的 `resume` request/header，且不存在
  `/tmp/clm-session-d879b5b9-…/` 目录），所以**当前这个会话只拿到了全局的 `systemPrompt` 段落、没有挂上
  `agent/pre-step` 钩子**。**新开一个 chat**（或任何新 subagent）就是完整链路；要让已存在的会话也生效才需要重启 profile。
- 会话 id 形态：主会话 `DSH_SESSION_ID` 带 `session-` 前缀，subagent 是裸 UUID；mirror 目录名恒为 `clm-<session.id>`。
- 另一个可用 profile（base + headless + oh-my-clm）仍在：`dsh --profile clmtest "…"`。
  不再需要时可 `rm -rf /home/deepseek-agent/.dsh/profiles/clmtest`。

## 8. 目录中的测试产物

| 文件 | 用途 |
| --- | --- |
| `clm-plugin-test-report.md` | 本报告 |
| `clm-dsh-host-test.mjs` | mock 宿主功能测试（61 项断言，可复跑） |
| `clm-host-test-report.txt` | 最近一次测试输出 |
| `clm-mount-probe.mjs` | 真实 profile 挂载探针（一次性诊断插件） |
| `web-profile-package.json.bak` | 安装前的 web profile 清单（回滚用） |
| `oh-my-clm-0.1.0.tgz` | 被测原始包 |

## 9. 沙箱/部署边界：是否影响正常使用？是否需要改 bwrap？

**结论：不影响正常使用，不需要改 bwrap。**

本环境里两套 `/tmp` 不是同一个，必须分清：

| 环节 | 执行者 | 实测结果 |
| --- | --- | --- |
| mirror 写入 | DSH 服务进程（宿主侧），与 shell 沙箱无关 | ✅ 真实 turn 生成了 `/tmp/clm-eaeb7e4c-…/LIVE_CTX_MAIN.md` |
| mirror 读取/编辑 | DSH 文件工具 `read`/`edit`/`write`（宿主侧） | ✅ `edit` 改写宿主 `/tmp` 的 mirror 成功 |
| mirror 的 shell 访问 | `bash`（每次调用 `bwrap --unshare-pid --tmpfs /tmp`） | ❌ `cat /tmp/clm-…/LIVE_CTX_MAIN.md` → No such file |

因此唯一实际影响是：**不要用 bash 去读/改 mirror，要用文件工具**。而插件自己的提示就是
“Use one ordinary file edit/write operation”，两者一致，不构成阻断。

不建议改 bwrap：

1. 私有 `/tmp` 是刻意的隔离；为了“能用 shell 编辑 mirror”换成共享宿主 `/tmp`，等于放开所有 shell 命令的宿主 `/tmp` 读写，收益小、隔离面变大。
2. 若确实想让 shell 也能访问，正确粒度是给 bash 沙箱窄口径 `--bind /tmp/clm-<id>`，或把镜像目录挪进工作区——后者需要改插件源码里硬编码的 `CLM_TEMP_ROOT = "/tmp"`（`src/clm-paths.ts`），属于插件的设计选择，不该由沙箱迁就。
3. 即使写失败也不会破坏任何东西：插件对 FS 异常是 `logger.warn("mirror bridge unavailable")` 降级，不抛、不中断 pre-step；并且它**从不改写会话日志**（patch 只是提案文件）。

需要留意的是另外两点（都与 bwrap 无关）：

- **热挂载前已存在的 agent 没有钩子**（见第 7 节），新 chat/subagent 才有完整链路。
- **更严的文件策略会让插件“半失效”**：若连平台临时区都不可写，mirror 写不出来，插件退化为“只在 system prompt 里提示”。
  正确解法是给 `/tmp/clm-*` 一条窄的写白名单，而不是放宽 bwrap。

## 10. 本次工作产生的代码/文件改动清单

**没有改动任何插件源码，也没有改动 DSH 安装。**

未改动（只读取/执行）：

- `oh-my-clm` 包内的所有文件：`src/*.ts`、`dist/**`、`dsh/index.ts`、`extensions/clm.ts`、`dsh-plugin.json`、`cordis.patch.yml`、`locale/*`、`docs/*`（仅解包查看 + 运行；解包目录事后已删）。
- DSH 安装目录 `/home/deepseek-agent/.local/lib/node_modules/@deepseek-ai/dsh/`（npm 安装，非 git checkout；仅检索类型声明与实现）。
- 运行中的 GUI 进程（PID namespace 隔离，既未重启也未发信号）。

新建（都在 `/home/deepseek-agent/dsh-plugins-dev/`，均为测试/文档，非产品代码）：

| 文件 | 说明 |
| --- | --- |
| `clm-dsh-host-test.mjs` | 我写的 mock 宿主功能测试脚本（61 断言） |
| `clm-host-test-report.txt` | 该脚本最近一次输出 |
| `clm-mount-probe.mjs` | 我写的一次性挂载探针插件（真实 profile 挂载验证） |
| `clm-plugin-test-report.md` | 本报告 |
| `web-profile-package.json.bak` | 安装前 web profile 清单（回滚用） |

由官方 CLI 变更（非手工编辑，均为安装/验证的副产物）：

| 路径 | 变更 |
| --- | --- |
| `~/.dsh/profiles/web/package.json` | `dsh plugin add` 自动追加依赖 `oh-my-clm` 并把 `oh-my-clm` 写入 `dsh.profile.bundles` |
| `~/.dsh/profiles/web/node_modules/`、`pnpm-lock.yaml` | pnpm 安装产物 |
| `~/.dsh/profiles/web/.plugin-manager/logs/` | `dsh plugin` 操作日志目录 |
| `~/.dsh/profiles/clmtest/**` | 新建的临时 profile（base + headless + oh-my-clm），仍在 |
| `~/.dsh/profiles/web/cordis.yml` | 被 DSH 自身在 prepare 时重写（该文件按设计每次 boot 重写，非我编辑） |

新建后已删除：

- `~/.dsh/profiles/clmplug/**`（base-only 挂载探针 profile）
- `/home/deepseek-agent/.tmp-clm-test/**`（tarball 解包目录）
- `/home/deepseek-agent/oh-my-clm-0.1.0.tgz` 的原始位置（按你最初要求移入 `dsh-plugins-dev/`）

运行时产生、非我写入：

- `/tmp/clm-eaeb7e4c-4e8d-4c44-babd-00b18035026b/LIVE_CTX_MAIN.md`：插件自身生成；我为验证写权限做过一次 `edit`，**随后已还原为原文**。
