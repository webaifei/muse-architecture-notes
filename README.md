# Muse 的创新不在 agent loop 里

Meta 的 Muse 是一个个人 AI agent。它跑在一个用户专属的云 VM 里，能读你的邮件、改你的日历、开浏览器、跑 shell 命令。

网上讲它的架构时，大多在讲它的模型多强、工具多全。

但官方那篇 20 分钟的安全博客里，第一句就否掉了这个方向：

> The right mental model is **two isolated security domains on one box**, not an LLM powered agent with root.

**Muse 真正值得研究的地方，不是它让模型能做什么，而是它怎么让模型做不到某些事。**

这个仓库把它拆成八步，每步一个可运行的 demo。

## 框架：一切都在回答同一个问题

**"如果 agent 被完全控制了，它能造成的最大破坏是什么？"**

Muse 的答案是：**尽可能小，而且每一步都有结构保证，不是靠检查。**

八步全部是这句话的推论：

| 步 | 建什么 | 结构保证是什么 |
|---|---|---|
| [一](ch01-两个信任域.md) | 两个信任域 | 内核强制隔离；控制面**没有**"发许可证"的接口 |
| [二](ch02-提议不是命令.md) | Action Proposal | 模型输出在边界被**重新构造**，原始对象不再存在于后续流程 |
| [三](ch03-Sentinel-授权不在对话里.md) | Sentinel 裁决 | 授权状态只存在 Sentinel 内存里，模型读不到也写不到 |
| [四](ch04-凭据代理.md) | 凭据代理 | cell 拿到的对象上**只有**申请代理令牌的方法 |
| [五](ch05-出口网关.md) | 出口网关 | 检查和连接用的是**同一个** IP |
| [六](ch06-privsep.md) | privsep | 决定所依赖的输入来自 cgroup，**不来自请求参数** |
| [七](ch07-tainted-egress.md) | tainted egress | 进程碰过什么由**内核**观察，进程无权选择不被观察 |
| [八](ch08-状态机.md) | 状态机 | 模型拿到的是只读 facade，**没有**能改状态的对象 |

**注意最后一列的措辞。** 每一行的保证都不是"我们检查了 X"，而是"**它没有那条路径**"。

这个区别贯穿全书：

| | 行为约束 | 结构约束 |
|---|---|---|
| 做法 | 写检查逻辑，发现越权就拒绝 | 那个能力根本不实现 |
| 被绕过的前提 | 找到检查的漏洞 | 找到不存在的代码 |
| 代码演进时 | 新增路径可能忘加检查 | 不可能"忘了加" |

**同一个模式在八个地方出现，说明它是这个架构的基本原则，不是局部技巧。**

## 怎么读

按顺序，每章配一个可运行文件：

```sh
node code/step1-trust-domains.mjs
```

**先跑，看输出，再读正文。** 每章的结构固定：

```
官方怎么说  →  依赖的技术与原理  →  demo 跑出来什么  →  这一章要记住的
```

每章末尾都会**明确标注**哪些是真实现、哪些是原理模拟。安全和隔离这东西，含糊其辞比不懂更危险。

| 章 | 代码 | 真实的 / 模拟的 |
|---|---|---|
| [一、两个信任域](ch01-两个信任域.md) | `step1` | ✅ 真 OS 级隔离（macOS Seatbelt）；Linux 上对应 systemd-nspawn + namespaces + seccomp + capabilities |
| [二、提议不是命令](ch02-提议不是命令.md) | `step2` | ✅ 全部真实逻辑 |
| [三、授权不在对话里](ch03-Sentinel-授权不在对话里.md) | `step3` | ✅ 全部真实逻辑 |
| [四、凭据代理](ch04-凭据代理.md) | `step4` | ✅ 全部真实逻辑 |
| [五、出口网关](ch05-出口网关.md) | `step5` | ✅ 真实 SSRF 检查与 DNS rebinding 防御（离线可跑） |
| [六、privsep](ch06-privsep.md) | `step6` | ⚠️ 逻辑真实；worker 身份用字符串模拟 cgroup |
| [七、tainted egress](ch07-tainted-egress.md) | `step7` | ⚠️ taint 逻辑真实；观察点是显式钩子，不是 eBPF |
| [八、状态机](ch08-状态机.md) | `step8` | ✅ 全部真实逻辑 |

## 前置：你已经会的东西

这个仓库**不教 agent loop**。turn / step / 重试 / 取消 / 工具调用这些，在另外两个仓库里已经写过了：

- [dsh-agent-loop-notes](https://github.com/webaifei/dsh-agent-loop-notes) —— DeepSeek Harness 的三层循环
- [codex-agent-loop-notes](https://github.com/webaifei/codex-agent-loop-notes) —— OpenAI Codex 的三层 loop

**Muse 的创新几乎都不在循环里面。** 那个循环你写过了，Hatch daemon 就是它。Muse 多出来的是**循环外面的控制面**：

```
        ┌──────── Host domain（控制面，agent 碰不到）────────┐
        │  Sentinel 裁决 │ authd 凭据 │ privsep 特权代码      │
        └───────────────────────┬────────────────────────────┘
              Unix socket + SO_PEERCRED（内核认证，无秘密可偷）
        ┌───────────────────────┴────────────────────────────┐
        │  Runtime cell（不可信）：Hatch harness / 工具 / 文件 │
        └────────────────────────────────────────────────────┘
```

**你已经有下半部分了。这个仓库是上半部分。**

## 网页版

[`index.html`](index.html) 是全部八章的单文件网页版——侧边导航、阅读进度、代码高亮。**完全自包含，离线可读**。

改完 Markdown 之后重新生成：

```sh
npm i -D marked shiki
node tools/build-page.mjs
```

## 来源与边界

架构描述全部来自官方一手材料：

- [How We Built Safety Into Muse](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)（Meta AI Research, 2026-09-08）—— 本仓库的主要依据
- [Introducing Muse](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)（产品公告）

**没公开的部分**：上下文组装算法、模型服务拓扑、客户端 token streaming 协议、内部调度器实现。本仓库不涉及这些，也不假装知道。

Muse 的核心理念值得单独引一次，因为它就是这个仓库存在的理由：

> Muse can and will still make mistakes, but we expect they'll be much less frequent and **cause much less damage** due to the safety systems we've built in.

**目标不是"绝不出错"，是"错了也没关系"。**

## 最后

读完这八步之后，再看任何一个 agent 系统，你会先问三个问题：

1. 它假设哪一部分会被攻破？
2. 攻破之后，什么东西是**结构上**拿不到的？
3. 哪些保证只是"我们检查了"？

第三个问题的答案越多，这个系统的安全性就越依赖它没写错。
