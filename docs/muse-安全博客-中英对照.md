# Meta Muse 安全架构：官方博客全文（中英对照）

原文：**How We Built Safety Into Muse**
来源：https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse
作者：Tarek Sheasha，Meta 软件工程师兼副总裁（Meta Superintelligence Labs）
日期：2026 年 9 月 8 日

译者说明：

- 每段先给中文，紧跟引用块里的英文原文，方便对照。
- 专有名词保留原文：Sentinel、privsep、hatch-authd、hatch-safety、Harness、Hatch、Skill。这些是 Meta 的内部代号，翻译反而会丢信息。
- 少数技术词第一次出现时标注原文。

---

今天，我们发布了 Muse —— 我们的个人助理。

> Today we launched Muse — our personal agent.

从 2026 年初开始，我们就在自己开发和使用 Muse。一开始用，我们就瞥见了真正的个人超级智能的影子：一个认识你、真的会动手做事、在后台干活、能放出成群的子代理、会给自己造工具、还会修改自己的代理。

> We've been working on and using Muse ourselves since early 2026. As soon as we started using it, we saw the glimmers of real personal superintelligence — an agent that knows you, actually does things, works in the background, launches swarms of subagents, builds its own tools, and edits itself.

那也是我们第一次把收件箱、日历和一个 shell 交给一个软件，让它无人看管地跑 —— 事情并不总是按计划发展。

> It was also the first time we'd handed our inboxes, our calendars, and a shell to a piece of software and let it run unattended — which didn't always work out as planned.

要让这项技术对所有人都可用，需要认真的设计和工程来让它更安全地运行。这个项目的大部分精力都花在了这里，本文详细说明我们的思路。

> Making this technology work for everyone requires careful design and engineering to operate more safely. That's where most of the effort on this project went and this post explains our approach in detail.

我们训练模型时，重点放在了对这类代理至关重要的几个方面：用 CLI 和 Skill 做零样本工具调用、长上下文、带提示注入意识的长轨迹指令遵循，以及多代理协同。

> We trained our model with a specific focus on the areas that are critical for an agent like this: zero-shot tool calling using CLIs and skills, long context, long-trajectory instruction following with inherent awareness of prompt injection, and multi-agent coordination.

无论核心模型多强，这样的代理仍然会犯错，也仍然会通过它读到的数据被攻击。

> No matter how strong the model is at the core, any agent like this will still make mistakes, and it will sometimes be attacked via the data it reads.

所以我们的设计前提是：假设代理可能正处于被攻击状态，并限制潜在损害 —— harness 跑在自己的隔离单元里，它看不到真实凭据，与外部世界的每一次交互都要经过一个 agent 无法覆盖的 Sentinel。

> So we designed the system to assume the agent may be under attack and limit the potential damage — the harness runs in its own isolated cell, it doesn't see real credentials, and every interaction with the outside world runs through a Sentinel which the agent can't override.

Muse 会犯错，这是确定无疑的。但因为内置的这些安全系统，我们预计错误会少得多，造成的损害也会小得多。

> Muse can and will still make mistakes, but we expect they'll be much less frequent and cause much less damage due to the safety systems we've built in.

我们在大量内部试用、代理式红队测试，以及私有漏洞赏金计划中安全研究员发现的真实对抗场景的基础上，对 Muse 做了加固。今天，我们把 Muse 漏洞赏金计划向所有人开放，欢迎负责任地披露问题。该计划对有效报告最高奖励 30 万美元，其中针对影响单个用户的成功提示注入攻击，最高奖励 13 万美元。

> We've hardened Muse based on extensive dogfooding, agentic red teaming, and against issues found in real adversarial scenarios by security researchers in our private bug bounty program. Today, we're opening the Muse bug bounty program to anyone to responsibly disclose issues. The program awards up to $300,000 for valid reports, including up to $130,000 for successful prompt injection attempts that affect one user.

通过详细说明 Muse 内部如何运作，我们希望让你对它在实践中可以信任到什么程度、以及信任多少，有一个判断。以下描述的是发布时的系统。当然，我们会继续关注不断变化的威胁态势，并按需做出调整。

> By going into detail about how Muse works under the hood, we hope to give you a sense of how — and how much — you can trust it in practice. The following describes the system at launch. We will, of course, continue to pay attention to the changing threat landscape and make changes as required.

---

## 全局图景

> ## The Lay of the Land

### 你自己云电脑里的代理

> ### An agent in your own cloud computer

你和你的 Muse 共用一台属于你们自己的云电脑。你的 Muse 就住在这里，你连接的任何服务的数据和凭据也都安全地存在这里。

> You and your Muse share your own dedicated computer in the cloud. This is where your Muse lives and where all data and credentials for any service you connect are securely stored.

每台虚拟机（VM）都是一个隔离的 Linux 盒子，带浏览器，有足够的存储、CPU 和内存来做真正的工作 —— 比如编译代理写的代码、开发自定义 Skill、处理并发的子代理和定时任务。

