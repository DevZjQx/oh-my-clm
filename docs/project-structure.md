# 项目结构

本项目是 Pi extension + DSH host plugin 的双入口 TypeScript 包。目录结构借用 bulletproof-react 的 feature-based 思路，但按 Node/TS 包的实际形态做了裁剪：**两层目录（`lib` + `features`）+ 一层 host adapter + 单向依赖**。

## 目录总览

```text
oh-my-clm
├── src
│   ├── lib                      # 共享基础设施：不包含业务领域
│   │   ├── clm-files.ts         # session mirror 的原子写入和私有文件权限
│   │   └── clm-paths.ts         # /tmp/clm-<sessionId> 路径解析
│   └── features
│       └── live-context         # 唯一的业务领域：live context mirror
│           ├── context-format.ts   # record 构建、渲染/解析、snapshot、编辑规划
│           ├── context-cleanup.ts  # block-ID cleanup 参数与 span 删除
│           └── dsh-bridge.ts       # DSH surface 适配与 Session.append() mutation
├── extensions
│   └── clm.ts                   # Pi host adapter（application 层）
├── dsh
│   └── index.ts                 # DSH/Cordis host adapter（application 层）
├── test
│   ├── lib                      # 与 src/lib 对应的测试
│   ├── features/live-context    # 与 feature 对应的测试
│   ├── adapters                 # host adapter 与 Pi session 集成测试
│   ├── package                  # 包契约测试（manifest / 发布元数据）
│   └── harness                  # 手动 mock-host harness（不进入 npm 包）
├── scripts
│   ├── build-dsh-plugin.mjs     # 生成 DSH 专用 tgz
│   ├── check-dsh-package.mjs    # 发布元数据检查
│   └── check-boundaries.mjs     # 单向依赖检查
├── docs
│   ├── README.md                # 文档索引
│   ├── features                 # 功能契约（每份文档对应一个可独立理解的机制）
│   │   ├── live-context-mirror.md
│   │   ├── cleanup-tool.md
│   │   └── dsh-surface-bridge.md
│   ├── project-structure.md     # 本文
│   ├── reference                # 论文、上游实现和宿主机制的背景资料
│   │   ├── clm-technical-analysis.md
│   │   └── dsh-prefix-cache.md
│   ├── fact-check-2026-10-20.md # 一次性事实核查报告（本地，不随 npm 包发布）
│   ├── reports                  # 历史验证报告 + 报告说明
│   └── reckless                 # 内部决策记录/证据账本/路线图（不发布）
├── dist                         # tsc 构建产物（随仓库提交）
├── artifacts                    # DSH tgz 输出目录（构建生成，gitignore）
├── dsh-plugin.json              # DSH Community v0.15 manifest
├── cordis.patch.yml             # 官方 bundle 安装层
└── package.json
```

文档按用途分组：`features/` 描述当前行为契约，`reference/` 放外部资料和背景，`reports/` 放验证证据，`reckless/` 是本地决策记录。新增功能文档放进 `docs/features/` 并在 [docs/README.md](./README.md) 登记；根 README 只保留概览和入口链接，详细契约放在功能文档中。

## 分层与导入规则

依赖只能从下往上：

```text
shared (src/lib)  <-  features (src/features/<name>)  <-  host adapters  <-  test
```

| 层 | 位置 | 允许导入 |
| --- | --- | --- |
| shared | `src/lib/**` | 只允许 `src/lib` 与 Node 内置模块 |
| feature | `src/features/<name>/**` | `src/lib`、同一 feature 内部文件 |
| host adapter | `extensions/**`、`dsh/**` | `src/lib`、任意 feature |
| test | `test/**` | 任意层 |

- **feature 之间不能互相导入。** 需要组合时，在 host adapter 里组合，或把共用部分上移到 `src/lib`。
- **shared 不能知道任何 feature 或 host adapter。** `src/lib` 只做领域无关的文件、路径等基础设施。
- **host adapter 不包含可复用业务逻辑。** Pi/DSH 生命周期、system prompt、工具注册留在入口；mirror 协议和安全校验属于 `features/live-context`。
- **没有 barrel 文件。** 不建 `index.ts`，不使用 `export * from`；直接导入具体文件，让归属和 tree-shaking 都保持清晰。

### 为什么 host entry 不在 `src/app`

Pi 和 DSH 都通过固定路径发现入口：`package.json` 的 `pi.extensions` 指向 `./extensions/clm.ts`，`dsh-plugin.json` 的 `facets.host.entry` 指向构建后的 `dist/dsh/index.js`。这些路径是宿主约定，移动它们会破坏已安装配置和文档命令，因此入口留在原位置，承担 application/adapter 层；`src` 则保持可测试、与宿主解耦的库代码。

## 新代码放在哪里

| 场景 | 位置 |
| --- | --- |
| 只被一个 feature 使用 | `src/features/<feature>/` |
| 被两个 feature 或 host adapter 使用，且与领域无关 | `src/lib/` |
| mirror 协议、校验、编辑规划 | `src/features/live-context/` |
| Pi 生命周期、`/clm` 命令、self-read guard | `extensions/clm.ts` |
| Cordis 生命周期、system prompt、工具注册 | `dsh/index.ts` |
| 构建或发布脚本 | `scripts/` |
| 历史验证证据 | `docs/reports/` |
| 手动 mock-host 检查 | `test/harness/` |

新增 feature 时，只创建它实际需要的文件，不要预建空目录。当前只有一个业务领域（`live-context`），因此 `src/features` 下只有这一个文件夹是合理的；出现第二个独立领域时再新增。

## 测试布局

测试目录镜像源码分层，便于判断一个测试覆盖哪一层：

- `test/lib/*.test.ts`：shared 模块；
- `test/features/live-context/*.test.ts`：mirror 协议、cleanup、DSH bridge；
- `test/adapters/*.test.ts`：Pi extension 与 Pi session 集成；
- `test/package/*.test.ts`：manifest / 发布元数据契约；
- `test/harness/*.mjs`：需要手动运行、依赖构建产物 `dist/` 的 mock-host harness。

`npm test` 运行 `node --experimental-strip-types --test "test/**/*.test.ts"`，只发现 `*.test.ts`，不会把 `test/harness/` 下的手动脚本当成测试。

## 生成物与证据

| 目录 | 内容 | 是否提交 |
| --- | --- | --- |
| `dist/` | `tsc -p tsconfig.dsh.json` 的构建产物，DSH 运行时直接加载 | 提交 |
| `artifacts/` | `scripts/build-dsh-plugin.mjs` 生成的插件 tgz | 不提交（gitignore） |
| `docs/reports/` | 历史验证报告及其说明 | 提交 |
| `/tmp/clm-<sessionId>/` | 运行时 live mirror，不属于仓库 | 不提交 |

## 自动检查

`npm run check` 的第一步是：

```bash
node scripts/check-boundaries.mjs
```

它扫描 `src`、`extensions`、`dsh`、`test` 的相对导入，检查以下规则并列出违规文件：

1. `src/lib` 不导入 feature 或 host adapter；
2. feature 不跨 feature 导入，也不导入 host adapter 或测试；
3. host adapter 不导入测试；
4. `src` 中不出现 `index.ts` barrel 或 `export * from`。

新增目录后如果检查器不识别，请在 `scripts/check-boundaries.mjs` 的 `layerOf()` 中补充该目录的层级，不要放宽规则。
