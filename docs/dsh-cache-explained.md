**KV 缓存本身是 DeepSeek API 服务端的能力，dsh 的"缓存机制"本质上是通过架构设计去最大化服务端前缀缓存的命中率**。整体可以分为三层来理解：

## 1. 服务端：DeepSeek 前缀 KV 缓存（自动开启）

DeepSeek API 的 Context Caching on Disk 默认对所有用户开启，无需改代码。它的规则是：

- 每次请求会检查新 prompt 的**前缀**（从第 0 个 token 开始的逐字节匹配）是否与之前请求已持久化的缓存前缀单元完全匹配，匹配部分按缓存命中价计费（约为未命中价的 1/10 ~ 1/30）
- 缓存前缀单元在三种情况下持久化：请求边界（用户输入末尾/模型输出末尾）、跨请求公共前缀检测、长文本按固定 token 间隔切分
- 响应的 `usage` 中通过 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 两个字段反映命中情况
- 缓存是尽力而为（best-effort）的，不用时通常几小时到几天内自动清除 [1]

实测数据显示，命中需要前缀超过 1024 token 的激活阈值，且按 256 token 块对齐 [2]。

## 2. dsh 侧：为命中而生的架构设计

dsh 本身不实现 KV 缓存，但它的会话架构"恰好"是前缀缓存最理想的输入形状，这也是社区实测能到 97–99% 命中率的原因 [3]：

- **追加式（append-only）事件日志**：会话是事件溯源的日志（`session-persistence-jsonl` / `sqlite` 包），历史一旦写入就不可变，每轮只是把模型回复、工具调用、工具结果、新用户输入**追加到末尾**，绝不改写上游内容——这正是前缀缓存奖励的形状 [3][4]
- **系统提示词稳定**：同一会话内系统提示词固定，除非主动切换 agent 模式（minimal/standard/PTC 等），切换会改变系统提示词和工具 schema，使缓存前缀失效 [3]
- **确定性的工具序列化**：工具 schema 顺序固定，避免每轮重排导致前缀漂移 [5]
- 官方宣传口径称通过严格的前缀排序、固定的 Tool-Contract 定义和增量式历史，可达 99.93% 的前缀缓存命中率，节省 80%+ 的 token 成本 [6]

## 3. 可观测性与提供商兼容层

- **逐请求记账**：dsh 把每次请求的命中/未命中 token 拆分写入 `~/.dsh/sessions` 日志，Web UI 直接展示每会话的缓存命中率（v0.1.1-rc.1 还专门改进了 99.x% 的显示精度）[3][7]
- **会话投影**：Host 广播 `tokenUsage` 投影，包含互斥的计费桶：`cacheReadTokens`（命中）、`uncachedInputTokens`（未命中）、`cacheWriteTokens`（写缓存）、`outputTokens`，社区插件（如 `dsh-client-ui-cache-hit`、`dsh-session-stats-panel`）据此在侧边栏实时显示命中率 [8]
- **提供商兼容门控**：对非 DeepSeek 的 OpenAI 兼容端点，dsh 通过 pi-ai 层提供 `cacheControlFormat`（Anthropic 风格 `cache_control` 断点）、`sendSessionAffinityHeaders`、`prompt_cache_key` 等开关。例如对 z.ai GLM 路由，社区实测开启 `cacheControlFormat: anthropic` 后命中率从 70.5% 提升到 86.9%，并消除了并发会话互相驱逐导致的整段 miss [9]

## 什么会破坏缓存

| 行为 | 影响 |
| --- | --- |
| 同一会话内追加消息 | 无影响（缓存设计的目标场景）[1] |
| 切换 agent 模式 / 模型 / 提供商 | 系统提示词或工具 schema 变化，前缀从该点全部失效 [3] |
| 插件向前缀注入动态内容（时间戳、计数器） | 逐字节匹配失败，每轮全量 miss [5] |
| 子代理（subagent） | 各自开新上下文、各自冷启动 prefill，稀释父会话缓存优势 [3] |
| 多会话共享一个 API key（部分提供商） | 隐式缓存按 key 共享，兄弟会话互相驱逐 [9] |

## 已知问题

仓库 Discussion #3304 报告过某些后端（腾讯 copilot）命中率恒为 0 的问题：每轮都携带完整 30 工具集（约 6.6K token schema）且前缀不稳定，导致每轮全量重算，建议方向是懒加载工具和保持前缀稳定 [10]。而 Discussion #2064 的 650 请求审计则从计费角度验证了正常情况下 98.09% 的命中率，并指出缓存命中档位的调价对重度缓存用户影响最大 [7]。

**一句话总结**：dsh 的缓存机制 = 服务端自动的前缀 KV 缓存 + dsh 侧"稳定系统提示词 + 追加式历史 + 确定性工具序列化"的架构对齐 + 会话日志/投影中的逐请求命中率可观测性。

Sources:
[1] https://api-docs.deepseek.com/guides/kv_cache/
[2] https://github.com/HenryZ838978/deepseek-harness
[3] https://findharness.com/blog/deepseek-harness-kv-cache-explained
[4] https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/persistence
[5] https://www.morphllm.com/prompt-caching
[6] https://deepseekharness.dev/
[7] https://github.com/deepseek-ai/deepseek-harness/discussions/2064
[8] https://www.dshplugin.store/plugin/sqs404/dsh-client-ui-cache-hit
[9] https://github.com/deepseek-ai/deepseek-harness/discussions/5227
[10] https://github.com/deepseek-ai/deepseek-harness/discussions/3304
