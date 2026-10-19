# 文档

文档按用途分组。功能文档描述当前行为契约；根目录 [README](../README.md) 保留概览、快速开始和功能摘要。

## 功能

- [Live context mirror](./features/live-context-mirror.md)：Pi 侧核心机制，包括 mirror 生命周期、文件协议、snapshot、编辑校验、self-read 保护和当前限制。
- [Cleanup 与 block index](./features/cleanup-tool.md)：按 block ID 删除历史的工具契约、digest/blocks 索引、只读 listing、结果模式和配置。
- [DSH surface bridge](./features/dsh-surface-bridge.md)：DSH/Cordis 生命周期、`Session.append()` surface replacement、与 Pi 的语义差异、打包和验证边界。

## 工程

- [项目结构](./project-structure.md)：`src` 的分层目录、单向依赖规则、测试布局，以及 `scripts/check-boundaries.mjs` 的自动检查。

## 资料

- [CLM 技术分析表](./reference/clm-technical-analysis.md)：Context Language Models 论文、官方实现、评估体系和本项目的支持矩阵。
- [DSH 前缀缓存](./reference/dsh-prefix-cache.md)：服务端前缀 KV 缓存、DSH 侧架构对齐和逐请求命中率可观测性；外部数字标注为社区观测。

## 验证

- [DSH 证据与 harness](./reports/README.md)：mock host harness 的运行方式、当前证据和历史验证报告。
- [事实核查报告（2026-10-20，本地）](./fact-check-2026-10-20.md)：对当时文档与实现的一次性核查记录，路径和行号指向重组前结构，不作为当前行为说明。

版本更新说明见根目录的 [changelog.md](../changelog.md)。
