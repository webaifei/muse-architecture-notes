/**
 * 实验：一个"看起来没问题"的权限检查，能被绕过几层。
 *
 * 结论提前说：每修好一层，就多出一个要修的地方。
 * 这条路没有尽头，因为检查函数住在被检查者旁边。
 *
 * 运行：node code/step0-checks-fail.mjs
 */

import {
  readFileSync, writeFileSync, realpathSync, unlinkSync, symlinkSync, mkdirSync, rmSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))
const blank = () => console.log()

// ── 搭一个实验场地 ────────────────────────────────────────────────────
const BASE = '/tmp/muse-check-experiment'
rmSync(BASE, { recursive: true, force: true })
mkdirSync(join(BASE, 'workspace'), { recursive: true })

// 目录建好之后再解析。macOS 上 /tmp 是 /private/tmp 的符号链接，
// 不解析的话后面比对路径会全部对不上。
const ROOT = realpathSync(BASE)
const WORKSPACE = join(ROOT, 'workspace')
const SECRET = join(ROOT, 'secret.txt')

writeFileSync(SECRET, 'ghp_REAL_SECRET_TOKEN_abc123\n')
writeFileSync(join(WORKSPACE, 'readme.txt'), '这是工作区里的公开文件\n')
symlinkSync(SECRET, join(WORKSPACE, 'innocent-link.txt'))

const leaked = (text) => String(text ?? '').includes('SECRET')

// ══════════════════════════════════════════════════════════════════════
// 第一版：最直觉的写法，解析路径看它是不是以工作区开头
// ══════════════════════════════════════════════════════════════════════
say(0, '=== 第一版：前缀匹配 ===')
blank()
for (const input of ['readme.txt', '../secret.txt', 'innocent-link.txt']) {
  const full = resolve(WORKSPACE, input)
  const passed = full.startsWith(WORKSPACE)
  let content = null
  if (passed) {
    try { content = readFileSync(full, 'utf8').trim() } catch {}
  }
  say(0, `输入 ${input}`)
  say(1, `检查 ${passed ? '通过' : '拒绝'}`)
  say(1, `读到 ${content ?? '（无）'}`)
  if (leaked(content)) say(1, '【机密泄露】')
  blank()
}
say(0, '路径穿越被挡住了，因为 resolve 会先把 .. 消掉。')
say(0, '符号链接没挡住。路径字符串确实在工作区里，但它的目标在外面。')
blank()

// ══════════════════════════════════════════════════════════════════════
// 第二版：先把符号链接解开，再比对
// ══════════════════════════════════════════════════════════════════════
say(0, '=== 第二版：先解析真实路径 ===')
blank()
{
  const link = join(WORKSPACE, 'innocent-link.txt')
  const real = realpathSync(link)
  say(0, '输入 innocent-link.txt')
  say(1, `前缀匹配       ${link.startsWith(WORKSPACE) ? '通过，然后泄露' : '拒绝'}`)
  say(1, `真实路径解析   ${real.startsWith(WORKSPACE) ? '通过' : '拒绝'}`)
  say(1, `真实路径是     ${real}`)
  blank()
  say(0, '这一层修好了。但只修好了这一层。')
}
blank()

// ══════════════════════════════════════════════════════════════════════
// 第三版：检查通过了，但打开之前文件被换掉
// ══════════════════════════════════════════════════════════════════════
const slot = join(WORKSPACE, 'slot.txt')

/** 检查完到真正打开之间，有一段真实存在的时间差 */
function safeOpen(pathInWorkspace, { betweenCheckAndOpen } = {}) {
  const full = join(WORKSPACE, pathInWorkspace)
  if (!realpathSync(full).startsWith(WORKSPACE)) {
    return { blocked: true, reason: '真实路径跳出工作区' }
  }
  betweenCheckAndOpen?.() // ← 攻击窗口
  return { content: readFileSync(full, 'utf8').trim() }
}

say(0, '=== 第三版：检查之后，打开之前 ===')
blank()

writeFileSync(slot, '无害内容\n')
say(0, '正常情况')
say(1, `读到 ${safeOpen('slot.txt').content}`)
blank()

say(0, '被攻击时')
const attacked = safeOpen('slot.txt', {
  betweenCheckAndOpen() {
    unlinkSync(slot)
    symlinkSync(SECRET, slot)
  },
})
say(1, `读到 ${attacked.content}`)
if (leaked(attacked.content)) say(1, '【检查通过，读到的却是机密】')
blank()

// ══════════════════════════════════════════════════════════════════════
// 第四层不是漏洞，是结构问题
// ══════════════════════════════════════════════════════════════════════
say(0, '=== 还有第四层，但这一层不是漏洞 ===')
blank()
say(0, '上面两个漏洞都能修，修法也都有名字，查得到。')
say(0, '真正的问题是：这些检查代码，跑在 agent 自己的进程里。')
blank()
say(1, '策略表是内存里的一个变量     agent 读得到，也改得掉')
say(1, '解析路径用的是同一套 API     agent 能替换掉那个函数')
say(1, '检查函数本身就是一段代码     agent 能绕过它，直接调底层')
blank()
say(0, '每修一层，就多出一层要守着。守卫住在被看守的人隔壁。')
blank()
say(0, 'Muse 换了个思路：不修检查，让 agent 那一侧根本够不着。')
blank()

rmSync(BASE, { recursive: true, force: true })
