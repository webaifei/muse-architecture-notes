# 一、两个信任域

> **代码**：`code/step1-trust-domains.mjs`  
> **官方来源**：[How We Built Safety Into Muse](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)（Meta AI Research, 2026-09-08）

## 我原以为 agent 的安全就是"让模型别乱来"

写一段更严格的 system prompt，加一个输出过滤器，再给工具加个权限检查——这是我以前对 agent 安全的理解。

这套东西有个共同点：**它们都在 agent 的进程里。**

模型被提示注入说服了，它会做什么？它会尝试绕过你的检查。而只要那些检查跑在同一个进程里、同一份内存里，绕过就只是时间问题——它可以直接改掉那个变量，或者找到一条你没检查的调用路径。

Muse 的答案是不在这个层面玩。

## 官方怎么说

> The right mental model is **two isolated security domains on one box**, not an LLM powered agent with root.

一台机器，两个域：

| | 里面放什么 | 信任级别 |
|---|---|---|
| **Runtime cell** | Hatch daemon（核心 harness）、workspace、文件、所有二进制和工具 | **不可信**——预期会处理攻击者控制的数据 |
| **Host domain** | `hatch-safety`、`privsep`、`hatch-authd`、**Sentinel**、Postgres、推理代理 | 可信 |

还有一句关键的话：

> This split is important as the runtime cell is **expected to process untrusted data**.

不是"如果被攻破怎么办"，而是**假设它会被攻破**。

下面拆开讲它靠什么技术做到。

---

## 技术 1：user namespace —— 让容器里的 root 不是真的 root

**官方原文**：

> Root inside the runtime cell is mapped to an unprivileged host user so runtime cell root is not host root.

**原理**：Linux 从 3.8 开始支持 **user namespace**，允许非特权用户创建一个新的用户命名空间。namespace 里维护一张 **uid 映射表**（`/proc/<pid>/uid_map`）：

```
namespace 内    宿主上
   0      →      100000
   1      →      100001
   ...
```

进程在 namespace 内看自己是 uid 0，但**内核在检查权限时用的是宿主上那个 uid**（100000）。于是：

- namespace 内可以"以 root 身份"做很多管理操作（装包、改文件属主）
- 但那些操作的真正权限检查，落在宿主上一个普通用户身上 → 拒绝

**这就是"容器里的 root 不是宿主 root"的实现方式**，不需要任何特殊硬件，靠的是内核在映射表上做了一次翻译。

**为什么重要**：容器逃逸的经典路径是"在容器里当 root，利用某个内核漏洞拿到宿主 root"。有了 user namespace，即使拿到容器内 root，宿主的 uid 依然是 100000。

---

## 技术 2：seccomp —— 把不需要的系统调用整个关掉

**官方原文**：

> It also gets ... **filtered system calls (for example no `io_uring`)**.

**原理**：**seccomp**（secure computing mode）允许一个进程加载一段 cBPF 程序。内核在**每个系统调用的入口**执行这段程序，根据返回值决定：

| 返回值 | 效果 |
|---|---|
| `SECCOMP_RET_ALLOW` | 放行 |
| `SECCOMP_RET_ERRNO` | 返回错误码，就像 syscall 不存在 |
| `SECCOMP_RET_KILL_PROCESS` | 直接杀掉进程 |
| `SECCOMP_RET_TRAP` | 给进程发 SIGSYS |

两个性质很关键：

1. **只能收窄，不能放宽。** 一旦设了 `no_new_privs`，过滤器就不能撤销，也不能加白名单。
2. **在内核里执行。** 被过滤的进程没有任何办法绕过——它连发起那个 syscall 都做不到。

**为什么专门点名 `io_uring`？**

`io_uring` 是一套高性能异步 I/O 接口。它和传统 syscall 的区别是：提交操作不需要每次陷入内核，而是写进一块**共享内存环形缓冲区**，内核在后台消费。

这带来了两个问题：

- **很多操作不经过常规 syscall 路径**，所以传统的 syscall 级别的检查（包括 seccomp 过滤器）看不到它们
- 它本身的历史上出过多次严重漏洞，是容器逃逸的常见入口

所以 Muse 直接禁掉它。这是"**把不需要的攻击面整个关掉，而不是去过滤它**"的典型做法——比逐条检查可靠得多。

---

## 技术 3：Linux capabilities —— 把 root 拆成 40 个开关

**官方原文**：

> ... and **limited kernel capabilities (for example no `CAP_SYS_PTRACE` and no `CAP_NET_ADMIN`)**.

**原理**：传统 Unix 里，root 是一个**整体**——要么什么都能做，要么什么都不能。Linux capabilities 把它拆成大约 40 个独立的位，每个位控制一类特权：

| capability | 能做什么 | 为什么容器里不该有 |
|---|---|---|
| `CAP_SYS_PTRACE` | ptrace 其他进程（读别人内存、改别人代码） | 能读到宿主上同 uid 的进程内存 |
| `CAP_NET_ADMIN` | 改网络接口、路由表、防火墙规则 | 能改网络配置，绕过出口策略 |
| `CAP_SYS_ADMIN` | mount、改 cgroup 等等 | 事实上的"新 root"，危险程度等同于旧 root |

**关键点**：这些位是**独立**的。一个进程可以同时"是 uid 0"和"没有 CAP_NET_ADMIN"。

容器运行时（包括 systemd-nspawn）会在启动时 drop 掉一个 capability 集合。于是即使你在容器里当上了 root：

- 你不能 ptrace 宿主的进程
- 你不能改网络配置
- 你不能 mount