> Each Virtual Machine(VM) is an isolated linux box with a browser and enough storage, CPU, and memory to do real work — like compiling code the agent writes, developing custom skills and handling concurrent sub-agents and crons.

### 你的电脑，你的数据

> ### Your computer, your data

你的专属 VM 是你放进 Muse 的一切的权威记录（system of record）。如后文所述，在推理和遥测需要时，Muse 会把有限的数据送出 VM。

> Your dedicated VM is the system of record for everything you put in Muse. Muse sends limited data out of the VM when necessary for inference and telemetry as described below.

Muse 客户端（iOS、安卓 App 和网页版）通过安全传输层直连你的 VM。

> Muse clients (the iOS and Android apps, the web UI) connect directly to your VM via a secure transport layer.

当你把 Muse 连到邮箱，以及你的车、你的家这类系统时，它才最有用。我们为第三方系统以及 Instagram、Facebook 等其他 Meta 应用做了一批初始连接器。每做一个连接器，我们都和服务提供方紧密协作来接入他们的 API，并编写和迭代 SKILL —— 也就是给 Muse 的详细操作说明 —— 以便充分利用每个连接器。如果你关心的其他服务有自己的 API 或 CLI，Muse 也能为它们写自定义连接器。

> Muse is most useful when you connect it to your email and other systems like your car or your home. We've built an initial set of connectors to third-party systems and to other Meta apps like Instagram and Facebook. For each connector, we worked closely with the service provider to integrate their API, and we've written and iterated on SKILLs — detailed instructions to Muse — on how to get the most out of each connector. Muse can also write its own custom connectors for other services you care about if they have their own APIs or CLIs.

---

## Muse Secure VM

> ## Muse Secure VM

这台 VM 被精心组织，用 Linux 的各种隔离原语，把你和你的 Muse 所做的事，与我们为保护你而内置的一切分开。

> The VM is structured carefully to separate what you and your Muse do from everything we've built in to keep you safe using Linux isolation primitives.

正确的心智模型是"一台机器上的两个隔离安全域"，而不是"一个有 root 权限的 LLM"。

> The right mental model is two isolated security domains on one box, not an LLM powered agent with root.

Hatch 守护进程（核心的代理 harness）、装着你的工作区和文件的文件系统，以及 Muse 代你执行的所有二进制和工具，都跑在一个 `systemd-nspawn` 运行时容器里。运行时单元内的 root 被映射到宿主上的一个非特权用户，所以运行时单元的 root 不是宿主 root。

> The Hatch daemon (the core agentic harness) as well as the filesystem containing your workspace and files, and all the binaries and tools Muse executes on your behalf operate in a systemd-nspawn runtime container. Root inside the runtime cell is mapped to an unprivileged host user so runtime cell root is not host root.

这个单元有自己独立的根文件系统（包含一整套 Debian 镜像），与你存放其他敏感数据的宿主文件系统分开。它还有一个虚拟网卡、被过滤的系统调用（例如禁用 `io_uring`），以及受限的内核 capability（例如没有 `CAP_SYS_PTRACE`，也没有 `CAP_NET_ADMIN`）。

> The cell gets its own root filesystem (including a full debian image) separate from the host filesystem where your other more sensitive data lives. It also gets a virtual network interface, filtered system calls (for example no io_uring), and limited kernel capabilities (for example no CAP_SYS_PTRACE and no CAP_NET_ADMIN).

安全敏感的服务都在运行时单元之外。这个切分很重要，因为运行时单元预期会处理不可信数据。它们作为独立的 systemd unit 运行：

> Security-sensitive services exist outside the runtime cell. This split is important as the runtime cell is expected to process untrusted data. These run as separate systemd units:

- `hatch-safety` 运行一套独立的模型和分类器，检查进出核心模型推理的请求和响应。它们对控制前沿风险、识别提示注入等威胁很重要。把它们放在运行时单元之外，意味着攻击者无法关掉这些防护。

> - hatch-safety operates an independent set of models and classifiers which inspect requests and responses to/from core model inference. These are important for controlling frontier risk and to identify other threats such as prompt injection attempts. Running these outside of the runtime cell means that attackers cannot disable these protections.

- `privsep` worker 执行内置连接器代码，权限被严格收窄，让已连接的凭据处于代理的作用范围之外。

> - privsep workers execute built-in connector code with tightly scoped privileges, keeping the connected credentials out of scope of the agent.

- `hatch-authd` 负责凭据存储（包括你选择连接的第三方服务的 OAuth 令牌 —— 它们存在你的 VM 里，不在 Meta 的中心化基础设施里），以及凭据代理化（credential surrogation），让你主 agent 永远看不到敏感凭据。

> - hatch-authd is responsible for credential storage (including OAuth tokens for third-party services you choose to connect – these are stored in your VM, not in centralized Meta infrastructure) and for credential surrogation so your main agent never sees sensitive credentials.

