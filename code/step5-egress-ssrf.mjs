/**
 * Step 5 — 出口网关：L4/L7 检查与 SSRF 防护。
 *
 * 官方原文：
 *   All of Muse's network egress is managed at the egress point by Sentinel.
 *   The forward proxy ... inspects both L4 and L7 information, such as hostname,
 *   resolved and final IPs, port, protocol, HTTP method, path, and the decoded
 *   request itself.
 *
 *   SSRF protections prevent requests that appear to target a public domain but
 *   resolve to an internal service.
 *
 * 这一步的重点不是"写个黑名单"，而是**检查的时机**。
 * SSRF 最容易被绕过的地方，是"解析 → 检查 → 再解析 → 连接"之间的时间差。
 *
 * 用到的技术（真实）
 *   - SSRF：服务端被诱导去访问自己内网/本机/云元数据的地址
 *   - 云元数据服务：169.254.169.254，拿到它等于拿到实例的临时凭据
 *   - IP 字面量的多种写法：十进制、八进制、十六进制、IPv4-mapped IPv6
 *   - DNS rebinding：同一个域名先后解析出不同 IP，绕过"先检查后连接"
 *
 *  本 demo 不需要网络：用的是可注入的解析器。真实实现会调用 dns.lookup。
 *
 * 运行：node code/step5-egress-ssrf.mjs
 */

const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))

// ══════════════════════════════════════════════════════════════════════
// 1. IP 分类 —— 判断一个地址是不是"内部"
// ══════════════════════════════════════════════════════════════════════
function classifyIp(ip) {
 // IPv4-mapped IPv6：::ffff:127.0.0.1 等价于 127.0.0.1
 // URL 解析器会把 [::ffff:127.0.0.1] 规范化成 ::ffff:7f00:1，两种写法都要认
 let v4 = ip
 const dotted = ip.match(/^::ffff:(\d+\.\d+\.[0-9]+\.[0-9]+)$/i)
 const hexed = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
 if (dotted) v4 = dotted[1]
 else if (hexed) {
   const hi = parseInt(hexed[1], 16)
   const lo = parseInt(hexed[2], 16)
   v4 = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.')
 }

 if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
   const [a, b] = v4.split('.').map(Number)
   if (a === 127) return 'loopback'
   if (a === 10) return 'private'
   if (a === 172 && b >= 16 && b <= 31) return 'private'
   if (a === 192 && b === 168) return 'private'
   if (a === 169 && b === 254) return 'link-local' // ← 云元数据在这里
   if (a === 0) return 'this-network'
   return 'public'
 }

 const lower = ip.toLowerCase()
 if (lower === '::1') return 'loopback'
 if (lower.startsWith('fc') || lower.startsWith('fd')) return 'private' // ULA
 if (lower.startsWith('fe80')) return 'link-local'
 return 'public'
}

/**
 * 2. 主机名规范化 —— 攻击者会用各种写法藏起一个 IP。
 *    这一步必须**先规范化再判断**。
 */
function normalizeHost(host) {
 const raw = host.replace(/^\[|\]$/g, '')

 // 纯数字（十进制 / 八进制 / 十六进制）都是 IPv4 的合法写法
 if (/^(0x[0-9a-f]+|\d+)$/i.test(raw)) {
   const n = Number(raw)
   if (Number.isInteger(n) && n >= 0 && n <= 0xffffffff) {
     return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
   }
 }
 // 形如 0x7f.1 的混合写法
 if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){1,3}$/i.test(raw)) {
   const parts = raw.split('.').map((p) => Number(p))
   if (parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)) {
     return parts.join('.')
   }
 }
 return raw
}

// ══════════════════════════════════════════════════════════════════════
// 3. 可注入的解析器 —— 用来演示 DNS rebinding
// ══════════════════════════════════════════════════════════════════════
class StubResolver {
 constructor(answers) {
   this.answers = answers
   this.calls = new Map()
 }
 async lookup(host) {
   const n = (this.calls.get(host) ?? 0) + 1
   this.calls.set(host, n)
   const list = this.answers[host] ?? ['93.184.216.34'] // 默认给个公网地址
   // 第 n 次解析返回第 n 个答案，用完就停在最后一个
   return [list[Math.min(n - 1, list.length - 1)]]
 }
}

/** 主机名本身就已经是一个 IP 字面量时，不需要查 DNS。 */
function isIpLiteral(host) {
 return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')
}

/**
 * 统一的解析入口。**字面量直接返回自己，只有真正的域名才去查 DNS。**
 * 这一步很容易被忽略：如果对字面量也查 DNS，检查的就变成了解析结果，
 * 而不是用户实际要连的地址。
 */
async function resolveHost(host, resolver) {
 const normalized = normalizeHost(host)
 if (isIpLiteral(normalized)) return [normalized]
 return resolver.lookup(normalized)
}

// ══════════════════════════════════════════════════════════════════════
// 4. 两个网关实现：一个天真，一个安全
// ══════════════════════════════════════════════════════════════════════
const connectionLog = []

