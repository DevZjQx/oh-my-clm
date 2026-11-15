# 文档

只保留当前行为契约与工程约束；根 [README](../README.md) 提供安装、命令和配置摘要。

## 功能契约

- [Live context mirror](./features/live-context-mirror.md)：Pi 侧 mirror 生命周期、文件协议、编辑校验与限制。
- [Cleanup 与 block index](./features/cleanup-tool.md)：按 ID 删除/软卸载、索引形状、结果模式与配置。
- [DSH surface bridge](./features/dsh-surface-bridge.md)：Cordis 生命周期、`Session.append()` replacement、打包与未验证边界。
- [自动清理 canary](./features/auto-clear.md)：`autoClear.canary` / `autoClear.enabled` 选择器、被取代口径、批量闸门与离线重放。

## 工程

- [项目结构](./project-structure.md)：分层、单向依赖、测试布局与生成物。

版本说明见根目录 [changelog.md](../changelog.md)。