- Sentinel 是连接器动作和网络出口的唯一权限权威。

> - Sentinel is the sole permission authority for connector actions and network egress.

- 所有持久应用状态都存在一个 Postgres 数据库里，与运行时单元、与凭据存储都分开。

> - All durable application state is stored in a postgres database separate from the runtime cell and from the credential store.

- 推理和遥测的代理，提供通往外部基础设施的受限路径。

> - Proxies for inference and telemetry expose constrained paths to external infrastructure.

运行时单元和 VM 内其他服务之间的全部通信，都通过带 `SO_PEERCRED` 和 peer ACL 的 Unix domain socket 完成。这提供了经内核认证的、最小权限的进程间通信，没有可偷的秘密。

> All communication between the runtime cell and other services in the VM happens via Unix domain sockets with SO_PEERCRED and peer ACLs. This provides kernel authenticated, least-privilege interprocess communication with no secrets to steal.

---

## 内置的 Sentinel

> ## A Built-In Sentinel

Sentinel 是一个与你的 Muse 分开的、宿主侧（host-side）的 agent。它是"用连接器对第三方服务执行动作"以及"所有网络出口"的唯一权限权威。Muse 提出动作，但只有 Sentinel 能授予执行动作的许可。

> Sentinel is a separate host-side agent from your Muse. It is the sole permission authority for approval to perform actions with connectors to third-party services and for all egress over the network. Muse proposes actions, but only Sentinel can grant permission to perform action.

当 Muse 想通过连接器采取动作时，相应的连接器工具会在运行时单元里被调用。它向 Sentinel 提交一个请求，描述连接器、要调用的方法、动作类别、作用范围，以及用户原始请求的上下文 —— Sentinel 据此生成一个用户可见的用途说明（purpose）。Sentinel 评估由用户设定的连接器策略，决定这个动作应该被允许、被拒绝，还是询问用户。

> When Muse wants to take action via a connector, the relevant connector tool is invoked in the runtime cell. That submits a request to Sentinel describing the connector, which method is to be invoked, the class of action, its scope, and context of what the user asked for from which Sentinel generates a user-visible purpose for the request. Sentinel evaluates the connector policy, which has been set by the user, and decides whether the action should be allowed, denied, or to ask the user.

### 网络出口

> ### Network egress

每一个具体的网络请求，都由 Sentinel 在出口处管辖。运行时流量通过一个用 Linux 网络控制（用户命名空间、veth 边界和 eBPF 过滤）配置的转发代理到达 Sentinel。Sentinel 能在第 4 层和第 7 层两个层面评估目标：主机名、解析后与最终的 IP 地址、端口、协议、HTTP 方法、路径，以及解码后的实际请求。SSRF 限制会阻止"看起来是公网主机名、DNS 查询后却解析到内网基础设施"的情况。

> Every concrete network request is governed by Sentinel at egress. Runtime traffic reaches Sentinel via a forward proxy configured with Linux networking controls (userns, veth boundaries and eBPF filtering). Sentinel can evaluate the destination at both layer 4 and layer 7: the hostname, the resolved and final destination IP address, the port, protocol, HTTP method, path, and the actual decoded request. SSRF restrictions prevent an apparently public hostname resolving private infrastructure after DNS lookup.

Sentinel 还会为任何需要密钥或认证令牌的请求，做即时的凭据注入。对所有这些请求，运行时单元或 worker 里的代码只能看到一个由 authd 铸造的"代理"（surrogate）令牌。具体的网络请求被授权之后，Sentinel 会在网络边界上把代理令牌替换成从 authd 取来的真实凭据。

> Sentinel also performs just-in-time credential insertion for any requests which need a secret or auth token. For all such requests, code in the runtime cell or a worker only ever sees a "surrogate" token, minted by authd. After the concrete network request is authorized, Sentinel will replace any surrogate tokens with the real credential, obtained from authd, at the network boundary.

agent 永远看不到真实令牌，这意味着任何通过提示注入或其他方式胁迫 agent 泄露真实密钥的尝试都是徒劳的。

> The agent never sees real tokens, which means any attempt to coerce the agent to reveal the actual secrets via prompt-injection or otherwise is futile.

为了平衡用户审批的信噪比，Muse 使用了内核级的数据流跟踪，我们称之为"污染出网"（tainted egress）。每个工具执行进程都从干净（clean）状态开始，一旦读取用户数据就变成被污染（tainted）状态。

> To balance the signal-to-noise ratio of user approvals, Muse uses kernel-level data flow tracking, which we call "tainted egress." Each tool execution process starts in a clean state and becomes tainted if it reads user data.

那些已经符合"窄范围自动放行"策略、并且通过其他出站 URL 检查的干净网络请求，可以不经用户打扰直接放行。污染信息被用来决定对请求采取何种合适的用户审批。被污染或无法验证的进程会失去自动放行资格，退回到常规审批流程。

