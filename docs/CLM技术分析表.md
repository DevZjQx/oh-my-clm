# Context Language Models（CLM）技术分析表

> **分析对象**：论文 [Context Language Models（arXiv:2609.37725）](https://arxiv.org/html/2609.37725)、官方仓库 [facebookresearch/context-language-models](https://github.com/facebookresearch/context-language-models) 及其 [`clm/clm_harness`](https://github.com/facebookresearch/context-language-models/tree/main/clm/clm_harness)。
>
> **仓库版本**：本次阅读的 `main` 提交为 `483198229ab7b90c0eed4651306ab3b3505aaf50`；源码链接优先指向该提交，避免后续 `main` 变化造成歧义。
>
> **结论先行**：CLM 不是一种新的 Transformer 注意力结构，而是把“下一轮模型实际看到的上下文如何构造”从固定 harness 策略改成模型可以直接控制的状态转移。最小实现是“把 live context 镜像成一个文件，模型用普通 Bash 读写该文件”。零样本时不改模型权重；可选的 skill evolution 和 RL 再把上下文管理策略学习到提示词或参数中。

## 1. 总览判断

| 项目 | 判断 |
|---|---|
| 技术本质 | **可编辑上下文协议 + Agent harness + serving/cache 配套**，而不是单独的新模型架构。 |
| 核心抽象 | 标准 LM 近似为 `c(t+1) = c(t) ⊕ f_LM(c(t))`（只追加）；CLM 为 `c(t+1) = f_CLM(c(t))`（模型决定保留、删除、改写、重排或外置哪些上下文）。 |
| 最小能力 | 模型只需获得一个 Bash 工具和 live-context 文件路径；无需专门的 `compact()`、`retrieve()`、`offload()` 工具。 |
| 主要收益 | 在长时程任务中，模型能按任务语义选择性保留事实、原地更新状态、把大块内容外置，并降低上下文压力及标准 prefix-cache 下的重复 prefill。 |
| 最大代价 | 交给模型更大的控制权也交给它更大的失败空间：错误压缩、误删事实、编辑导致 cache 失配、工具调用结构丢失，以及可持久化的 prompt injection。 |
| 成熟度判断 | 研究原型和评测框架已经较完整；生产化仍需要更强的结构化上下文编辑协议、权限/审计、缓存精确性保证和更广泛的模型/任务验证。 |

## 2. 主分析表：技术细节、评估体系、实现方法、优缺点与限制

| 技术点 | 本项目支持 | 技术细节 | 评估体系 | 实现方法（官方代码） | 优点 | 缺点 / 限制 |
|---|---|---|---|---|---|---|
| **可控上下文转移** | ✅ 支持 | 把 context 视为每一轮的状态，而不是不可变的消息累加器。`f_CLM` 可以是任意由模型控制的上下文变换。 | 论文先用 ContextBench 把“上下文管理”从知识和推理中隔离，再用 coding、deep research、open discovery 检验长时程收益。 | 模型每轮输出一个 Bash action；下一轮请求使用编辑后的 message list。论文 §4.1；[`harness.py`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_harness/clm_agent/harness.py)。 | 上下文管理可以按任务动态适配，不被人预先限定为摘要、检索或折叠。 | “任意函数”仍受模型工具使用能力、上下文预算、消息格式和 harness 安全边界约束；小模型可能很少主动编辑。 |
| **Context-as-a-file** | ✅ 支持 | live context 被镜像为文件；编辑文件会改变后续 LM 请求。未编辑时，生成内容按普通对话追加。 | ContextBench 的 Needle、Sudoku、KV Store、Log Triage 分别测试选择性保留、原地更新、外置检索和日志归并。 | 每次 Bash 前写入 `/tmp/.live_ctx/LIVE_CTX_MAIN.txt`；命令执行后下载并解析文件；官方 README 的执行流程和 [`context_env/env.py`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_harness/context_env/env.py)。 | 接口极小、通用；模型可以使用现成的 `python`、`sed`、重定向、`grep` 等能力组合出新策略。 | 文件协议本身是非结构化文本；编辑正确性、文件权限、并发一致性和外置文件生命周期都需要额外治理。 |
| **近似 unrestricted editing** | ◐ 部分：只能改写/删除既有 block，不能新增或重排，且必须更短 | 可删除/替换旧消息、只保留摘要、维护 ledger/scoreboard、添加内部 notes、写可复用压缩函数，也可把原文外置到磁盘。 | 论文 Figure 3 展示多 agent scoreboard、内部角色、循环压缩、可复用 `compact_turns` 等零样本行为。 | `render_editable()` 为每个可编辑 turn 加 `[[CTX_TURN n role=...]]` header；`parse_back()` 根据保留 header 重建消息。见 [`context_utils/context_string.py`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_harness/context_utils/context_string.py)。 | 不需要为每一种未来策略增加新工具；模型可以发现人类没有预先设计的操作组合。 | 实际并非无边界：system prompt 和初始 task 被固定保护；解析器会合并连续角色、删除空 block；编辑后不会重建原始 `tool_calls` 结构，tool/system 等角色可能被归一化为 user。 |
| **单工具、Bash-native agent** | ❌ 未支持：不强制单 Bash 协议，也没有“纯编辑 turn 不计数” | 模型每次必须先输出 THOUGHT，再调用恰好一个 Bash；纯上下文编辑成功且无输出时不计入 task step。 | 在相同任务预算下比较不同 context harness；记录 task reward、步骤、LM calls、编辑、重试、token 和成本。 | [`clm_agent/prompts.yaml`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_harness/clm_agent/prompts.yaml) 规定协议；`ContextEnv.step()` 完成镜像、执行、回读和 readout。 | 极少 harness-specific primitive，工具空间统一；纯压缩 turn 可免费获得更多任务步。 | “免费”只针对 task step，不代表免费：该 turn 仍消耗 LM call、prompt token 和推理 FLOPs；单 Bash 还会把复杂上下文操作压缩到一个可靠 shell 命令中。 |
| **上下文预算控制** | ◐ 部分：仅 Pi 侧单条临时 nudge，无 25/50/75% 分级提醒与超限回滚；DSH 侧无预算机制 | 预算不是机械截断，而是通过提醒、回滚和强制压缩让模型自救。`strict_target = budget - reserve`，默认 reserve 为 2048 tokens。 | BCP 使用 28,672-token budget、6 次 overflow rollback；EdgeBench 使用 32,000 和最多 50 次；ContextBench 论文设置关闭 nudges/retry，直接观察管理能力。 | [`utils/budget.py`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_harness/utils/budget.py)：25/50/75% 分级 nudge、adaptive persistent nudge、最新 tool output head/tail cap、超限回滚；[`configs/`](https://github.com/facebookresearch/context-language-models/tree/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_harness/configs)。 | 减少静默截断；把“何时压缩”留给模型，同时避免一次大输出直接撞墙。 | 预算计数首先用 `tiktoken o200k`，再用服务端 usage 校准比例；不同 tokenizer、chat template 和 gateway 可能有误差。回滚会永久丢失最近工作，只能靠 ledger 提示模型不要重复。 |
| **Edit gate** | ◐ 部分：固定 shrink gate，无 fit 模式 | `fit`：编辑后只要仍在预算内即可接受；`shrink`：只有上下文变短才接受。默认是 `fit`，BCP 配置为 `shrink`。 | 既看准确率，也看压缩成本和 prefix-reuse FLOPs；可检查模型是否通过无意义删改 reward-hack。 | [`context_env/edit_gate.py`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_harness/context_env/edit_gate.py)；编辑被拒绝时向模型返回可行动的原因。 | 可以按任务选择保守或灵活策略；限制“越编辑越长”的明显错误。 | `fit` 不保证编辑有价值，`shrink` 也不保证删除内容安全；过早强制 shrink 可能损害推理所需的局部细节。 |
| **外置文件与多 agent** | ❌ 未支持：无多 agent 调度，外置记忆只靠普通工作区文件，没有 CLM 式外置记忆管理 | live context 与普通外部文件分离：前者决定下一次输入，后者是可按需检索的 external memory。多个 agent 可以各有 context file。 | Software World：6 个 agent 并行修改互相依赖的 6 个 repo，在未见过的下游包上评分；ATIF-CTX 记录 sub-trajectory 的 spawn/fold。 | 论文给出自然扩展；仓库的 [`agent_trajectory_format`](https://github.com/facebookresearch/context-language-models/tree/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_harness/agent_trajectory_format) 支持 `segments`、`subtrajectories`、`SpawnLink`。但当前 `ClmAgent` 本身是单 agent Bash loop，实验性 `subagents` 参数被显式移除。 | 可将协调状态、工作日志、子任务结果按需放入不同上下文；适合长时间协作和 agent swarm。 | 论文中的多 agent 是工作流级能力，不等于 `clm_harness` 提供了现成的并发调度器；共享文件、竞态、权限、结果折叠和 agent 间 prompt injection 尚需上层设计。 |
| **ATIF-CTX 轨迹格式** | ❌ 未支持：无轨迹/segment 导出 | 普通 ATIF 假设历史 append-only，无法重放自编辑 context；ATIF-CTX 用 segment 保存每次编辑后的真实 `input_context`，并记录 branch。 | 评估可将每次 LM call、上下文分支、回滚空洞、token/cache metrics 对齐；输出 `trajectory.ctx.json`。 | [`models.py`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_harness/agent_trajectory_format/models.py)、[`harness_export.py`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_harness/agent_trajectory_format/harness_export.py)。 | 使非 append-only 轨迹可审计、可重放、可计算 FLOPs；支持嵌套子轨迹。 | 记录格式解决“看到什么”的可观测性，不解决“删掉的信息是否正确”；服务端 token metrics 缺失时仍需估算。 |
| **Prefix-reuse FLOPs** | ❌ 未支持：只估算 token，不算 cache-aware FLOPs | 每轮 prompt 为 `P_t`、生成 `G_t`、可复用最长 prefix 为 `R_t`，需重新 prefill `U_t=P_t-R_t`。基本指标是“未匹配后缀 prefill + 新生成 decode”，而不是简单 prompt token 总数。 | 结果图以 accuracy–prefix-reuse PFLOPs Pareto frontier 展示，不只比较准确率。 | [`flops_metrics/kv_cache_flops.py`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_harness/flops_metrics/kv_cache_flops.py) 优先使用 server `cached_tokens`，其次真实 token ids、HF tokenizer、tiktoken；加入 full-attention 的二次项。 | 能捕捉“中间编辑使后半段重新 prefill”的真实代价，比只计生成 token 更适合 CLM。 | 是模型计算 proxy，不是直接的 wall-clock、显存、功耗或美元账单；忽略/近似 embedding、输出层、归一化、激活和部分 recurrent update，attention decode 还采用近似。 |
| **Prefix-reuse FLOPs 公式** | ❌ 未支持：无 FLOPs 几何参数 | 代码/论文的核心形式：`F_t = C_token (U_t + G_t) + C_attn [ 1/2(P_t²-R_t²) + G_t P_t + 1/2 G_t² ]`，全轨迹为 `Σ_t F_t`。 | Qwen3.6-27B 示例使用 64 层、16 full-attention + 48 GatedDeltaNet；论文报告 `C_token=48.70×10^9`、`C_attn=3.93×10^5`。 | 代码按 `N_BODY_PARAMS` 和 attention geometry 计算；27B 非 embedding body 参数约 `24.3532e9`。 | 同时表达 linear projection、prefill attention、decode attention 和 cache reuse。 | 公式默认标准 prefix cache 和特定模型几何；跨模型、跨 serving engine、跨 tokenizer 不能直接横向比较，除非统一参数和数据源。 |
| **Suffix Cache Reuse（SCR）** | ❌ 未支持：依赖宿主标准 prefix cache | 中间编辑 `[A B C]→[A B' C]` 时，标准 serving 重算 `B'` 和 `C`；SCR 迁移 surviving span `C` 的 K/V，仅 prefill 新插入部分，并对 RoPE key 做位置重旋转。 | 论文 §5.3：匹配性能时约使用标准 SGLang 的 65.0% server-side FLOPs；当前仓库 README 的 SGLang 三 seed 结果为 65.5%，vLLM 结果为 FLOPs -24.7%、时间 -12.5% 且准确率近似不变。 | SGLang 为启动 monkeypatch；vLLM 0.19.1 通过 scheduler subclass + KV connector，最多迁移 `K=6` 个最长 span；混合模型对 linear-attention 保存/恢复 recurrent state。见 [`suffix_cache_reuse/README.md`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/suffix_cache_reuse/README.md) 和 [`vllm/DESIGN.md`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/suffix_cache_reuse/vllm/DESIGN.md)。 | 显著减少中间编辑后的重复 prefill；不改变 agent harness API。 | 迁移的 K/V 是在旧 prefix 下算出的 stale state，仅位置得到修正；多次迁移会累积误差。当前实现有版本、模型、RoPE、混合注意力、side-buffer 显存和 fallback 限制。 |
| **自然语言 steering / skill evolution** | ❌ 未支持：无 skill/evolution 管线 | skill `s` 作为额外上下文输入，模型权重和 harness 固定；可用一句话改变压缩阈值、语义边界和 backup 行为。 | ContextBench 用 train → dev → held-out test；进化选择同时考虑 reward 与 cost，并维护 Pareto frontier。 | [`clm_icl/evolve.py`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_icl/evolve.py)：对 rollout 建 contrastive note，由 proposer 生成完整 `SKILL.md`，候选在 dev 上以配对 SE gate 选择；可 assisted evolution 或 self-evolution。 | 可在不微调模型的情况下让上下文管理策略迭代；策略以可读文本存在，便于审查和迁移。 | skill evolution 需要大量 rollout、proposer 成本和严格 train/dev/test 隔离；skill 可能过拟合任务格式，且文本规则增加 prompt token 和冲突机会。 |
| **RL：success-gated efficiency advantage** | ❌ 未支持：无训练/rollout 管线 | 对同一 rollout group，只有成功轨迹参与效率重排：`A_eff_i = clip((mean(c_success)-c_i)/mean(c_success), -1, 1)`，失败轨迹和成功数少于 2 时为 0；总优势 `A_i=A_out_i+w_eff A_eff_i`。 | Qwen3.5-9B 在 3,040 OpenResearcher prompts 上 GRPO，70 steps；held-out 为 830 题 BCP，准确率和 PFLOPs 同时看。 | [`clm_rl/README.md`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_rl/README.md) 的 dual-channel patch：效率优势只打到“纯 context edit” turn 的 token role mask。 | 避免给失败但短的轨迹效率奖励，也避免简单奖励“删得多/编辑次数多”；可把有效且便宜的编辑策略内化到权重。 | reward 仍是轨迹级、稀疏且昂贵；编辑不可微，所有 segment 共享最终 outcome 信号；RL 训练依赖 rollout server、judge 和大量 GPU，不是 `clm_harness` 单独可运行的训练管线。 |
| **安全与治理** | ◐ 部分：保护初始任务、role 不可变、原始日志保留；无来源标签/审批/签名 | 可编辑 context 可把模型生成的指令、错误摘要或攻击载荷持续带入未来 turn；外部文件也可能成为隐式长期记忆。 | 论文 Discussion 明确提出 prompt injection / self-generated instruction 的新攻击面；当前评测主要衡量任务成功和效率，不是安全鲁棒性。 | system/task 前缀固定；运行在 Harbor sandbox；编辑 gate、trajectory、usage 和 source fingerprint 提供部分审计。 | 比固定摘要器更灵活，同时保留一定的系统前缀保护和运行记录。 | system/task 以外的历史仍可被重写；“模型可修改自己看到的上下文”必须配合内容来源标记、不可伪造的用户消息、权限隔离、审计和回滚策略。 |

> **勾选说明**：✅ = 已实现该技术点；◐ = 只实现了受限子集；❌ = 未实现。判定基于 `oh-my-clm` 0.1.5 的 [`README.md`](../README.md)、[`docs/how-it-works.md`](./how-it-works.md)、[`extensions/clm.ts`](../extensions/clm.ts)、[`src/features/live-context/context-format.ts`](../src/features/live-context/context-format.ts) 和 [`src/features/live-context/dsh-bridge.ts`](../src/features/live-context/dsh-bridge.ts)；只统计插件自身实现，不把宿主 Pi/DSH 自带能力（原生 auto-compaction、`/compact`、prefix cache、session log）算作“支持”。
>
> 14 个技术点中 ✅ 2 项、◐ 4 项、❌ 8 项。与官方 `clm_harness` 相比，本项目是宿主生命周期内的精简 live-context 层：它落地“可控上下文转移 + Context-as-a-file + shrink-only 校验”，而预算状态机、轨迹与 FLOPs 计量、SCR、skill evolution、RL 和多 agent 均未实现。

## 3. `clm_harness` 的实际执行链路

| 步骤 | 运行时动作 | 关键数据 / 默认行为 | 对技术结论的影响 |
|---|---|---|---|
| 1. 初始化 | 构造 system prompt 和 task；前两条消息（system + initial task）固定。 | `protect = 2`；未显式传 `context_budget_tokens` 会直接报错，避免意外使用完整模型窗口。 | CLM 的可编辑范围是“受保护前缀之后的 live history”，不是任意修改 system instruction。 |
| 2. 镜像 | 每次执行 Bash 前，将可编辑消息渲染到 live-context 文件。 | 每个 block 带 role header；assistant reasoning/content/tool call 会被串入可编辑文本；tool observation 也被呈现。 | 模型操作的是“模型实际历史的文本投影”，而非另一个摘要数据库。 |
| 3. 调用模型 | 模型看到 context readout，必须调用一个 Bash。 | 支持 OpenAI-compatible endpoint；可选 thinking、temperature、top-p、max token；持久 Bash 保存 cwd/env。 | 上下文策略由模型生成的代码和文本共同决定，shell 能力成为 CLM 能力的一部分。 |
| 4. 执行命令 | Harbor sandbox 执行 Bash，限时并截断过大的 tool output。 | 可用 `python3`、`sed`、重定向、`grep` 等；输出默认 head/tail 截断。 | 可以同时把数据外置到普通文件，再在 live context 留指针。 |
| 5. 回读与解析 | 命令结束后下载文件；若发生改变，`parse_back` 重建 message list。 | 编辑结果接受前经过 token count 和 edit gate；空 block 被删除，连续同角色合并，工具结构不保留。 | “上下文编辑”本质上是一次 message-history branch，而不是字符串替换后继续沿用原始 KV。 |
| 6. 预算状态机 | 低水位提醒；超限时回滚最近 turn，并在剩余空间中要求只做压缩；没有可回滚空间时给最后一轮。 | BCP：`shrink` gate、6 次 retry；EdgeBench：50 次 retry；ContextBench 论文运行关闭提醒。 | 论文的零样本策略建立在模型主动管理上，但实际实验仍有任务专用配置和环境提醒。 |
| 7. 轨迹记录 | 每个 LM call 写 context snapshot；最终导出 trajectory。 | `trajectory.json`、`usage.json`、`timing.json`、`context_snapshots/`、`trajectory.ctx.json`。 | 支持把编辑、回滚、实际输入、服务端 usage 和成本对齐，而不会把编辑后的上下文错误地当作 append-only 轨迹。 |
| 8. 成本统计 | 复放每轮 prompt，通过 server usage 或 token matching 计算 cache-aware FLOPs。 | 开源模型通常以 FLOPs 为 headline；API 模型以 USD 为 headline，同时保留 local cache-aware estimate。 | 允许画准确率–成本 Pareto frontier，但必须注明是估计 FLOPs、API 账单还是实测延迟。 |

## 4. 评估体系与结果表

### 4.1 评测维度

| 维度 | 指标 | 设计目的 | 注意事项 |
|---|---|---|---|
| 任务正确性 | verifier pass/fail、百分制 reward、deep-research accuracy、数学目标函数 | 直接衡量最终任务是否完成。 | 不同 benchmark 的 reward 不可直接互换；部分结果由 judge model 判定。 |
| 上下文管理能力 | 保留原文、原地更新状态、精确取回外置值、日志问答 | ContextBench 将知识、搜索和复杂推理降到最低，隔离 context management。 | 这是诊断性合成任务，不等于真实工程任务；“文件中有答案但 live context 没有”不计分。 |
| 推理成本 | prefix-reuse FLOPs / PFLOPs、prompt/completion token、API USD | 统计中间编辑引起的 re-prefill，避免只看准确率。 | FLOPs 是理论/服务器模型 proxy；真实延迟还受 batch、GPU、显存、调度和网络影响。 |
| 轨迹效率 | 同等准确率下成本、Pareto frontier、每题/每 trial 平均 PFLOPs | 判断 CLM 是不是通过更聪明的上下文管理得到收益，而不是单纯多算。 | 对不同模型、不同 tokenizer、不同 cache engine 的数字必须统一口径。 |
| 长时程能力 | turn 数、运行小时数、最佳提交分数、跨 repo 下游 speedup | 检验上下文管理对 hundreds/thousands turns 和多 agent 的价值。 | 长时程实验同时混入工具使用、搜索、代码迭代和规划能力，无法完全归因于 context。 |
| 可学习性 | natural-language steering、skill evolution 的 dev/test reward、RL 前后 accuracy/cost | 验证上下文管理可以像普通 skill 一样做 ICL、文本进化和参数学习。 | skill 和 RL 都可能对数据分布、任务模板和 judge 过拟合。 |
| 服务效率 | 标准 SGLang/vLLM 与 SCR 的 prefill、FLOPs、TTFT、throughput、accuracy | 验证 cache 近似是否能在保持质量时兑现系统收益。 | SCR 引入 stale K/V；必须同时报告准确率和 cache/延迟收益，不能只报 token 节省。 |

### 4.2 论文主要 benchmark 结果

| Benchmark / 实验 | 设置 | 结果（论文或当前仓库报告） | 解读与局限 |
|---|---|---|---|
| **ContextBench** | 4 类任务：Needle Retention、Sudoku Sketchpad、KV Store、Log Triage；32,768 context，预留 2,048 response；context pressure 最高到约 `24×`；每个方法得到同一任务说明和方法专属 skill。 | 固定 Summary、Folding、RLM、Self-Compact、ACM 等策略在至少一种简单任务上失败；文本 skill evolution 的 assisted setting：dev 上 Needle `97.6→100.0%`、Sudoku `45.3→65.8%`、KV `22.3→83.8%`、Log `0→100%`；held-out KV `38.3→74.2%`（+35.9 points）。 | 强力证明“可编辑 live context”能处理选择性保留和原地更新；但任务是合成的，不能替代真实 agent 的安全、语义和并发评测。 |
| **TerminalBench 2.1** | 89 个终端 coding task；Qwen3.6-27B/Qwen3.5-9B、vLLM、32K budget、最多 64 turns，最终由 verifier pass/fail。 | Qwen3.6-27B 的 CLM 与最强 Codex-style summary 准确率相当，但 prefix-reuse FLOPs 约为其 70%。 | 说明 CLM 可在 coding 中降低上下文重复计算；准确率相同意味着不能只看“更便宜”，还要确认没有隐藏回归。 |
| **OpenThoughts TBLite** | 终端任务，32K budget，最多 2,048 generated tokens/call；平均 verifier reward。 | CLM `73.7%`，summary baseline `67.0%`；使用约 `91%` 的 prefix-reuse FLOPs。 | 在轻量 terminal benchmark 上质量更高、成本略低；任务规模仍小于长时程 repository 优化。 |
| **BrowseComp-Plus** | 全部 830 题；Qwen3.6-27B、32K context；search 返回 top-10×512-token snippets，reader 上限 8,192；最多 100 turns，CLM edit turn 不计入 turn cap；judge 为 Qwen3.5-27B。 | CLM `59.4%`，比最强 Codex-style summary 高 `11.4%`（相对）；prefix-reuse FLOPs 比 summary 少 `21.5%`，比 MEM1 少 `28.9%`。 | 是论文最重要的 deep-research 结果；但依赖搜索工具、skill、judge model、tokenizer 和特定 Qwen 版本，不能外推为所有模型都收益。 |
| **数学 open discovery** | Claude 4.6 Sonnet；32K；每题最多 100 次 evaluator-scored attempts 或 5 小时；与 OpenEvolve / OpenEvolve-Agent 比较。 | 最佳分数：CLM `circle 2.618`、`Heilbronn 0.03653`、`min-max/min-dist 0.07758`、`Erdős overlap 0.38094`；CLM(SA) circle 达 `2.636`。论文称四题均超过专用 OpenEvolve workflow。 | 表明通用 agent + 可编辑 context 可以超过固定 evolutionary orchestration；每种问题只有一次长 run，统计稳定性有限。 |
| **EdgeBench-10** | 10/48 tasks，三 seeds，12 小时、无网络；score 为最佳 graded submission 或最终 repo；Qwen3.6-27B 32K。 | Qwen3.6-27B：CLM `44.6`、约 `179 PFLOPs/trial`；summary `42.3`、`437 PFLOPs/trial`；subagent CLM `44.2`、`181 PFLOPs`。Claude 4.6 Sonnet：CLM `51.0`，summary `42.3`。 | 长时程 repo 优化上约高 5%、少 59% FLOPs；但 10-task subset、三 seeds 和 12 小时成本很高，结果受模型、超参和提交策略影响。 |
| **Software World agent swarm** | 6 个 agent 并行工作超过 24 小时，优化互相依赖的 6 个 repo；在未见过的 4 个 downstream packages 的 17 个 CPU benchmark 上取 geometric-mean speedup；同等 spend。 | CLM 相对 summary-based swarm 的下游 speedup 提升 `65%`。 | 体现多 context / 多 agent 的潜力；同时也是最难归因的结果，包含并发调度、代码优化、wake policy、模型和 spend 等多个变量。 |
| **Natural-language steering** | Claude 4.6 Sonnet；通过一句附加指令控制压缩阈值、问题边界和 backup；分别使用 30 个长问题、189 个 chained sessions、91 个 paired backup questions 等。 | 论文 Figure 9 显示策略按文字指令改变：可指定约何时压缩、按语义边界压缩、压缩前复制 context。 | 证明 context policy 是 in-context 可控行为；但控制实验依赖特定 prompt，不能保证任何模型都遵守。 |
| **RL on BCP** | Qwen3.5-9B；3,040 OpenResearcher prompts；GRPO 70 steps；每 step 8 prompts×32 rollouts；评估 830 BCP。 | Summary：`34.7→42.1%`，`4.01→2.19 PFLOPs/Q`；CLM：`28.8→42.5%`，`1.52→1.34 PFLOPs/Q`。CLM 相对初始 accuracy 提升约 `47.6%`，训练后比 summary 高 `0.4 points` 且少 `38.8%` FLOPs。 | 说明可把上下文管理内化到较小模型；训练代价很高（论文使用 16 H200 policy + 48 rollout），且 reward/judge transfer 仍有限。 |
| **SCR serving** | SGLang / vLLM 版本化实现；Qwen3.6-27B；标准 prefix caching 与 SCR 对照。 | 论文正文：SCR 在匹配性能下约为标准 SGLang 的 `65.0%` FLOPs；当前仓库 README：SGLang 三 seed 为 `65.5%`，accuracy `60.6 vs 59.0`；vLLM BCP 为 `7.42 vs 9.86 PFLOPs/question`（-24.7%）、时间 `484.5 vs 553.8s`（-12.5%）、accuracy `58.88 vs 58.80`。 | 数字因论文版本/当前 main README 口径略有差异，应保留来源和版本；vLLM 当前实现还限制 v0.19.1、若干注意力/并行配置，并需要额外 KV 管理。 |

### 4.3 评测公平性与可复现性检查

| 检查项 | 官方做法 | 仍需警惕 |
|---|---|---|
| 模型控制 | 多数对照使用相同 base LM，coding/deep research 的方法 out-of-the-box，不训练。 | 不同 benchmark 使用 Qwen、Claude、GPT 等不同模型；模型强弱和工具调用习惯会直接影响 CLM。 |
| 方法说明 | ContextBench 给每种方法同等详尽度的 method-specific skill，尽量测“机制能力”而不是 prompt 缺失。 | skill 本身是性能的一部分；不同方法的操作接口复杂度仍不完全相同。 |
| 成本 | 用 prefix-reuse FLOPs、PFLOPs、USD、tokens 等指标。 | 这些指标不是同一个物理量；论文中的理论 FLOPs、仓库 server usage、真实端到端时间不能混报。 |
| 统计 | ContextBench 多 seed；EdgeBench 三 seed；steering 使用 paired bootstrap；skill evolution 用 dev gate，最后一次性 test。 | 数学优化部分每题一次长 run；部分 SCR 敏感性只在 64 个 BCP 问题上；外部复现仍需固定 commit、模型、server 和 prompt。 |
| 轨迹 | ATIF-CTX 保存每轮真实 input context 和 branch。 | 如果服务端没有 per-call token/cache usage，FLOPs 会降级为 tokenizer/message-level 估算；需要检查 `export_check.consistent`。 |

## 5. 方法对比表

| 方法 | 上下文控制者 | 操作空间 | 是否能原地编辑 live context | 外部文件 / memory | 标准 prefix-cache 后果 |
|---|---|---|---|---|---|
| Base / Mini-SWE-Agent | harness 不管理 | 只有普通工具 | 否 | 可以写文件，但不会自动从 live context 移除历史 | 历史持续增长，直到预算墙 |
| Codex-style Summary | harness 定时或到阈值触发 | 固定摘要流程 | 通常是整段替换，不是任意片段编辑 | 可以配合 offload | 每次整体摘要通常破坏较早 prefix，但上下文变短 |
| Self-Compact / AutoCompact | 模型决定何时触发 | 预定义 compact 工具/策略 | 受工具定义限制 | 取决于 harness | 编辑粒度和 cache 影响由预设操作决定 |
| ACM / Context-as-a-Tool / Sculptor | 模型调用预定义 context actions | compaction、offload、retrieve、fragment operation 等固定集合 | 部分支持 | 明确支持的机制较好 | 可以控制，但无法超出人类定义的 action space |
| RLM | 模型读外部长输入 / REPL 变量 | 递归读取、处理和检索 | **不直接编辑自身 live context** | REPL 持久 | 取回结果通常继续追加，live context 仍会增长 |
| **CLM** | **模型自身** | **普通代码接口，可定义新操作** | **是，任意可编辑文本范围（受 parser/前缀保护约束）** | **可使用普通文件作为 memory** | 编辑早期内容会让标准 cache 只复用共同 prefix，可能大量 re-prefill |
| **CLM + SCR** | 模型 + serving engine | 同上 | 同上 | 同上 | 对 surviving suffix 迁移 K/V，减少中间编辑的 re-prefill，但引入 stale-state 近似 |

## 6. 优点、缺点和限制清单

| 方面 | 优点 | 缺点 | 实际限制 / 风险 | 建议的验证方式 |
|---|---|---|---|---|
| 自适应性 | 任务相关地选择保留、摘要、删除、外置和重排，可能发现新策略。 | 策略不再是确定性的 harness 逻辑，行为有随机性和模型依赖。 | 同一任务可能一次压缩正确、一次误删；弱模型可能不编辑。 | 报告多 seed 的 accuracy、edit frequency、峰值 context 和失败样例。 |
| 信息保真 | 原地更新可避免每次重写完整状态；原文可留在外部文件精确检索。 | 自由文本摘要可能遗漏、幻觉或改变语义。 | ContextBench 之外的用户事实、权限、代码状态可能被错误压缩；“已外置”不等于可恢复。 | 对事实型、结构化状态和 tool result 做 exact-recall / round-trip 测试。 |
| 推理成本 | context 变短能减少 full-attention 和后续 prompt token；prefix reuse FLOPs 能量化收益。 | 每次编辑可能使 cache 前缀失配，短期成本反而更高。 | 频繁小编辑、编辑 context 开头、或重复复制全文可能比不编辑更贵。 | 画 accuracy–FLOPs Pareto，并按 edit position、edit size、cache hit 分解。 |
| serving | SCR 能重用 surviving suffix；无需改变 agent API。 | stale K/V 不是严格等价的重新 prefill。 | 多 span、混合 linear attention、显存不足、版本不匹配会 fallback；SGLang/vLLM 代码均有版本约束。 | 同时跑 standard/SCR，检查答案一致性、准确率、TTFT、throughput、显存和 fallback reason。 |
| 训练 | skill evolution 不动权重；RL 可内化上下文管理策略。 | evolution 和 RL 都需要大量 rollout；RL reward 稀疏。 | 训练 reward 可能鼓励不必要的编辑、依赖 judge 或过拟合 task template。 | 保留独立 test；把失败轨迹、编辑 token mask、成功集效率分开做 ablation。 |
| 工具与协议 | 一个 Bash 工具足够表达丰富操作；依赖普通 Unix/Python。 | 自由 shell 命令难以静态检查，输出和错误处理复杂。 | tool-call 结构在 parse-back 后可能丢失；超长 stdout 会被截断；命令失败仍消耗 turn。 | 测试 tool call / tool result、连续角色、空 block、非 ASCII、超长输出和命令中断。 |
| 安全 | sandbox、保护 system/task、trajectory 审计提供基础隔离。 | 模型能修改自己未来看到的历史，形成持久化指令通道。 | prompt injection、自生成指令、跨 agent 文件污染、敏感信息外置、越权读写。 | 给 message 标记不可伪造来源；实施路径白名单、只读 memory、审计 diff、人工批准高风险编辑。 |
| context awareness | harness readout 和 nudges 可以帮助模型估算剩余空间。 | 模型天然 token-length estimation 在长上下文可能很差。 | 论文 Appendix G 观察到 bucketed/低估现象；过度依赖外部 nudge 会削弱“native”性质。 | 记录 provider token count 与模型估计的 MAE；提供 `context_status` 或可靠计数 API。 |
| 评测外推 | 覆盖 research、coding、数学、单 repo、多 repo，且兼顾质量与成本。 | 结果高度依赖特定模型、server、task、skill、judge 和预算。 | 不能从 BCP 的相对提升直接推断所有长文档、客服、生产 agent 都提升。 | 用真实业务 replay、不同模型尺寸、不同 tokenizer、不同 server 做独立 benchmark。 |
| 工程运维 | `usage.json`、snapshots、ATIF-CTX、source fingerprint 便于诊断。 | 多份日志和 context branch 增加存储及分析复杂度。 | resume、rollback、side buffer、concurrent subtrajectory 需要一致性测试；许可证为 CC BY-NC 4.0。 | 固定 commit 与 config；验证断点恢复、重复运行、日志完整性和资源上限。 |

## 7. 适合落地的场景与不适合直接采用的场景

| 场景 | 适配度 | 落地建议 |
|---|---:|---|
| 长时程 deep research / 浏览检索 | 高 | 先启用 CLM，要求模型维护可验证的 progress note；外置原文，live context 只留索引和已验证事实；以 BCP 类 exact answer 和成本双指标验收。 |
| 终端 coding / repository 优化 | 高 | 让模型把已完成实验、score、未尝试候选和下一步写成结构化 ledger；保留源码和测试输出的可检索文件；不要把所有日志都摘要成不可验证的自然语言。 |
| 多 agent / agent swarm | 中高 | 每个 agent 独立 context 和文件权限；用 ATIF-CTX 记录 spawn/fold；定义冲突解决、共享状态 schema 和结果验真，不要只依赖自由文本 scoreboard。 |
| 需要精确 function calling / 结构化工具协议的对话 | 中 | 优先使用结构化 context edit API 或 message-level patch；避免直接用当前 `parse_back` 重建含 tool_calls 的历史，除非已经验证 chat template。 |
| 高安全、强合规、不可篡改审计 | 低（未经改造） | live history 必须保留不可篡改原始轨迹；模型只能提交 patch，不能直接覆盖；建立来源标签、审批、diff 签名和 prompt-injection 防护。 |
| 小模型、短任务、低上下文压力 | 低到中 | CLM 的决策开销可能抵消收益；先用固定 summary 或简单截断做基线，再用 ContextBench/真实 replay 判断是否值得引入。 |
| 生产级高并发 serving | 中 | 先用标准 prefix cache 建 baseline；SCR 只在支持的模型/engine/version 上灰度，限制 side buffer，监控 stale-state 一致性和 fallback。 |

## 8. 推荐的最小复现实验矩阵

| 实验组 | 固定项 | 变量 | 必须记录 |
|---|---|---|---|
| A：机制收益 | 同一模型、任务、工具、context window | Base、Summary、CLM | reward、成功率、峰值/平均 context、编辑次数、prompt/completion tokens。 |
| B：成本收益 | 同一 CLM 轨迹和 tokenizer | 无 cache、prefix cache、SCR | `P_t/R_t/G_t`、cache hit、re-prefill turns、PFLOPs、显存、TTFT、端到端时间。 |
| C：模型尺寸 | 同一 prompt/skill/config | 9B、27B、强 API model | 是否编辑、编辑质量、context-length MAE、accuracy–cost frontier。 |
| D：策略学习 | 固定 agent model/harness | 无 skill、人工 skill、evolved skill、RL checkpoint | train/dev/test 隔离、配对 SE、skill token 开销、失败轨迹、held-out reward。 |
| E：安全性 | 固定任务和工具 | 恶意 tool output、self-generated instruction、跨 agent 文件污染 | 是否进入后续 context、是否影响最终动作、原始轨迹与编辑后轨迹 diff。 |

## 9. 主要来源与源码索引

| 标识 | 内容 | 链接 |
|---|---|---|
| P | 论文正文、ContextBench、公式、结果、Discussion、Appendix | [arxiv.org/html/2609.37725](https://arxiv.org/html/2609.37725) |
| R | 官方仓库总览、zero-shot/ICL/RL 摘要、ContextBench 入口 | [`README.md`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/README.md) |
| H | `clm_harness` 工作流、配置、安装和 serving | [`clm/clm_harness/README.md`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_harness/README.md) |
| A | 主 agent loop、Bash、budget、snapshot、ATIF export | [`clm_agent/harness.py`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_harness/clm_agent/harness.py) |
| E | mirror sync、执行、read-back、edit gate、context readout | [`context_env/env.py`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_harness/context_env/env.py) |
| S | 可编辑文本格式、header parser、消息归一化 | [`context_utils/context_string.py`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_harness/context_utils/context_string.py) |
| B | token budget、nudge、rollback、output cap | [`utils/budget.py`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_harness/utils/budget.py) |
| F | prefix-reuse FLOPs、token source、attention geometry、compute cost | [`flops_metrics/kv_cache_flops.py`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_harness/flops_metrics/kv_cache_flops.py) |
| T | ATIF-CTX segments、branch、subtrajectory、trajectory export | [`agent_trajectory_format/`](https://github.com/facebookresearch/context-language-models/tree/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_harness/agent_trajectory_format) |
| I | skill evolution 的 proposer、dev gate、Pareto frontier | [`clm/clm_icl/`](https://github.com/facebookresearch/context-language-models/tree/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_icl) |
| L | dual-channel RL efficiency advantage | [`clm/clm_rl/README.md`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/clm/clm_rl/README.md) |
| Q | Suffix Cache Reuse 总览和 SGLang 实现 | [`suffix_cache_reuse/README.md`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/suffix_cache_reuse/README.md)、[`sglang/README.md`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/suffix_cache_reuse/sglang/README.md) |
| V | vLLM SCR scheduler/connector 设计、fallback 和限制 | [`vllm/DESIGN.md`](https://github.com/facebookresearch/context-language-models/blob/483198229ab7b90c0eed4651306ab3b3505aaf50/suffix_cache_reuse/vllm/DESIGN.md) |

## 10. 最终结论

1. **CLM 的关键创新是控制权转移**：让模型直接决定下一轮 context，而不是让 harness 用固定规则决定。
2. **Context-as-file 是低门槛实现，不是全部技术**：真正的系统难点在于预算、消息合法性、可重放轨迹、cache 失配和安全治理。
3. **论文结果支持“质量–成本 Pareto 改善”**，尤其是 BCP、EdgeBench 和 ContextBench；但收益高度依赖模型的上下文管理能力，9B 与 27B 的行为差异已说明这一点。
4. **SCR 是配套 serving 优化而非 CLM 定义的一部分**：它可以把中间编辑从“整段后缀重算”变成“迁移 surviving K/V + 重算新增 token”，但必须接受 stale-state 近似和严格的 engine/model 适配范围。
5. **生产采用应从受控的 message-level patch 开始**：保留不可变原始轨迹，限制可编辑字段和文件权限，记录每次 context diff，并用真实业务数据同时验证 exactness、成本、延迟和安全，而不能只复制论文中的准确率数字。
