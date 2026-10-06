/**
 * Step 6 — privsep：特权代码与调用者分离。
 *
 * 官方原文：
 *   The CLI running in the runtime cell only parses arguments, opens already
 *   allowed files on the caller's behalf, and passes typed arguments and file
 *   descriptors over a Unix socket to a worker. The actual privileged business
 *   logic runs in a systemd sandboxed worker outside the runtime cell.
 *
 *   Each worker is identified by its cgroup and has explicit credential
 *   allowlists. **A calendar worker cannot ask authd for an email credential
 *   simply by changing a request parameter.**
 *
 *   Practically, this means there are three independent decisions being made:
 *   privsep decides where credential-capable code executes; authd decides which
 *   credential material an authenticated caller may obtain; and Sentinel decides
 *   whether an action may be taken.
 *
 * 用到的技术（真实）
 *   - 特权分离（privilege separation）：把"解析输入"和"使用特权"放进不同进程
 *   - cgroup 身份：内核给出的、进程无法伪造的身份标签
 *   - 能力降级：每个 worker 只拿到自己那部分凭据，不是"检查"而是"只有"
 *   - 文件描述符传递（Unix socket SCM_RIGHTS）：CLI 打开文件，把 fd 交给 worker，
 *     worker 自己不需要有访问那个路径的权限
 *
 * 运行：node code/step6-privsep.mjs
 */

const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))

// ══════════════════════════════════════════════════════════════════════
// authd：按 **worker 身份** 发凭据，不看调用者传了什么参数
// ══════════════════════════════════════════════════════════════════════
const WORKER_CREDENTIAL_ALLOWLIST = {
 // cgroup 身份 → 允许获得的凭据
 'github-worker': ['github'],
 'calendar-worker': ['calendar'],
 'mail-worker': ['mail'],
}

class Authd {
 #material = new Map([
   ['github', 'ghp_REAL_github_token'],
   ['calendar', 'cal_REAL_calendar_token'],
   ['mail', 'mail_REAL_mail_token'],
 ])

 /** @param workerId cgroup 身份，由内核给出，调用方无法伪造 */
 credentialFor(workerId, provider) {
   const allowed = WORKER_CREDENTIAL_ALLOWLIST[workerId]
   if (!allowed) throw new Error(`unknown worker: ${workerId}`)
   if (!allowed.includes(provider)) {
     throw new Error(
       `worker "${workerId}" 的凭据白名单是 [${allowed}]，不含 "${provider}"`,
     )
   }
   return this.#material.get(provider)
 }
}

// ══════════════════════════════════════════════════════════════════════
// Worker：真正持有特权的业务逻辑（在 runtime cell 之外）
// ══════════════════════════════════════════════════════════════════════
class Worker {
 #authd
 #workerId

 constructor(authd, workerId) {
   this.#authd = authd
   this.#workerId = workerId
 }

 get id() {
   return this.#workerId
 }

 /**
  * @param request { method, args, fds }  —— 来自 CLI，经过强类型校验
  * 注意：worker 用的是**自己的身份**去取凭据，不是 request 里给的。
  */
 async handle(request) {
   say(3, `[${this.#workerId}] 收到 typed request: ${JSON.stringify({ method: request.method, args: request.args })}`)
   if (request.fds?.length) {
     say(3, `[${this.#workerId}] 收到 ${request.fds.length} 个文件描述符（CLI 已经打开并校验过）`)
   }

   // ★ 关键：provider 来自 worker 自己的声明，不是请求参数
   const provider = this.#workerId.replace('-worker', '')
   const credential = this.#authd.credentialFor(this.#workerId, provider)

   return {
     worker: this.#workerId,
     method: request.method,
     credentialUsed: `${credential.slice(0, 10)}…`,
     result: `${request.method} 完成`,
   }
 }

 /** 演示：如果 worker 试图用请求参数里的 provider 去取凭据，会被白名单挡住 */
 async handleWithRequestedProvider(request) {
   try {
     this.#authd.credentialFor(this.#workerId, request.args.provider)
     return { escaped: true }
   } catch (error) {
     return { escaped: false, reason: error.message }
   }
 }
}