> Clean network requests that already qualify for a narrowly bounded auto allow policy — and which also pass other checks on the outbound URL — can be allowed through without bothering the user. Taint information is used to determine suitable user approval for requests. Tainted or unverifiable processes lose auto-allow and fall back to the normal approval flow.

实现上，它使用 eBPF cgroup 程序做网络拦截和进程归因，再加上我们为传播污染而挂到 Linux Security Module 钩子上的 eBPF 程序。

> The implementation uses eBPF cgroup programs for network interception and process attribution, plus eBPF programs attached to Linux Security Module hooks we added for taint propagation.

---

## 人在环路中

> ## Human in the Loop

当 Sentinel 的决定是询问用户时，它会创建一个待审批（pending approval），执行随即停止。Sentinel 把这个请求直接发给 Muse 客户端，描述要审批的确切动作。一个对话框会直接呈现在客户端的界面里 —— 不是通过用户与 Muse 的对话 —— 用户的答复也直接回传给 Sentinel，由它按用户的决定行动。Sentinel 随后更新自己的权威审批状态，并相应地放行或拒绝该操作。

> When Sentinel's decision resolves to ask the user, Sentinel creates a pending approval and execution stops. Sentinel sends that request directly to the Muse client, describing the exact action to be approved. A dialog is presented to the user directly within the client UI — not via their conversation with Muse — and their answer is routed directly back to Sentinel, which acts on the user's decision. Sentinel then updates its authoritative approval state and allows the operation to proceed or rejects it as appropriate.

通过人在环路系统授予的审批，是严格的能力凭证（capability），不是对话式的建议。它们绑定到特定的连接器／目的地和用途。Muse 支持获取一次性、会话级、任务级、限时或永久的权限。Sentinel 决定提供哪些授权类型供用户选择，并确保后续的调用与授权范围精确匹配。

> Approvals granted via the human in the loop system are strict capabilities, not conversational suggestions. They're bound to the particular connector/destination and use case. Muse has support for obtaining one-time, session-scoped, task-scoped, time-bounded, or perpetual permission. Sentinel decides which grant types to present for the user to choose between and ensures that subsequent invocations match the granted scope exactly.

重点不是什么都问用户。只读的、之前已允许的、或明显低风险的动作可以畅通无阻。目标是在真正需要同意的地方制造摩擦，同时让日常操作自由流动。随着我们对真实用户积累更多经验，这个平衡会持续调整。

> The point is not to ask the user about everything. Read-only, previously allowed, or demonstrably low-risk actions can proceed without interruption. The goal is to put friction where consent matters while keeping routine operations flowing freely. This balance is something we expect to tune over time as we have more experience with real users.

---

## 最小权限

> ## Least Privilege

永远不把 API 密钥展示给模型，是我們应用最小权限原则的一个例子。模型不需要看到 API 密钥 —— 所以它看不到 —— 这意味着它也就无法通过别的途径意外泄露它们。

> Never showing API keys to the model is an example of how we apply the principle of least privilege. The model doesn't need to see the API keys — so it doesn't — which means it can't accidentally leak them through some other vector.

Muse 在尽可能多的地方应用这个原则。例如：

> Muse applies this principle wherever possible. For example:

很多服务都支持读和写两类操作。用户往往更愿意给代理读取数据的权限（比如"读我的日历，把冲突标出来给我"），而在授予写权限之前，倾向于先花时间了解系统实际运作得有多好（比如"帮我安排新会议"）。在底层服务支持的地方，Muse 会把读和写的权限分开。

> A lot of services support read and write operations. Users tend to be more comfortable giving their agent read access to their data (e.g., "read my calendar to flag conflicts to me"), and prefer to take time to understand how well the system works in practice before giving write access (e.g., "schedule new meetings for me"). Where the underlying service supports it, Muse separates out read and write access.

Muse 还提供了细粒度的控制，能精确规定代理可以代你执行哪些动作，而不只是通常作为 OAuth scope 暴露出来的粗粒度分组。（例如，如果你在 Gmail 一侧授予 Muse 读取权限的 OAuth scope，你可以去掉通常随之而来的访问 Gmail 设置的能力。）系统在连接器、进程、凭据和请求四个层级上，都增加了更细的控制器。

> Muse also provides fine-grained control over exactly which actions the agent can take on behalf of the user beyond the coarse groups that are usually exposed as OAuth scopes. (For example, if you grant Muse the Gmail read-access OAuth scope on the Gmail side, you can remove the ability to access Gmail settings that usually comes along with it). The system adds finer-grained controls at the connector, process, credential, and request levels.

对 Muse 这类代理来说，一种常见做法是为第三方服务提供基于 CLI 的连接器，让它们跑在 harness 相同的环境里。这里有个风险：代理可能被提示注入胁迫，去改动工具代码，利用那些 CLI 能访问的服务凭据做坏事。

