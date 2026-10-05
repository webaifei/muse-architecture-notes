# 三、Sentinel：授权不在对话里

> **代码**：`code/step3-sentinel.mjs`  
> **官方来源**：[How We Built Safety Into Muse](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)

## 我原以为审批就是"弹个窗问用户"

用户点了允许，然后呢？

如果"用户已允许"这个事实存在某个变量里、或者某条消息里，那它就是一个**可以被污染的输入**。模型只要能在上下文里写一句"用户已经同意了"，剩下的就靠下游代码有没有检查。

Muse 的做法是：**审批根本不经过对话。**

## 官方怎么说

> Sentinel sends that request **directly to the Muse client**, where a dialog is presented to the user directly within the client UI — **not via their conversation with Muse** — and their answer is routed **directly back to Sentinel**.

> Approvals granted via the human in the loop system are **strict capabilities, not conversational suggestions**. They're bound to the particular connector/destination and use case.

两句话点出两件事：

1. **通道不同**：问题从 Sentinel → 客户端 → Sentinel，模型既看不见也改不了
2. **性质不同**：授权是一个 capability（能力凭证），不是一句建议

---

## 技术 1：capability，而不是 identity

传统的权限模型是 **RBAC**（基于角色）：你是管理员，所以你什么都能做。

**capability-based authorization** 换了个方向：授权是**一张具体的票**，票上写着能对什么做什么。

| | RBAC | capability |
|---|---|---|
| 授权粒度 | 主体（你是谁） | 客体 + 动作（能对什么做什么） |
| 检查方式 | 查你的角色 | 出示票，票面必须**精确匹配** |
| 权限扩大 | 换个角色就行 | 得重新开票 |

Demo 里那张票长这样：

```js
{
  connector: 'github',
  method: 'create_issue',
  actionClass: 'write',
  resource: 'repoA',          // ← 资源写死在票上
  kind: 'session',
  expiresAt: ...,
}
```

匹配逻辑必须**逐字段精确**：

```js
if (g.connector !== proposal.connector) continue
if (g.method !== proposal.method) continue
if (g.actionClass !== proposal.actionClass) continue
if (g.resource !== undefined && g.resource !== context.resource) continue
```

**为什么"精确匹配"而不是"包含关系"**：包含关系（比如"票允许 github.* 就可以做任何 github 操作"）在实现时要处理通配符、前缀、大小写等一系列边界，每一个都是绕过点。精确匹配没有这些边界。

---

## 技术 2：五种生命周期

官方列了五种授权范围：

> one-time, session-scoped, task-scoped, time-bounded, or perpetual permission

| 类型 | 什么时候失效 | 典型场景 |
|---|---|---|
| `one-time` | 用一次就废 | 发一条消息 |
| `session` | 会话结束 | 本次对话里读日历 |
| `task` | 任务完成 | 这个任务期间允许改这个 repo |
| `time-bounded` | 到期 | 接下来 30 分钟 |
| `perpetual` | 用户主动撤销 | 读公开仓库 |

**注意"谁决定用哪种"**：官方说 Sentinel 决定给用户呈现哪几种选项。这不是用户体验问题——**给用户一个"永久允许一切"的选项，等于把这个功能废掉**。

Demo 里最直观的是 `one-time`：

```
── 3. 用刚才的授权：范围一致 → 放行 ──
  ✅ allow — 沿用授权 grant_1
── 4. 一次性授权已被消耗 → 第二次必须重新审批 ──
  ⏸ ask — 产生待审批 approval_2
```

用掉就作废，`grant.used = true` 一行的事。

---

## 技术 3：默认拒绝，没有"默认放行"

```js
const policy = USER_POLICY[key] ?? 'deny'   // ← 没配过的一律拒绝
```

三态 `allow / deny / ask` 里**没有第四档**。这点很关键：很多系统的隐含默认是"没有规则就放行"，那样每新增一个 connector，在用户配置它之前就是一个敞开的门。

demo 里 `shell.run` 被显式 `deny`，其余没配的走审批。

---

## 四个攻击场景

### 攻击 A：拿 repoA 的授权读 repoB

```
✅ 被拦住：授权范围是 repoA，请求的是 repoB
```

这是 capability 模型的核心价值。**票是有边界的。**

### 攻击 B：用写授权做读操作

```
✅ 被拦住：授权绑定 actionClass=write，请求的是 read
```

`actionClass` 也是票面的一部分。用户批准"给这个 repo 建 issue"，不代表同意你读它的私有内容。

### 攻击 C：模型在对话里写"用户已经批准了" ← 这一条最重要

```
✅ 没有被放行，仍然走审批：approval_1
   对话里那句"用户已经同意了"对 Sentinel 没有任何效力——
   授权状态只存在于 Sentinel 里，模型改不了它，也读不到它
```

注意这不是"我们检查了那句话是不是假的"——**是那句话根本没有进入决策路径**。Sentinel 的授权状态存在自己的内存里，模型既没有读的接口，也没有写的接口。

**"用户同意了"是一个事实，事实只能由产生它的系统来断言。**

### 攻击 D：限时授权过期后继续用

```
✅ 被拦住：授权已过期，回到审批流程
```

`expiresAt` 在每次匹配时检查。这里有个实现细节值得注意：**过期检查必须在授权时做，不能只在签发时做。**

---

## 这一章要记住的

**授权状态不应该出现在模型能读写的任何地方。**

判断一个 agent 系统在这点上做得好不好，问一个问题就够了：

> 模型能不能让"用户已经允许"这件事变成真的？

如果答案依赖"我们检查了模型有没有撒谎"，那答案是**能**——只要它找到一个你没检查的路径。

下一章讲凭据：当动作已经被授权了，凭据怎么用而不被偷。