// ══════════════════════════════════════════════════════════════════════
// CLI：runtime cell 里的薄适配器
// ══════════════════════════════════════════════════════════════════════
const CELL_READABLE_FILES = new Set(['/workspace/report.md', '/workspace/data.csv'])

class ConnectorCli {
 #worker

 constructor(worker) {
   this.#worker = worker
 }

 /** CLI 只做三件事：解析参数、打开有权访问的文件、把 typed args + fd 递过去 */
 async invoke(method, args, filesToOpen = []) {
   say(2, `[CLI] 解析参数 method=${method} args=${JSON.stringify(args)}`)

   const fds = []
   for (const path of filesToOpen) {
     if (!CELL_READABLE_FILES.has(path)) {
       return { error: `CLI 无权打开 ${path}（这是调用者权限范围之外的路径）` }
     }
     fds.push({ fd: fds.length + 3, path })
     say(2, `[CLI] 打开 ${path} → fd ${fds.length + 2}`)
   }

   // 注意：CLI 没有凭据，也不执行任何 connector 业务逻辑
   return this.#worker.handle({ method, args, fds })
 }

 /** 演示：CLI 想知道自己的凭据——它没有 */
 hasCredential() {
   return Object.getOwnPropertyNames(this).filter((n) => !n.startsWith('#'))
 }
}

// ══════════════════════════════════════════════════════════════════════
// 场景
// ══════════════════════════════════════════════════════════════════════
const authd = new Authd()
say(0, '【三个独立判断】')
say(1, `privsep  ${'→ 哪段代码能处理凭据：只有 worker，CLI 里没有凭据'}`)
say(1, `authd     → 已认证 caller 能拿到哪类凭据：按 cgroup 身份查白名单`)
say(1, `Sentinel  → 动作能不能执行（第 3 步已实现）`)
say(0, '')

say(0, '── 正常路径：日历 worker 读日历 ──')
{
 const worker = new Worker(authd, 'calendar-worker')
 const cli = new ConnectorCli(worker)
 const result = await cli.invoke('list_events', { from: '2026-10-05' })
 say(2, `结果：${JSON.stringify(result)}`)
}

say(0, '')
say(0, '── 攻击场景 ──')

say(0, '▸ 攻击 A：日历 worker 改参数去要邮箱凭据')
{
 const worker = new Worker(authd, 'calendar-worker')
 const attempt = await worker.handleWithRequestedProvider({ args: { provider: 'mail' }, method: 'list_events' })
 say(2, ` 拦截：${attempt.reason}`)
 say(2, '   注意拦截的依据是 **worker 身份**，不是参数内容。')
 say(2, '   换句话说：改参数没有用，因为参数压根不参与这个决定。')
}

say(0, '▸ 攻击 B：CLI 想自己去找凭据')
{
 const worker = new Worker(authd, 'github-worker')
 const cli = new ConnectorCli(worker)
 say(2, `CLI 自己持有的属性：${JSON.stringify(cli.hasCredential())}`)
 say(2, ' CLI 里没有 authd 引用、没有凭据——它只能把请求转给 worker')
}

say(0, '▸ 攻击 C：CLI 想打开权限范围外的文件，再把 fd 递给 worker')
{
 const worker = new Worker(authd, 'github-worker')
 const cli = new ConnectorCli(worker)
 const result = await cli.invoke('read_file', { path: '/etc/shadow' }, ['/etc/shadow'])
 say(2, ` ${result.error}`)
 say(2, '   这一步很重要：worker 有特权，但它信任的是 CLI 递过来的 fd，')
 say(2, '   所以"能打开什么"必须在 CLI 侧就卡住。')
}

say(0, '▸ 攻击 D：worker 身份被伪造')
{
 say(2, 'worker 身份来自 cgroup，由内核给出；调用方无法通过参数或头部伪造。')
 say(2, '本 demo 里它是构造 Worker 时写死的字符串。')
}