> A standard approach for agents like Muse is to have CLI-based connectors for third-party services which run in the same environment as the harness. A risk is that the agent could be coerced to change the tool code via prompt injection to do something nefarious with the service credentials those CLIs have access to.

Muse 通过把内置连接器的逻辑放到运行时单元之外、并用 privsep 收窄凭据访问，实现了更高程度的保护。

> Muse achieves a greater degree of protection by running the logic for built-in connectors outside the runtime cell and with tightly scoped credential access using privsep.

内置连接器有各自的 CLI，跑在运行时单元里。这些 CLI 只做三件事：解析自己的参数、打开调用者本来就有权访问的文件，然后通过 Unix socket 把类型化的参数和文件描述符传出去。真正的业务逻辑，由 systemd 沙箱化的 worker 执行。

> Built-in connectors have CLIs which run in the runtime cell which simply parse their arguments, open any files the caller is already allowed to access, and pass typed arguments and file descriptors over a Unix socket. A systemd sandboxed worker then executes the business logic of the tool.

每个 worker 由它的 cgroup 标识，并持有显式的凭据白名单。日历 worker 不可能只靠改一个请求参数，就向 authd 索要邮箱凭据。

> Each worker is identified by its cgroup and has explicit credential allowlists. A calendar worker cannot ask authd for an email credential simply by changing a request parameter.

- privsep 决定哪段代码能处理凭据。

> - Privsep decides where credential capable code executes

- authd 决定已认证的调用者能收到哪类凭据材料。

> - Authd decides which credential material the authenticated caller can receive

- Sentinel 决定所请求的动作是否可以被执行。

> - Sentinel decides whether the requested action may be taken

浏览器遵循类似的模式。CDP（Chrome DevTools 协议）访问在一个位于运行时单元之外的 broker 里，浏览器 agent 通过一个窄的、受控的接口使用它。

> The browser follows a similar pattern. CDP access is in a broker outside the runtime cell and the browser agent gets a narrow, controlled interface to it.

对内置连接器，考虑到这些服务在你的生活中嵌入得有多深，我们还仔细思考了如何让 Muse 更安全地访问它们。想想你的主邮箱：你大概会在里面收到很多一次性验证码。而你的邮箱账户多半也能用来重置你在网上其他大多数账号的密码，只要点"忘记密码"链接。把邮箱连到 Muse，不应该允许 agent，或某个胁迫 agent 的人，在所有其他站点上代表你。

> For built-in connectors, we also thought carefully about how to give Muse safer access given how deeply these services fit into your life. Think about your primary email inbox: You probably receive a lot of one-time token passcodes there. And your email account can likely be used to reset your passwords across most other accounts you use on the web by clicking on "forgot password" links. Connecting your email to Muse should not allow the agent or someone else coercing the agent to represent you across other sites.

所以 Muse 的邮箱连接器会过滤掉一次性验证码、密码重置链接和登录用的魔术链接，手段既有确定性过滤器，也有一个分类器模型。

> So Muse's email connector filters out one-time tokens, password reset links, and login magic links via both deterministic filters and a classifier model.

---

## 纵深防御

> ## Defense in Depth

像任何 AI 系统一样，Muse 有时会犯错。它也必须在对抗性环境中行动。我们应用纵深防御（defense in depth）的概念，来限制技术栈任何一层的出问题所造成的影响。我们用来降低提示注入危害风险的做法，就是一个好例子。

> Like any AI system, Muse will sometimes make mistakes. It also needs to act in adversarial environments. We apply the concept of defense in depth to limit the impact of problems at any one layer of the stack. The approach we've taken to reduce the risk of harm via prompt injection is a good example.

Simon Willison 在 2025 年 6 月创造了"致命三要素"（the lethal trifecta）这个说法，用来描述提示注入的前置条件。这个问题一直是我们念念不忘的。

> Simon Willison coined the term "the lethal trifecta" to describe the pre-conditions for prompt injection back in June 2025, and this problem has been an obsession for us.

> 能力上的致命三要素是：**能访问你的私有数据** —— 这本来就是工具最常见的用途之一！**暴露于不可信内容** —— 任何让恶意攻击者控制的文本（或图像）进入你的 LLM 的机制。**能对外通信**，且这种方式可用于窃取你的数据。（我常把这叫作"外泄"……）如果你的代理同时具备这三个特征，攻击者就能轻易诱使它访问你的私有数据，并把数据发给攻击者。 —— Simon Willison

> The lethal trifecta of capabilities is: Access to your private data — one of the most common purposes of tools in the first place! Exposure to untrusted content — any mechanism by which text (or images) controlled by a malicious attacker could become available to your LLM. The ability to externally communicate in a way that could be used to steal your data. (I often call this "exfiltration" …). If your agent combines these three features, an attacker can easily trick it into accessing your private data and sending it to that attacker. – Simon Willison

我们采取纵深防御的做法，来防止提示注入造成危害：

> We take a defense-in-depth approach to preventing harm from prompt injection:

- **模型层训练** —— 我们的模型被训练来识别和抵抗提示注入。我们开发了一套严格的评测集，让我们能长期跟踪模型层在这个指标上的表现。Muse Spark 1.3 在这项能力上已接近最先进水平（SOTA）。

> - Model level training — our model is trained to recognize and resist prompt injection. We've developed a rigorous set of evals that allow us to track our performance at the model level on this metric over time. Muse Spark 1.3 is close to SOTA on this capability.

- **harness 层防护** —— 当数据从任何外部来源进入模型上下文时，它会被标记为不可信输入。这一点，加上模型更强地遵循开发者指令的能力，意味着在面对潜在有害数据时，模型判断该遵循哪些指令、忽略哪些指令的核心能力被放大了。

> - Harness level protections — When data enters the model's context from any external source, it's labeled as untrusted input. This, together with the model capability to follow developer instructions more strongly, means that the core capability of the model to understand which instructions to follow and which to ignore is amplified in the presence of potentially harmful data.

- **一整套提示注入检测分类器**，它们被训练来检出真实数据集里发现的提示注入尝试，也用于我们对所有经文件和工具调用进入模型上下文的外部数据所做的大规模代理式红队测试。这些分类器彼此并行运行，一旦发现操纵 agent 行为的企图，就能采取坚决的行动。由于这套系统是独立于模型训练的，我们能让系统整体的准确率高得多。

> - An ensemble of multiple prompt injection detection classifiers which have been trained to detect prompt injection attempts found in real-life data sets, as well as our own scaled agentic red-teaming run on all external data entering model context via files and tool calls. These run in parallel with each other and enable firm action to be taken when attempts to manipulate agent action are found. By training this system independently from the model, we can achieve a significantly higher accuracy for the system overall.

- **人在环路审批**，针对把数据移出 VM 的动作，如前所述。

> - Human in the loop approvals for actions that move data out of the VM as described above

在 agent 之下，我们同样有纵深防御：即使 Muse 被说服去做坏事，确定性的边界依然生效。运行时单元限制系统访问，privsep 限制哪段代码能看到哪些凭据，authd 施加 ACL，Sentinel 评估每一个动作和所有网络出口。

> Beneath the agent, we have defense in depth too: deterministic boundaries apply even if Muse is persuaded to behave badly. The runtime cell limits system access, privsep restricts which code can see which credentials, authd applies ACLs, and Sentinel evaluates every action and all network egress.

Muse 有一个真实的、保持更新的、基于 Chromium 的浏览器，跑在一个虚拟化层之后。用户可以看到 Muse 在浏览器里做什么，并随时接管。

> Muse has a real up-to-date Chromium based browser running behind a virtualization layer. Users can see what Muse is doing in the browser and take over at any time.

通过模型在网上观察到的数据（无论是文本还是图像）对它进行提示注入／操纵，是另一个重要的攻击渠道，我们在上面提到的措施之外，还应用了额外的防护。

> Prompt injection/steering of the model via data it observes on the web whether in text or images is another important attack vector where we apply additional protections above and beyond those mentioned above.

- 用户最常见的需求之一，是在浏览器里登录网站。与 Muse 处理 API 令牌的方式类似，但我们用一个不同的自定义界面，它和密码管理器集成得更好：我们在客户端呈现一个自定义界面来采集你的用户名和密码，直接把它们送到 authd，并存进运行时单元之外的、Muse VM 里的安全凭据库。你输入的内容直接进入安全存储，主 agent 看不到，但会在需要的时候被注入到浏览器窗口里。

> - One of the most common things users want is to sign in to websites in the browser. Similar to how Muse handles API tokens, but with a different custom UI which integrates better with password managers, we present a custom UI on the client to capture your username and password, route them directly to authd, and store them in the secure credentials store outside the runtime cell in the Muse VM. What you enter goes straight to secure storage and is not visible to your main agent, but gets injected into the browser window at the point of need.

- 驱动网页浏览器去达成用户的目标，正是 Muse Spark 1.3 模型特别擅长的事。Muse 用一个专门的浏览器子代理来完成每个任务 —— 读页面、遍历站点、填表单等等。这个子代理有类似的、针对网页的指令，说明内容的哪些部分可能是对抗性的。

> - Driving the web browser to achieve the user's goal is something the Muse Spark 1.3 model is particularly good at. Muse uses a special browser sub-agent to complete each task — reading the pages, traversing the site, filling forms, etc. This sub-agent has similar, web specific instructions about which parts of the content may be adversarial.

- 浏览器由一个独立的 broker 管理，它负责维护 Chrome DevTools 协议的连接。驱动浏览器的子代理看到的，是页面的无障碍树（accessibility tree）快照 —— 不是原始 DOM。（这也意味着它读不到从凭据库填入的内容，也无法手动把 DOM 回退出来。）它没有能力在页面上下文中执行 JavaScript，没有 script 动词，不能在浏览器进程中执行，Chrome DevTools 也被禁用。当用户接管浏览器控制权时，或者安全凭据存储在填表时，agent 会被暂停，完全不能行动。

