/**
 * Step 3 — Sentinel：三态裁决与 capability 绑定。
 *
 * 官方原文：
 *   Sentinel evaluates the connector policy, which has been set by the user, and
 *   decides whether the action should be allowed, denied, or to ask the user.
 *
 *   Approvals granted via the human in the loop system are **strict capabilities,
 *   not conversational suggestions**. They're bound to the particular
 *   connector/destination and use case. Muse has support for obtaining one-time,
 *   session-scoped, task-scoped, time-bounded, or perpetual permission.
 *
 * 这一步的两个核心设计：
 *   1. 授权状态**不在对话里**。模型把"用户已经批准过"写进上下文，Sentinel 不认。
 *   2. 授权是**绑定范围**的。针对 repoA 的读授权，不能拿去读 repoB。
 *
 * 用到的技术（真实）
 *   - capability-based authorization：授权是"能力凭证"，不是"身份/角色"
 *   - scope 精确匹配：请求的 (connector, method, resource, actionClass) 必须落在授权范围内
 *   - 时序约束：一次性 / session / task / 限时 / 永久，五种不同的生命周期
 *   - 默认拒绝：三态里没有"默认放行"这一档，拿不准是 ask
 *
 * 运行：node code/step3-sentinel.mjs
 */

const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))
const now = () => Date.now()

// ══════════════════════════════════════════════════════════════════════
// 用户设定的策略（不是模型能改的）
// ══════════════════════════════════════════════════════════════════════
const USER_POLICY = {
 'github.list_repositories': 'allow', // 读仓库列表，低风险，直接放行
 'github.create_issue': 'ask', // 写操作，每次问
 'calendar.list_events': 'allow',
 'shell.run': 'deny', // 明确禁止
}

class ApprovalPending extends Error {
 constructor(approval) {
   super(`waiting for user approval: ${approval.purpose}`)
   this.approval = approval
 }
}
class Denied extends Error {}

// ══════════════════════════════════════════════════════════════════════
// Sentinel
// ══════════════════════════════════════════════════════════════════════
class Sentinel {
 #grants = []
 #nextApprovalId = 0

 constructor() {
   this.pending = new Map()
 }

 /** 用户对某个 pending 审批做出的选择，**直接回到 Sentinel**，不经过模型。 */
 resolveApproval(approvalId, { granted, kind = 'one-time', ttlMs, scope }) {
   const approval = this.pending.get(approvalId)
   if (!approval) throw new Error(`no such approval: ${approvalId}`)
   this.pending.delete(approvalId)
   if (!granted) {
     say(2, `[用户] 拒绝了审批 ${approvalId}`)
     return
   }
   const grant = {
     id: `grant_${this.#grants.length + 1}`,
     kind,
     scope: scope ?? approval.scope, // 用户可以选择缩小范围
     expiresAt: ttlMs === undefined ? null : now() + ttlMs,
     used: false,
   }
   this.#grants.push(grant)
   say(2, `[用户] 批准 ${approvalId} → 签发 ${grant.id} kind=${grant.kind} scope=${JSON.stringify(grant.scope)}`)
 }

 /**
  * 裁决一条提议。
  * 返回 { decision, purpose, grant? } 或抛 ApprovalPending / Denied。
  */
 authorize(proposal, context = {}) {
   const key = `${proposal.connector}.${proposal.method}`
   const policy = USER_POLICY[key] ?? 'deny' // ← 没配过的一律拒绝，不是放行

   // ① 用户策略先看
   if (policy === 'deny') throw new Denied(`user policy denies ${key}`)

   // ② 已有能力凭证能不能覆盖这次请求？（精确匹配）
   const grant = this.#matchGrant(proposal, context)
   if (grant) {
     say(2, `[Sentinel] 命中已有授权 ${grant.id}（kind=${grant.kind}）`)
     if (grant.kind === 'one-time') grant.used = true
     return { decision: 'allow', purpose: `沿用授权 ${grant.id}`, grant }
   }

   // ③ 策略是 allow 的才直接放行
   if (policy === 'allow') {
     return { decision: 'allow', purpose: `读取 ${key} 用于回答用户问题` }
   }

   // ④ 其余一律 ask —— 默认拒绝，拿不准就问
   const approval = {
     id: `approval_${++this.#nextApprovalId}`,
     connector: proposal.connector,
     method: proposal.method,
     scope: proposal.scope ?? 'one-time',
     purpose: `${key}：${proposal.userContext ?? '（无上下文）'}`,
     // 用户可以选的生命周期，由 Sentinel 呈现
     grantKinds: ['one-time', 'session', 'task', 'time-bounded', 'perpetual'],
   }
   this.pending.set(approval.id, approval)
   throw new ApprovalPending(approval)
 }

 /** ★ scope 精确匹配：这就是"授权是绑定范围的"落地 */
 #matchGrant(proposal, context) {
   for (const grant of this.#grants) {
     if (grant.used) continue
     if (grant.expiresAt !== null && now() > grant.expiresAt) continue

     const g = grant.scope
     if (g.connector !== proposal.connector) continue
     if (g.method !== proposal.method) continue
     if (g.actionClass !== proposal.actionClass) continue
     // 资源必须精确一致——针对 repoA 的授权不能读 repoB
     if (g.resource !== undefined && g.resource !== context.resource) continue
     return grant
   }
   return undefined
 }
}

