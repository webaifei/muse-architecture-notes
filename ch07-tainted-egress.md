# 七、tainted egress：让审批只在必要时打扰用户

> **代码**：`code/step7-tainted-egress.mjs`  
> **官方来源**：[How We Built Safety Into Muse](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)

## 我原以为审批越严越好

每个网络请求都弹窗问用户——听起来最安全。

实际上不是。**一个每次都要点确认的系统，和一个从不确认的系统，安全水平是一样的**——因为用户会在第三天开始无脑点"允许"。

审批的价值取决于它出现的频率。太频繁 = 用户脱敏 = 等于没有。

所以真正的问题不是"怎么拦更多"，而是**"怎么在拦住危险请求的同时，让安全请求静默通过"**。

## 官方怎么说

> Each tool execution process **starts off as clean, until it reads user data, at which point it becomes tainted**. Tainted processes lose their eligibility for narrowly-scoped auto-allow requests and enter the normal approval flow for network requests.

> ... implemented with **eBPF cgroup programs** for network interception and process attribution, and by attaching **eBPF programs to Linux Security Module hooks** to propagate taint.

一句话总结：**不是看请求，是看请求是从哪个进程发出来的，以及那个进程碰过什么。**

---

## 技术 1：eBPF 是什么

**eBPF（extended Berkeley Packet Filter）** 是 Linux 内核里的一个可编程执行环境。你在用户态写一小段程序，加载进内核，内核在特定事件上调用它。

三个关键性质：

| 性质 | 意味着什么 |
|---|---|
| 在内核里执行 | 用户态进程无法绕过，也无法篡改 |
| 有校验器 | 加载前静态检查，保证不会死循环、不越界访问 |
| 挂载点丰富 | 网络收发包、syscall、cgroup、LSM hook…… |

Muse 用到了两个挂载点。

### 挂载点一：cgroup 程序 —— 网络拦截与进程归因

**cgroup**（control group）是 Linux 用来给进程分组的机制。eBPF 可以挂在 cgroup 上，于是：

- 该 cgroup 里**所有**进程的网络操作都会经过这段程序
- 程序能把这次连接**归因到具体是哪个进程发起的**
- 可以在这里放行、拒绝、或者记录下来

**"process attribution"（进程归因）这个词是关键。** 普通的防火墙只看五元组（源 IP、目的 IP、端口、协议），它不知道"是哪个进程"。有了 cgroup + eBPF，你能回答"**这次连接是刚才读了用户邮件的那个进程发的**"。

### 挂载点二：LSM hook —— 传播 taint

**LSM（Linux Security Modules）** 是内核里的一组安全检查点（SELinux、AppArmor 都挂在这上面）。eBPF 程序也可以挂上去，于是你能观察到：

- 进程打开/读取了哪个文件
- 进程 fork 出了谁

**当观察到"读取了用户数据"时，就把这个进程标记为 tainted。**

---

## 技术 2：taint 的语义是"降级"，不是"阻止"

这一点容易误解。看到"标记为污染"，直觉是"阻止它"。

实际语义是：

```
clean  进程 + 窄白名单 → 可以静默通过（auto-allow）
tainted 进程 + 同样的目的地 → 失去 auto-allow，走人工审批
```

**taint 只是取消一个特权，不是加一个禁令。**

这个设计的好处是**渐进**：不需要预先定义"什么数据算敏感"，只需要定义"什么样的请求可以免审批"。taint 负责把这个豁免收回去。

---

## 技术 3：白名单必须"窄"

```js
const AUTO_ALLOW = [
  { host: 'api.github.com', path: '/repos/*/*/issues', methods: ['GET'] },
  { host: 'api.calendar.example', path: '/events', methods: ['GET'] },
]
```

三个维度都收窄了：**host、path、method**。

- host 精确：不是 `*.github.com`
- path 有模式：不是 `/repos/*`（那会包含删除仓库之类的写操作）
- method 限定 `GET`：**POST 一律不放行**

**为什么必须窄**：auto-allow 是唯一一个"不经用户就出网"的通道。它宽一寸，taint 那一层就白做一大截。

我在写 demo 时就踩了这个：白名单写成 `/repos/*/issues`，正则只匹配一段路径，结果 GitHub 实际的 `/repos/{owner}/{repo}/issues` 是两段，白名单形同虚设——**一个从来没生效过的豁免和一个很宽的豁免，问题是一样的**。

---

## 对照实验

Demo 跑了四种情形：

```
── 情形 1：clean 进程请求白名单内的目的地 ──
  🟢 auto-allow — clean 进程 + 目的地在窄白名单内
     ↑ 用户没有被打扰——这就是这一层的价值

── 情形 2：同一个进程读了用户数据之后再出网 ──
  🟡 ask — 进程读过用户数据（tainted），失去 auto-allow 资格
     ↑ 目的地完全一样，但因为进程 tainted，降级为人工审批
```

**情形 1 和情形 2 的请求完全相同**——同一个 host、同一个 path、同一个 method。唯一的差别是**发请求的进程之前干了什么**。

这就是 taint 跟踪带来的新信息维度：

| | 传统裁决依据 | taint 之后的依据 |
|---|---|---|
| 输入 | 请求本身（五元组、path、body） | 请求 **+ 发起者的历史** |
| 能回答 | "这个请求危险吗" | "**发出这个请求的进程，刚刚碰过什么**" |

**去掉 taint 跟踪会怎样**——把 `AUTO_ALLOW` 当成唯一依据，情形 1 和情形 2 会得到**完全相同的结论**。也就是说：一个刚刚读完你邮箱的进程，可以静默地把数据发到 `api.github.com`。

---

## ⚠️ 本 demo 与真实实现的差异

**做不了真的**：这台机器是 macOS，没有 Linux 内核，装不了 eBPF。

**我做的**：把 eBPF 的**观察点**换成显式钩子调用，taint 的传播和裁决逻辑完全一致。

```js
function observeRead(pid, path, isUserData) { ... }   // ← eBPF LSM hook 的等价物
function decideEgress(kernel, pid, target) { ... }    // ← eBPF cgroup 程序的等价物
```

| | 真实（Linux） | 本 demo（macOS） |
|---|---|---|
| 谁观察"读了用户数据" | eBPF + LSM hook，**内核** | 显式函数调用 |
| 进程身份 | 内核给的 pid/cgroup | 参数传入的 pid |
| 能不能被绕过 | 不能 | **能**（进程不调那个函数就没人知道） |

**差异只在"谁来观察"，不在"观察到之后怎么判断"。**

而"谁来观察"恰恰是安全性所在——真实实现里进程**无法选择不被观察**，demo 里它可以。这是这一步唯一不能靠模拟跨过去的地方。

---

## 这一章要记住的

**审批的目标不是"拦下所有危险操作"，而是"只打扰该被打扰的那部分"。**

判断一个 agent 安全系统做得好不好，除了"能不能挡住攻击"，还要看第二个指标：

> 一个正常的、没有碰过用户数据的任务，用户需要点几次"允许"？

这个数字接近零，用户才会在真正需要时认真看那个弹窗。

下一章讲最后一件事：模型说"我做完了"的时候，系统怎么知道它是真的做完了。