**为什么 Muse 要点名这两个**：`CAP_SYS_PTRACE` 会直接威胁"两个信任域"的隔离——能读别的进程内存，就等于能读控制面的秘密。`CAP_NET_ADMIN` 会威胁出口策略——能改路由，就能绕过 forward proxy。

---

## 技术 4：SO_PEERCRED —— 内核告诉你对端是谁

**官方原文**：

> All communication between the runtime cell and other services in the VM happens via **Unix domain sockets with `SO_PEERCRED` and peer ACLs**. This provides kernel authenticated, least-privilege interprocess communication **with no secrets to steal**.

**原理**：`SO_PEERCRED` 是 Unix domain socket 的一个 socket option。服务端调用 `getsockopt(fd, SOL_SOCKET, SO_PEERCRED, ...)`，**内核返回连接对端的 pid、uid、gid**。

为什么这个设计重要：

- **身份由内核填写，对端无法伪造。** 进程不能声称自己是别的 uid。
- **通道上不需要放任何密钥。** 传统的 IPC 认证要传 token / 共享密钥，而任何放在通道上的东西都可能被偷。SO_PEERCRED 不需要传——身份是内核附带的。
- **可以做 per-caller 的 ACL。** 服务端可以规定"只有 uid 1000 且 pid 属于某个 cgroup 的进程能调用这个方法"。

最后那句 **"with no secrets to steal"** 是精髓：**如果一个通道本身没有秘密，那它就没有可偷的东西。**

macOS 上的对应物是 `LOCAL_PEERCRED` / `LOCAL_PEERPID`。

---

## Demo：在这台机器上真的做了

`code/step1-trust-domains.mjs` 起了两个进程：

- **Host domain**：持有真实凭据，只暴露一个 `propose` 接口
- **Runtime cell**：跑在操作系统沙箱里，通过 Unix socket 和宿主通信

三个攻击场景：

```sh
node code/step1-trust-domains.mjs
```

```
【Host domain 已就绪】持有凭据，只暴露 propose
  控制面 socket 权限：0600（只有同 uid 的进程能连）
  ── 攻击面 1：直接从文件系统偷凭据 ──
    ✅ 被挡住：EPERM（内核拒绝，不是我们的代码在检查）
  ── 攻击面 2：让控制面给自己发许可证 ──
    ✅ unknown op: grant — 控制面不提供授权接口——授权只能来自用户
  ── 攻击面 3：自己直接执行动作 ──
    ✅ cell 里没有 GitHub 凭据，也没有出网路径，动作根本执行不了
```

**攻击面 1 是真的内核级拒绝。** 用的是 macOS 的 **Seatbelt**（`sandbox-exec`）：策略由内核在系统调用层面执行，cell 进程没有任何办法绕过——它不是"我们的代码检查后拒绝"，是内核让 `readFileSync` 直接返回 `EPERM`。

**攻击面 2 是这一步最重要的一课。** 注意控制面**根本不存在** `grant` 这个操作。不是它检查后拒绝了，是**没有那条代码路径**。

这两件事的区别很大：

| | 拦截式 | 无路径式 |
|---|---|---|
| 怎么做 | 写检查逻辑，发现越权就返回错误 | 根本不实现那个能力 |
| 被绕过的前提 | 找到检查的漏洞 | 找到不存在的代码 |
| 代码演进时 | 新增路径可能忘加检查 | 不可能"忘了加" |

Muse 的 "the agent can't give itself a license" 属于后者。**它不是禁止，是没有。**

---

## 技术差异的诚实说明

| | Muse（Linux） | 本 demo（macOS） |
|---|---|---|
| 隔离机制 | `systemd-nspawn` + user namespace + seccomp + capabilities | Seatbelt（`sandbox-exec`） |
| 策略形态 | **deny-by-default** 白名单 | allow-default + 精确 deny |
| 内核强制 | 是 | **是**（这一点相同） |

**为什么我用反向写法**：Seatbelt 的 profile 要给一个完整的 Node 运行时写白名单，需要逐个枚举 dyld 缓存、mach service、共享内存等依赖——我试了，`(deny default)` 下 Node 直接 `SIGABRT`。

所以本 demo 用"默认允许 + 精确拒绝凭据文件"来演示。**机制是同一个：策略在内核里，不在 agent 手里。**

Muse 在生产里用白名单，因为它的 cell 镜像可以预先精确枚举依赖。

---

## 一个真实的坑：路径规范化

第一版 demo **没挡住**。cell 明明在沙箱里，却读到了宿主凭据。

原因：macOS 上 `/var` 是 `/private/var` 的**符号链接**。我生成的临时目录路径是 `/var/folders/...`，写进 deny 规则用的就是这个。但 Seatbelt **按解析后的真实路径匹配**，实际路径是 `/private/var/folders/...`——两条规则对不上，策略静默失效。

修法是一行：

```js
const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'muse-')))
```

**这是安全策略里最经典的失效模式之一**：策略写对了语法，但没写对路径。而且它失败的方式是"静默放行"——你只会看到攻击成功，不会看到任何报错。

后面几步会反复遇到同一个主题：**安全检查最危险的失败模式是"看起来生效了，其实没有"。**

---

## 这一章要记住的

**"agent 无法给自己发许可证"应该是一个结构事实，不是一个检查结果。**

结构事实的做法：控制面没有那个接口，通道不携带秘密，内核拒绝那些调用。三者都不依赖"我们记得检查"。

下一章讲模型和这个结构之间那道边界：**模型输出的是数据，不是命令。**
