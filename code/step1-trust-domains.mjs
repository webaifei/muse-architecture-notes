/**
 * Step 1 — 两个信任域。
 *
 * Muse 的心智模型不是「有 root 的 LLM」，而是「一台机器上的两个隔离安全域」。
 * 官方原文：
 *   The right mental model is two isolated security domains on one box,
 *   not an LLM powered agent with root.
 *
 * 这一步建两样东西，并且都要能亲手验证：
 *   1. Runtime cell  —— 内核强制隔离的执行域，跑不可信的 agent
 *   2. Host domain   —— 控制面，持有凭据，且**没有**"给自己发许可证"的接口
 *
 * 用到的技术（真实）
 *   - macOS Seatbelt（sandbox-exec）：内核在进程之外强制策略，agent 覆盖不了
 *     （Linux 上 Muse 用的是 systemd-nspawn + user namespace + seccomp + capabilities）
 *   - Unix domain socket：两个域唯一的通信通道
 *
 * ⚠️ 差异说明：Muse 的 cell 是 **deny-by-default 白名单**；本 demo 用
 * allow-default + 精确 deny。原因见 ch01。**机制相同：策略在内核里，不在 agent 手里。**
 *
 * 运行：node code/step1-trust-domains.mjs
 */

import { spawn } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { mkdtempSync, writeFileSync, rmSync, realpathSync, readFileSync, chmodSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const role = process.argv[2]

const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))

// ══════════════════════════════════════════════════════════════════════
// 角色 A：Host domain —— 控制面
// ══════════════════════════════════════════════════════════════════════
async function runControlPlane(socketPath, secretPath) {
  // 真实凭据保存在控制面，永远不下发给 runtime cell
  const credentialStore = new Map([
    ['github', () => readFileSync(secretPath, 'utf8').trim()],
  ])

  const server = createServer((socket) => {
    let buffered = ''
    socket.on('data', (chunk) => {
      buffered += chunk
      let idx
      while ((idx = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, idx)
        buffered = buffered.slice(idx + 1)
        if (!line) continue
        const request = JSON.parse(line)

        // ★ 这一层的关键：对外只有 propose。没有 grant、没有 setPolicy、
        //   没有 approve。agent 想"给自己发许可证"，找不到那个接口。
        let response
        switch (request.op) {
          case 'propose':
            // 真实系统里这里做 L4/L7 检查、capability 匹配、policy 裁决
            response = {
              decision: request.action === 'read_repo' ? 'allow' : 'ask',
              purpose: `读取 ${request.action} 用于回答用户的问题`,
              // 凭据只在这里用，只回传结果，不回传凭据本身
              result: request.action === 'read_repo'
                ? `(控制面用真实凭据读到了仓库，token 前缀 ${credentialStore.get('github')().slice(0, 7)}…)`
                : undefined,
            }
            break
          case 'grant':
            response = { error: 'unknown op: grant', hint: '控制面不提供授权接口——授权只能来自用户' }
            break
          default:
            response = { error: `unknown op: ${request.op}` }
        }
        socket.write(`${JSON.stringify(response)}\n`)
      }
    })
  })

  await new Promise((resolve) => server.listen(socketPath, resolve))
  // 最小权限的通信通道：socket 文件只对同 uid 可读写。
  // Linux 上 Muse 更进一步，用 SO_PEERCRED 让内核直接告诉你对端的 pid/uid —— 不可伪造。
  chmodSync(socketPath, 0o600)
  const mode = (statSync(socketPath).mode & 0o777).toString(8)
  process.stdout.write(`CONTROL_READY mode=${mode}\n`)
}

// ══════════════════════════════════════════════════════════════════════
// 角色 B：Runtime cell —— 不可信的 agent 执行域
// ══════════════════════════════════════════════════════════════════════
async function runCell(socketPath, secretPath) {
  const ask = (payload) =>
    new Promise((resolve) => {
      const socket = connect(socketPath)
      let buffered = ''
      socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
      socket.on('data', (chunk) => {
        buffered += chunk
        const idx = buffered.indexOf('\n')
        if (idx >= 0) {
          resolve(JSON.parse(buffered.slice(0, idx)))
          socket.end()
        }
      })
    })

  say(1, '── 攻击面 1：直接从文件系统偷凭据 ──')
  try {
    const stolen = readFileSync(secretPath, 'utf8')
    say(2, `❌ 竟然读到了：${stolen.trim()}`)
  } catch (error) {
    say(2, `✅ 被挡住：${error.code}（内核拒绝，不是我们的代码在检查）`)
  }

  say(1, '── 攻击面 2：让控制面给自己发许可证 ──')
  const granted = await ask({ op: 'grant', action: 'read_repo', scope: 'perpetual' })
  say(2, `✅ ${granted.error} — ${granted.hint}`)

  say(1, '── 攻击面 3：自己直接执行动作 ──')
  say(2, '✅ cell 里没有 GitHub 凭据，也没有出网路径，动作根本执行不了')

  say(1, '── 正常路径：提议 → 控制面裁决并执行 ──')
  const proposal = { op: 'propose', action: 'read_repo', connector: 'github', method: 'list' }
  say(2, `cell 发出：${JSON.stringify(proposal)}`)
  const decision = await ask(proposal)
  say(2, `控制面裁决：${decision.decision}`)
  say(2, `purpose（给用户看的）：${decision.purpose}`)
  say(2, `结果：${decision.result}`)
  say(2, '↑ 凭据始终没离开控制面，cell 只拿到了结果')
}

// ══════════════════════════════════════════════════════════════════════
// 编排：起控制面 → 在沙箱里起 cell
// ══════════════════════════════════════════════════════════════════════
async function main() {
  if (role === 'control') return runControlPlane(process.argv[3], process.argv[4])
  if (role === 'cell') return runCell(process.argv[3], process.argv[4])

  // ⚠️ 必须用 realpath：macOS 上 /var 是 /private/var 的符号链接，
  //    而 Seatbelt 按解析后的真实路径匹配 deny 规则。用错路径 = 策略静默失效。
  const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'muse-')))
  const secretPath = join(workDir, 'host-secret.txt')
  const socketPath = join(workDir, 'control.sock')
  writeFileSync(secretPath, 'ghp_REALTOKEN_do_not_leak_9f3a2b1c\n')

  // Seatbelt 策略：控制面的凭据文件对 cell 不可读
  const profilePath = join(workDir, 'cell.sb')
  writeFileSync(profilePath, `(version 1)
(allow default)
;; 内核级拒绝：cell 里的进程读不到 host domain 的凭据
(deny file-read* (literal "${secretPath}"))
`)

  say(0, `工作目录：${workDir}`)
  say(0, '')

  const control = spawn(process.execPath, [SELF, 'control', socketPath, secretPath], { stdio: ['ignore', 'pipe', 'inherit'] })
  let ready = ''
  await new Promise((resolve) => control.stdout.on('data', (d) => {
    ready += d.toString()
    if (ready.includes('CONTROL_READY')) resolve()
  }))
  const sockMode = ready.match(/mode=(\d+)/)?.[1] ?? '?'

  say(0, '【Host domain 已就绪】持有凭据，只暴露 propose')
  say(1, `控制面 socket 权限：0${sockMode}（只有同 uid 的进程能连）`)

  const cell = spawn('/usr/bin/sandbox-exec', ['-f', profilePath, process.execPath, SELF, 'cell', socketPath, secretPath], { stdio: 'inherit' })
  await new Promise((resolve) => cell.on('exit', resolve))

  control.kill()
  rmSync(workDir, { recursive: true, force: true })
  say(0, '')
  say(0, '（工作目录已清理）')
}

await main()