/** 模拟一次 TCP 连接——它只知道"连到了哪个 IP" */
function tcpConnect(targetIp, host) {
 connectionLog.push({ host, connectedTo: targetIp })
 return { connectedTo: targetIp }
}

/**
 *  天真实现：解析 → 检查 → 再按域名连接。
 *    问题：第二次连接会**重新解析**，攻击者的 DNS 这时给出内网地址。
 *    这就是 classic DNS rebinding (TOCTOU)。
 */
async function naiveGateway(url, resolver) {
 const host = normalizeHost(new URL(url).hostname)
 const [ip] = await resolveHost(host, resolver)
 const kind = classifyIp(ip)
 if (kind !== 'public') return { blocked: true, reason: `检查时解析到 ${kind} (${ip})` }
 // ← 按【域名】连接，连接时内部会再解析一次
 const [secondIp] = await resolveHost(host, resolver)
 return { connection: tcpConnect(secondIp, host), checkedIp: ip, connectedIp: secondIp }
}

/**
 *  安全实现：解析**一次**，检查，然后连到那个被检查过的 IP。
 *    Host 头仍然带原域名，所以 TLS/虚拟主机不受影响。
 */
async function safeGateway(url, resolver) {
 const host = normalizeHost(new URL(url).hostname)
 const [ip] = await resolveHost(host, resolver) // ← 只解析这一次
 const kind = classifyIp(ip)
 if (kind !== 'public') return { blocked: true, reason: `解析到 ${kind} (${ip})`, checkedIp: ip }
 // 连的就是刚才检查过的那个 IP，没有第二次解析的机会
 return { connection: tcpConnect(ip, host), checkedIp: ip, connectedIp: ip }
}

// ══════════════════════════════════════════════════════════════════════
// 场景
// ══════════════════════════════════════════════════════════════════════
async function tryUrl(label, url, resolver, gateway) {
 const result = await gateway(url, resolver)
 say(1, `▸ ${label}`)
 say(2, `URL: ${url}`)
 if (result.blocked) {
   say(2, ` 阻断 — ${result.reason}`)
   if (result.checkedIp) say(2, `   检查时看到的 IP：${result.checkedIp}`)
 } else {
   say(2, `  放行 — 检查时 ${result.checkedIp}，实际连到 ${result.connectedIp}`)
 }
 return result
}

say(0, '═══ 第一部分：SSRF 的几种写法 ═══')
say(0, '')
const plain = new StubResolver({})
for (const [label, url] of [
 ['直连本机', 'http://127.0.0.1/admin'],
 ['云元数据服务（拿到它等于拿到实例凭据）', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
 ['十进制写法：127.0.0.1 = 2130706433', 'http://2130706433/admin'],
 ['十六进制写法：0x7f000001', 'http://0x7f000001/admin'],
 ['IPv4-mapped IPv6', 'http://[::ffff:127.0.0.1]/admin'],
 ['内网 10.x', 'http://10.0.0.7/internal'],
 ['正常的公网地址', 'https://api.github.com/user/repos'],
]) {
 await tryUrl(label, url, plain, safeGateway)
}

say(0, '')
say(0, '═══ 第二部分：DNS rebinding ═══')
say(0, '')
say(2, '攻击者控制 evil.example.com，让它这样解析：')
say(2, '  第 1 次 → 93.184.216.34（公网，检查能过）')
say(2, '  第 2 次 → 10.0.0.5（内网，真正的目标）')
say(0, '')

const rebinding = new StubResolver({ 'evil.example.com': ['93.184.216.34', '10.0.0.5'] })

const naiveResult = await tryUrl('天真实现：按域名连接', 'http://evil.example.com/steal', rebinding, naiveGateway)
say(2, `   → 检查通过，但连接时重新解析，实际连到了 ${naiveResult.connectedIp}`)
say(2, '    这就是 DNS rebinding：检查的是一个 IP，连的是另一个')

say(0, '')

const safeResult = await tryUrl('安全实现：连到检查过的那个 IP', 'http://evil.example.com/steal', rebinding, safeGateway)
say(2, `   → 检查的 IP 和连接的 IP 都是 ${safeResult.connectedIp}`)
say(2, '    攻击者的第二次解析没有机会生效')

say(0, '')
say(0, '═══ 连接日志（谁真的连到了哪里）═══')
for (const entry of connectionLog) {
 const kind = classifyIp(entry.connectedTo)
 const flag = kind === 'public' ? '' : ''
 say(1, `${flag} ${entry.host.padEnd(22)} → ${entry.connectedTo}  (${kind})`)
}

say(0, '')
say(0, '【这一章的核心】')
say(1, '不是"有没有做检查"，而是"**检查的和使用的是不是同一个东西**"。')
say(1, 'DNS rebinding 之所以能绕过一大堆 SSRF 防护，就是因为它攻击的是这个时间差。')
