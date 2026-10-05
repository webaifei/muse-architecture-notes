# 六、privsep：改参数没有用

> **代码**：`code/step6-privsep.mjs`  
> **官方来源**：[How We Built Safety Into Muse](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)

## 我原以为"检查参数"就够了

工具收到一个请求，检查里面的 `provider` 字段是不是这个工具该用的——是就用，不是就拒绝。

这段代码的问题是：**它在检查一个攻击者能控制的值，然后根据这个值去决定用哪份凭据。**

Muse 的做法是让那个值**根本不参与决定**。

## 官方怎么说

> The CLI running in the runtime cell only parses arguments, opens already allowed files on the caller's behalf, and passes **typed arguments and file descriptors** over a Unix socket to a worker. The actual privileged business logic runs in a **systemd sandboxed worker outside the runtime cell**.

> Each worker is identified by its **cgroup** and has explicit **credential allowlists**. **A calendar worker cannot ask authd for an email credential simply by changing a request parameter.**

最后那句是整章的主旨。

---

## 技术 1：把"解析输入"和"使用特权"分开

**privsep（特权分离）** 是一个很老的设计思路（OpenSSH 是经典案例），核心是：

> 处理不可信输入的代码，不应该同时持有特权。

Muse 在 connector 上的落地：

| 角色 | 位置 | 权限 | 干什么 |
|---|---|---|---|
| **CLI** | runtime cell 内（不可信域） | 调用者的权限 | 解析参数、打开已授权的文件、把 typed args + fd 递出去 |
| **worker** | runtime cell 外（host domain） | 有凭据，但被收窄 | 执行真正的业务逻辑 |

**CLI 里没有任何凭据。** 它做不了 connector 的事——不是"被禁止做"，是它这一侧没有材料。

Demo 的验证：

```
▸ 攻击 B：CLI 想自己去找凭据
    CLI 自己持有的属性：[]
    ✅ CLI 里没有 authd 引用、没有凭据——它只能把请求转给 worker
```

---

## 技术 2：cgroup 身份 —— 内核给的，伪造不了

Worker 去 authd 取凭据时，authd 怎么知道它是谁？

**用 cgroup。** 每个 worker 在独立的 cgroup 里运行，authd 通过内核接口读取 caller 的 cgroup，据此判断身份。

为什么不用请求里的字段？因为字段是调用者写的。

| | 请求里的 `workerId` | cgroup |
|---|---|---|
| 谁填写 | 调用者 | **内核** |
| 能不能改 | 能 | 不能 |
| 攻击者需要什么 | 改一个字符串 | 让内核相信它是另一个 cgroup |

Demo 里的落地：

```js
credentialFor(workerId, provider) {
  const allowed = WORKER_CREDENTIAL_ALLOWLIST[workerId]
  if (!allowed.includes(provider)) throw new Error(...)
  return this.#material.get(provider)
}
```

注意 `provider` 是 **worker 从自己的身份推导出来的**，不是从请求里读的：

```js
const provider = this.#workerId.replace('-worker', '')
const credential = this.#authd.credentialFor(this.#workerId, provider)
```

**这就是"改参数没有用"的机制**：参数压根不在这条路径上。

```
▸ 攻击 A：日历 worker 改参数去要邮箱凭据
  ✅ 拦截：worker "calendar-worker" 的凭据白名单是 [calendar]，不含 "mail"
     注意拦截的依据是 worker 身份，不是参数内容。
     换句话说：改参数没有用，因为参数压根不参与这个决定。
```

---

## 技术 3：文件描述符传递 —— 权限判断留在有能力的那一侧

这里有个反直觉的地方。

Worker **有特权**，但它的文件访问能力反而是被动的：它不自己打开文件，而是接收 CLI 递过来的 **file descriptor**。

```
CLI（调用者权限）                  worker（特权）
   │                                  │
   │ ① 想打开 /etc/shadow              │
   │    但它没有这个权限 → 打不开       │
   │                                  │
   │ ② 能打开的只有 /workspace/*       │
   │ ③ 把 fd 通过 Unix socket 递过去   │
   │ ────────────────────────────────▶│
   │                                  │ ④ 直接读写这个 fd
   │                                  │    不需要知道路径，也没有路径权限
```

**Unix domain socket 上通过 `SCM_RIGHTS` 传 fd，接收方拿到的是文件本身，不是路径。** 所以：

- 调用者能打开什么，决定了 worker 能碰到什么
- **权限判断发生在有能力判断的那一侧**（CLI 知道调用者是谁）
- worker 不需要一个"检查路径"的逻辑，它根本没有路径

Muse 用这个设计有一个很实际的理由：**worker 是有特权的，所以不该给它一个"用户可控的路径字符串"。** 它只接收已经打开的 fd。

Demo 验证：

```
▸ 攻击 C：CLI 想打开权限范围外的文件
  [CLI] 解析参数 method=read_file args={"path":"/etc/shadow"}
  ✅ CLI 无权打开 /etc/shadow（这是调用者权限范围之外的路径）
```

---

## 技术 4：三道独立判断

官方原文把这件事讲得很清楚：

> Practically, this means there are **three independent decisions** being made: **privsep** decides where credential-capable code executes; **authd** decides which credential material an authenticated caller may obtain; and **Sentinel** decides whether an action may be taken.

| 判断 | 问题 | 组件 |
|---|---|---|
| 1 | 哪段代码能碰凭据？ | privsep |
| 2 | 这个调用者能拿到哪类凭据？ | authd |
| 3 | 这个动作能不能执行？ | Sentinel |

**"independent" 是关键**。如果这三件事由一个组件做，攻破它就是一次全破。分成三个之后，攻击者要**同时在三个地方成功**：

- 绕过 privsep → 还要过 authd 的白名单
- 骗过 authd → 还要过 Sentinel 的裁决
- 骗过 Sentinel → 还是拿不到 authd 不给的凭据

这不是"三重检查"（那是同一个判断写了三遍），是**三个不同的判断**，各自管一件不同的事。

---

## 这一章要记住的

**"改一个请求参数"是这类攻击的统一描述。**

日历 worker 改参数去要邮箱凭据、低权限用户改 `userId` 去读别人的数据、普通工具改 `role` 去提权——都是同一个模式。

防御方式也统一：**让那个参数不参与决定。**

具体做法有两种：

| 做法 | 例子 |
|---|---|
| 用内核提供的身份 | cgroup 标出 worker 是谁 |
| 用自己推导的值 | provider 从 workerId 推导，不从请求读 |

两种都是"**决定所依赖的输入，必须来自调用者控制之外**"。

下一章讲一个更细的东西：即使进程是合法的、请求也通过了，**它碰过什么**也应该影响裁决。