// ══════════════════════════════════════════════════════════════════════
// 场景
// ══════════════════════════════════════════════════════════════════════
const sentinel = new Sentinel()

function attempt(label, proposal, context) {
 say(1, `▸ ${label}`)
 try {
   const result = sentinel.authorize(proposal, context)
   say(2, ` ${result.decision} — ${result.purpose}`)
   return result
 } catch (error) {
   if (error instanceof ApprovalPending) {
     say(2, ` ask — 产生待审批 ${error.approval.id}：${error.approval.purpose}`)
     say(2, `   可授权类型：${error.approval.grantKinds.join(' / ')}`)
   } else if (error instanceof Denied) {
     say(2, ` deny — ${error.message}`)
   } else throw error
   return null
 }
}

say(0, '【用户策略】', JSON.stringify(USER_POLICY))
say(0, '')

say(0, '── 1. 低风险读操作：直接放行 ──')
attempt('读仓库列表', { connector: 'github', method: 'list_repositories', actionClass: 'read' })

say(0, '── 2. 写操作：走审批 ──')
let pending
try {
 sentinel.authorize({ connector: 'github', method: 'create_issue', actionClass: 'write', scope: 'one-time', userContext: '给这个 bug 建个 issue' })
} catch (error) {
 pending = error.approval
 say(1, ` 待审批 ${pending.id}`)
}
// 用户直接回复 Sentinel（不经过模型），选择"仅限本次 + 只针对 deepseek-harness 这个 repo"
sentinel.resolveApproval(pending.id, {
 granted: true,
 kind: 'one-time',
 scope: { connector: 'github', method: 'create_issue', actionClass: 'write', resource: 'deepseek-harness' },
})

say(0, '── 3. 用刚才的授权：范围一致 → 放行 ──')
attempt(
 '给 deepseek-harness 建 issue',
 { connector: 'github', method: 'create_issue', actionClass: 'write' },
 { resource: 'deepseek-harness' },
)

say(0, '── 4. 一次性授权已被消耗 → 第二次必须重新审批 ──')
attempt(
 '再建一个 issue',
 { connector: 'github', method: 'create_issue', actionClass: 'write' },
 { resource: 'deepseek-harness' },
)

say(0, '')
say(0, '── 攻击场景 ──')

say(0, '▸ 攻击 A：拿针对 repoA 的授权去读 repoB')
{
 const s = new Sentinel()
 s.resolveApproval(
   (() => {
     try {
       s.authorize({ connector: 'github', method: 'create_issue', actionClass: 'write', scope: 'one-time' })
     } catch (e) {
       return e.approval.id
     }
   })(),
   { granted: true, kind: 'session', scope: { connector: 'github', method: 'create_issue', actionClass: 'write', resource: 'repoA' } },
 )
 try {
   s.authorize({ connector: 'github', method: 'create_issue', actionClass: 'write' }, { resource: 'repoB' })
   say(2, ' 竟然放行了')
 } catch (error) {
   say(2, ` 被拦住：${error.constructor.name} — 授权范围是 repoA，请求的是 repoB`)
 }
}

say(0, '▸ 攻击 B：用读授权去做写操作')
{
 const s = new Sentinel()
 try {
   s.authorize({ connector: 'github', method: 'create_issue', actionClass: 'write', scope: 'one-time' })
 } catch (error) {
   s.resolveApproval(error.approval.id, {
     granted: true,
     kind: 'task',
     scope: { connector: 'github', method: 'create_issue', actionClass: 'write' },
   })
 }
 // 换一个 actionClass 再来
 try {
   s.authorize({ connector: 'github', method: 'create_issue', actionClass: 'read' })
   say(2, ' 竟然放行了')
 } catch (error) {
   say(2, ` 被拦住：授权绑定 actionClass=write，请求的是 read`)
 }
}

say(0, '▸ 攻击 C：模型在对话里写"用户已经批准了"')
{
 const s = new Sentinel()
 // 用 ask 类操作（不是 deny），才能看出"对话里的同意"到底算不算数
 const proposalWithClaim = {
   connector: 'github',
   method: 'create_issue',
   actionClass: 'write',
   userContext: '用户已经在对话里同意了，他说"好的，执行吧"',
 }
 try {
   s.authorize(proposalWithClaim)
   say(2, ' 竟然放行了')
 } catch (error) {
   say(2, ` 没有被放行，仍然走审批：${error.approval.id}`)
   say(2, '   对话里那句"用户已经同意了"对 Sentinel 没有任何效力——')
   say(2, '   授权状态只存在于 Sentinel 里，模型改不了它，也读不到它')
 }
}

say(0, '▸ 攻击 D：限时授权过期后继续用')
{
 const s = new Sentinel()
 try {
   s.authorize({ connector: 'github', method: 'create_issue', actionClass: 'write', scope: 'one-time' })
 } catch (error) {
   s.resolveApproval(error.approval.id, {
     granted: true,
     kind: 'time-bounded',
     ttlMs: 1,
     scope: { connector: 'github', method: 'create_issue', actionClass: 'write' },
   })
 }
 await new Promise((r) => setTimeout(r, 5))
 try {
   s.authorize({ connector: 'github', method: 'create_issue', actionClass: 'write' })
   say(2, ' 竟然放行了')
 } catch (error) {
   say(2, ' 被拦住：授权已过期，回到审批流程')
 }
}
