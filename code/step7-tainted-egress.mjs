/**
 * Step 7 — tainted egress：用内核数据流给审批降噪。
 *
 * 官方原文：
 *   Each tool execution process starts off as clean, until it reads user data,
 *   at which point it becomes tainted. Tainted processes lose their eligibility
 *   for narrowly-scoped auto-allow requests and enter the normal approval flow
 *   for network requests. ... implemented with eBPF cgroup programs for network
 *   interception and process attribution, and by attaching eBPF programs to
 *   Linux Security Module hooks to propagate taint.
 *
 * 为什么需要这一层：如果每个请求都问用户，用户会关掉审批；
 * 如果都不问，就等于没有审批。所以需要**让大多数安全的请求静默通过**。
 *
 * 用到的技术（真实）
 *   - eBPF cgroup 程序：挂在 cgroup 层级上，拦截该组内所有进程的网络操作，
 *     并能把连接归因到具体进程
 *   - eBPF + LSM hooks：挂在内核安全检查点上，观察"这个进程读了哪些文件"，
 *     据此传播 taint 标记
 *   - 数据流标记（taint tracking）：信息从哪里来，决定它出去时要多小心
 *
 * ⚠️ macOS 上没有 Linux 内核，做不了真 eBPF。本 demo 用**可运行的等价模型**：
 *    把 eBPF 的观察点换成显式的钩子调用，taint 传播逻辑完全一致。
 *    差异只在"谁来观察"，不在"观察到之后怎么判断"。
 *
 * 运行：node code/step7-tainted-egress.mjs
 */

const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))

// ══════════════════════════════════════════════════════════════════════
// 策略：窄范围的 auto-allow 白名单（只有 clean 进程能命中）
// ══════════════════════════════════════════════════════════════════════
const AUTO_ALLOW = [
  { host: 'api.github.com', path: '/repos/*/*/issues', methods: ['GET'] },
  { host: 'api.calendar.example', path: '/events', methods: ['GET'] },
]

function matchesAutoAllow(host, path, method) {
  return AUTO_ALLOW.some((rule) => {
    if (rule.host !== host) return false
    if (!rule.methods.includes(method)) return false
    const pattern = new RegExp(`^${rule.path.replace(/\*/g, '[^/]+')}$`)
    return pattern.test(path)
  })
}

// ══════════════════════════════════════════════════════════════════════
// "内核"：进程表 + 数据流标记
// 真实系统里这些信息由 eBPF 程序提供
// ══════════════════════════════════════════════════════════════════════
class Kernel {
  #procs = new Map()

  /** 新建一个工具执行进程——初始 clean */
  spawnToolProcess(pid, label) {
    this.#procs.set(pid, { label, tainted: false, taintSource: null, reads: [] })
    say(3, `[kernel] spawn pid=${pid} (${label}) → clean`)
  }

  /** eBPF LSM hook 的等价物：观察一次文件读取 */
  observeRead(pid, path, isUserData) {
    const proc = this.#procs.get(pid)
    proc.reads.push(path)
    if (!isUserData) {
      say(3, `[kernel] pid=${pid} 读 ${path}（非用户数据，保持 clean）`)
      return
    }
    if (!proc.tainted) {
      proc.tainted = true
      proc.taintSource = path
      say(3, `[kernel] pid=${pid} 读 ${path} ← **用户数据，标记为 tainted**`)
    }
  }

  isTainted(pid) {
    return this.#procs.get(pid)?.tainted ?? false
  }

  label(pid) {
    return this.#procs.get(pid)?.label ?? `pid=${pid}`
  }
}

// ══════════════════════════════════════════════════════════════════════
// Sentinel 的出口裁决（带 taint 输入）
// ══════════════════════════════════════════════════════════════════════
function decideEgress(kernel, pid, { host, path, method }) {
  const tainted = kernel.isTainted(pid)
  const narrowlyScoped = matchesAutoAllow(host, path, method)

  if (narrowlyScoped && !tainted) {
    return { decision: 'auto-allow', reason: 'clean 进程 + 目的地在窄白名单内' }
  }
  if (tainted) {
    return {
      decision: 'ask',
      reason: `进程读过用户数据（${kernel.isTainted(pid) ? 'tainted' : ''}），失去 auto-allow 资格`,
    }
  }
  return { decision: 'ask', reason: '目的地不在窄白名单内' }
}

// ══════════════════════════════════════════════════════════════════════
// 场景
// ══════════════════════════════════════════════════════════════════════
const kernel = new Kernel()

function step(label, pid, target, reads = []) {
  say(1, `▸ ${label}`)
  for (const r of reads) kernel.observeRead(pid, r.path, r.isUserData)
  const result = decideEgress(kernel, pid, target)
  const icon = result.decision === 'auto-allow' ? '🟢' : '🟡'
  say(2, `${icon} ${result.decision} — ${result.reason}`)
  say(2, `   请求 ${target.method} ${target.host}${target.path}`)
  return result
}

say(0, '【窄白名单】')
for (const r of AUTO_ALLOW) say(1, `${r.methods.join('/')} ${r.host}${r.path}`)
say(0, '')

say(0, '── 情形 1：clean 进程请求白名单内的目的地 ──')
kernel.spawnToolProcess(1001, 'list-issues')
step('只读了一个公开的仓库配置', 1001, { host: 'api.github.com', path: '/repos/a/b/issues', method: 'GET' }, [
  { path: '/workspace/public.json', isUserData: false },
])
say(2, '   ↑ 用户没有被打扰——这就是这一层的价值')
say(0, '')

say(0, '── 情形 2：同一个进程读了用户数据之后再出网 ──')
kernel.spawnToolProcess(1002, 'summarize-mail')
step('先读用户的邮件', 1002, { host: 'api.github.com', path: '/repos/a/b/issues', method: 'GET' }, [
  { path: '/home/user/mail/2026-10-05.eml', isUserData: true },
])
say(2, '   ↑ 目的地完全一样，但因为进程 tainted，降级为人工审批')
say(0, '')

say(0, '── 情形 3：clean 但目的地不在白名单里 ──')
kernel.spawnToolProcess(1003, 'fetch-docs')
step('想访问一个没声明过的域名', 1003, { host: 'random-blog.example', path: '/post', method: 'GET' })
say(0, '')

say(0, '── 情形 4：tainted 进程想往外部发送用户数据 ──')
kernel.spawnToolProcess(1004, 'upload-report')
step('读了用户的报表', 1004, { host: 'api.github.com', path: '/repos/a/b/issues', method: 'POST' }, [
  { path: '/home/user/reports/q3.xlsx', isUserData: true },
])
say(2, '   ↑ POST 不在白名单里（白名单只放 GET），且进程 tainted，双重原因要求审批')
say(0, '')

say(0, '═══ 对照实验：如果去掉 taint 跟踪会怎样 ═══')
say(1, '把 AUTO_ALLOW 当成唯一的判断依据，情形 1 和情形 2 会得到**完全相同的结论**。')
say(1, '也就是说：一个刚刚读完你邮箱的进程，可以静默地把数据发到 api.github.com。')
say(1, '')
say(1, 'taint 跟踪补上的正是信息：**"这个进程碰过什么"**。')
say(1, '同一个目的地的请求，因为进程的历史不同，得到的裁决也不同。')
say(0, '')
say(0, '【这一章的核心】')
say(1, '审批的目标不是"拦下所有危险操作"，而是"**只打扰该被打扰的那部分**"。')
say(1, '一个每次都要用户点确认的系统，和一个从不确认的系统，')
say(1, '在真实使用中的安全水平是一样的——因为用户会习惯性点"允许"。')
