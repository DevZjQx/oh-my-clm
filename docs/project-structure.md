# 项目结构

Pi extension + DSH host plugin 的双入口 TypeScript 包。目录按 **shared → feature → host adapter** 分层，依赖单向。

## 目录

```text
oh-my-clm
├── src
│   ├── lib                      # 共享基础设施：mirror 文件写入、路径解析、JSON 配置
│   └── features/live-context    # 唯一业务领域
│       ├── auto-clear.ts        # 自动清理选择器：被取代判定、peek/retire、批量闸门
│       ├── clear-projection.ts  # 清理记录的消息投影（纯函数，回放收敛）
│       ├── context-format.ts    # record 构建、渲染/解析、snapshot、编辑规划
│       ├── context-cleanup.ts   # cleanup 参数、配对校验、删除与 offload
│       ├── context-prompt.ts    # DSH 系统提示段（进程级静态文本）
│       ├── context-trigger.ts   # 触发判定、用量行与候选装配
│       ├── dsh-bridge.ts        # DSH surface 适配与 Session.append() mutation
│       └── plugin-record.ts     # 宿主 appendPluginRecord seam 的动态解析
├── extensions/clm.ts            # Pi host adapter
├── dsh/index.ts                 # DSH/Cordis host adapter
├── test
│   ├── lib
│   ├── features/live-context
│   ├── adapters
│   ├── package                  # manifest / 发布元数据契约
│   └── harness                  # 手动 mock-host 检查，不进入 npm 包
├── scripts                      # 构建、包检查、依赖边界检查、会话重放
├── docs
│   ├── README.md
│   ├── features                 # 功能契约
│   └── project-structure.md
├── diagrams                     # 架构图源文件（.mmd / .excalidraw）与渲染结果，不随 npm 包发布
├── dist                         # tsc 构建产物，随仓库提交
└── artifacts                    # DSH tgz 输出，gitignore
```

## 分层与导入规则

| 层 | 位置 | 允许导入 |
| --- | --- | --- |
| shared | `src/lib/**` | `src/lib` 与 Node 内置模块 |
| feature | `src/features/<name>/**` | `src/lib`、同一 feature 内部文件 |
| host adapter | `extensions/**`、`dsh/**` | `src/lib`、任意 feature |
| test | `test/**` | 任意层 |

- feature 之间不能互相导入；需要组合时在 host adapter 组合，或把共用部分上移到 `src/lib`。
- `src/lib` 不知道任何 feature 或 host adapter。
- host adapter 不承载可复用业务逻辑；mirror 协议与安全校验属于 `features/live-context`。
- `src/**` 内不使用 barrel 文件：不建 `index.ts`，不写 `export * from`。宿主入口 `dsh/index.ts` 是硬约定路径的例外，不要改名或移动。
- 宿主发现路径是硬约定：`package.json` 的 `pi.extensions` 指向 `./extensions/clm.ts`，`dsh-plugin.json` 的 host entry 指向 `dist/dsh/index.js`。因此入口留在仓库顶层，不放进 `src/app`。

## 新代码放在哪里

| 场景 | 位置 |
| --- | --- |
| 只被一个 feature 使用 | `src/features/<feature>/` |
| 被多个 feature 或 host adapter 使用，且与领域无关 | `src/lib/` |
| mirror 协议、校验、编辑规划 | `src/features/live-context/` |
| Pi 生命周期、`/clm` 命令、self-read guard | `extensions/clm.ts` |
| Cordis 生命周期、system prompt、工具注册 | `dsh/index.ts` |
| 构建或发布脚本 | `scripts/` |
| 手动 mock-host 检查 | `test/harness/` |

新增 feature 时只创建实际需要的文件，不预建空目录。当前只有一个业务领域（`live-context`），因此 `src/features` 下只有一个文件夹是合理的。

## 测试与生成物

测试目录镜像源码分层：

- `test/lib/*.test.ts`：shared 模块；
- `test/features/live-context/*.test.ts`：mirror、cleanup、DSH bridge、自动清理选择器与投影；
- `test/adapters/*.test.ts`：Pi extension 与 session 集成；
- `test/package/*.test.ts`：manifest / 发布元数据；
- `test/harness/*.mjs`：需要构建产物 `dist/` 的手动 mock-host 检查。
- `scripts/canary-replay.mjs`：把已存会话日志重放进自动清理选择器（`npm run canary:replay`），需要 `dist/` 与 PATH 上的 `zstd`；随包发布，所以安装后也能跑。

`npm test` 只发现 `*.test.ts`，不会把 `test/harness/` 当测试运行。`dist/` 提交，`artifacts/` 与 `/tmp/clm-<sessionId>/` 不提交。

`npm run check` 首先运行 `scripts/check-boundaries.mjs`，检查：shared 不导入 feature/host adapter；feature 不跨 feature、不导入 host adapter 或测试；host adapter 不导入测试；`src` 中无 barrel。新增目录后应在 `layerOf()` 中补充层级，不要放宽规则。