> - The browser is managed by a separate broker that manages the Chrome DevTools Protocol connection. The sub-agent, which drives the Browser, sees an accessibility tree snapshot of the page — not the raw DOM. (This also means it can't read credentials entered from the credential store, or manually back out of the DOM.) It has no ability to run javascript in the page context, no script verbs, no exec in the browser process, and Chrome devtools are disabled. When the user takes over control of the browser, or while secure credential storage is filling a form, the agent is paused and can't act at all.

- 此外，我们实现了一系列分类器，为 Muse 操作浏览器时提供又一个独立的防护层。根据检测到的威胁，它们要么阻断动作，要么提示用户复核即将发生的事。它们关注的是：通过浏览器外泄与当前任务无关的个人数据；网页 DOM 中存在的提示注入企图；网页图像／媒体中存在的提示注入企图；通过浏览器下载的文件中存在的提示注入企图；以及高风险表单的提交企图。

> - Additionally, we've implemented a family of classifiers that provide another independent layer of protection when Muse is working with the browser, depending on the threat detected they either block the action or prompt the user to review what is about to happen. These look out for: Egress of personal data not related to the task at hand via the browser. Presence of attempted prompt injection within the DOM of the web page. Presence of attempted prompt injection via images/media on the web page. Presence of attempted prompt injection via files downloaded via the browser. Attempted submission of high risk forms.

- 最后，Meta 已有一些系统，能检测并封堵用户可能通过我们系列应用中的帖子或广告被引导过去的恶意网站。我们能够在用户的 VM 内匹配那份列表，阻止浏览器导航到已知的有害站点。

> - Finally, Meta has existing systems that detect and block malicious websites that users might be directed to via posts across our family of apps or ads. We are able to match against that list inside the user's VM and stop the browser navigating to known harmful sites.

---

## 漏洞赏金

> ## Bug Bounties

我们通过持续的代理式红队测试来获得对系统的信心，这也帮助我们汇集了一套非常难的评测集，可用于离线评估我们的防护。此外，我们全年都在通过漏洞赏金计划与外部安全研究员合作。今天，我们把这个计划向所有负责任地披露问题的人开放。该计划对有效报告最高奖励 30 万美元，依据是所展示的影响，其中也包括成功的提示注入尝试。

> We gain confidence in the system by continuous agentic red teaming, which has also helped us assemble a very difficult set of evals we can use for offline assessment of our protections. In addition, we've worked with external security researchers via a bug bounty program throughout the year. Today, we're opening this bug bounty program to anyone who responsibly discloses issues. The program awards up to $300,000 for valid reports, based on demonstrated impact, including successful prompt injection attempts.

---

## 即将推出：Muse Confidential VM

> ## Coming Soon: Muse Confidential VM

我们打造 Muse 的目标，是让它默认就成为你个人信息的谨慎管家，把透明和控制内建到日常体验里。今天的 Muse 架构把每个用户的数据彼此隔离并保持安全。它通过运营政策，限制 Meta 人员访问你的数据。它并不阻止 Meta 在需要支持、保护或运营这项服务时访问数据。

> We've built Muse with the aim of making it a careful steward of your personal information by default, with transparency and control built into the everyday experience. Today's Muse architecture isolates each user's data from each other and keeps it secure. It restricts access to your data by Meta personnel through operational policies. It does not prevent Meta from accessing data when necessary to support, secure or operate the service.

我们认为，人们也应该能够为个人代理选择一个完全私密的模式，在这种模式下，连 Meta 或任何其他服务提供方都无法查看或授予访问你信息的权限。

> We believe people should also be able to choose a fully private mode for personal agents where even Meta or any other service provider cannot see or grant access to your information.

这就是为什么我们在 Muse Confidential VM 上投入巨大，并计划在今年晚些时候交付这项能力。Muse Confidential VM 的目标，是在密码学上可验证地阻止 Meta 访问你 VM 中的数据。

> That's why we're investing significantly in Muse Confidential VM, and plan to deliver this capability later this year. Muse Confidential VM is intended to cryptographically and verifiably prevent Meta from accessing data in your VM.

我们已经在和一小群受信任的测试者使用这套系统，并已开始把它的设计和源代码提供给外部审计方。我们正在收集审计方的反馈，一旦发布，就会有一套持续的审计，任何人都能看到并检查。专家将能够确认，Meta 没有能力访问机密 VM 环境中的数据。我们也欢迎安全和隐私专家联系我们，了解这个版本产品的早期访问。他们的参与和审视会让它更强。（可以通过 muse-security@meta.com 联系我们。）

> We're already using this system with a small group of trusted testers, and we've begun making our design and the source code for this system available to external auditors. We're in the process of taking auditor feedback, and once launched, will have a continuous audit of the system that will be visible to and inspectable by anyone. Experts will be able to confirm that Meta does not have the ability to access data within the confidential VM environment. We also welcome security and privacy experts to reach out about early access to this version of the product. Their partnership and scrutiny will make this stronger. (You can reach us at muse-security@meta.com.)

---

## 我们的数据政策

> ## Our Policy Around Data

我们知道，把你最敏感的数据连到 Muse，是一种信任行为。我们设计 Muse 时就考虑到了这一点。你放进 VM 的所有文件，以及 Muse 代你生成或使用的一切，都存在那里。你可以自由地查看、编辑和下载这些文件，包括 Muse 关于你的记忆。

> We know connecting your most sensitive data to Muse is an act of trust. We designed Muse with that in mind. All the files you put in your VM and everything Muse generates or uses on your behalf is stored there. You can inspect, edit and download these files freely, including Muse's memory about you.

这也包括你连接的任何第三方服务的凭据和认证令牌 —— 它们存在你 VM 里一个独立的隔离容器中，不在其他 Meta 服务里。你的 VM 数据会被持续备份，出问题时可以恢复。

> This extends to credentials and auth tokens for any third-party services you connect — they're stored in a separate isolated container in your VM, not in other Meta services. Your VM data is backed up continuously so you can restore it if something goes wrong.

Muse 不会把你的对话或 VM 中的数据分享给 Meta 广告系统。话虽如此，在某些正当场景下，你使用 Muse 的方式会影响你看到的广告。当 Muse 浏览互联网时，它会以你的活动身份出现；所以如果你让 Muse 去某个服装设计师的网站买一件衬衫，那位设计师可能就会利用你的这次访问，在 Instagram 上给你展示广告。类似地，如果 Muse 帮你订了餐厅，或者帮你在 Facebook Marketplace 上找到了一件好商品，那也可能间接影响你看到的广告。

> Muse doesn't share your conversations or the data in your Virtual Machine with Meta ad systems. That said, there are some legitimate scenarios where how you use Muse can influence the ads you see. When Muse browses the internet, it will appear as your activity, so if you ask Muse to buy a shirt from a clothing designer's website, that designer might use your visit to show you an ad on Instagram. Similarly, if Muse makes a restaurant reservation for you or helps you find a great product on Facebook Marketplace, that may also indirectly influence the ads you see.

推理数据 —— 你和你的 Muse 之间的往复对话，以及由此产生的工具调用和子代理交接（也就是"轨迹"） —— 是训练核心 LLM 模型新检查点的有用数据。为了保护用户隐私，这些轨迹在用于训练之前会被清洗，去掉关键的个人身份信息。

> Inference data, the back and forth conversations between you and your Muse and the tool calls and subagent handoffs that result ("trajectories") are useful data for training new checkpoints of the LLM model at the core. To preserve user privacy, these trajectories are sanitized to remove key personally identifiable information before being used in training.

我们认为这是个好的默认值 —— 当我们集体使用这个产品、帮助模型理解人类生活的复杂性时，每个 Muse 用户都会得到一个更好的个人代理。如果你完全不想让自己的数据被用于模型训练，可以在 Muse 设置里通过一个简单的开关退出。

> We think this is a good default — every Muse user gets a better personal agent as we all collectively use the product and help the model understand the intricacies of human life. If you do not want your data to be used in model training at all, you can opt-out via a simple switch in Muse settings.

Muse 并非对攻击免疫。提示注入在整个行业仍是一个未解问题 —— Muse 有时会犯错。我们把系统设计成：出错时限制影响范围，帮助用户保持掌控，又不会不堪重负。

> Muse isn't immune to attack. Prompt injection remains an open problem in the industry — and Muse will sometimes make mistakes. We've designed the system to bound the impact when things go wrong and help the user stay in control without being overwhelmed.

有两件事对我们帮助最大。如果你是安全研究员，或者就是喜欢试着搞破坏，漏洞赏金计划今天已经开放。我们会为成功的提示注入攻击付赏金 —— 不是因为我们觉得找到它们不可能，而是因为这一安全最佳实践能以最快的速度帮我们改进 Muse 在真实世界中的行为。如果你是隐私专家，愿意帮我们把 Muse Confidential VM 做好，请联系我们 —— 我们希望在把它推向市场的过程中，与一小批专家紧密合作，请他们提供建议并审查我们的工作。

> Two things would help us most. If you're a security researcher, or just like trying to break things, the bug bounty program is open today. We'll pay bounties for successful prompt injection attacks — not because we think finding them is impossible, but because this security best practice will help us improve Muse's real-world behavior at the fastest clip. If you're a privacy expert, and you'd like to help us make Muse Confidential VM great, reach out — we'd like to work closely with a handful of experts to advise and review our work as we bring this to market.

---

## 脚注

> ## Footnotes

Hatch 是 Muse 在代码库里的内部名称。

> Hatch is our internal name for Muse in the codebase.
