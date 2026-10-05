/**
 * Step 8 — 状态机：模型只能解释状态，不能宣布状态。
 *
 * 官方原文（可观测性部分）：
 *   Muse surfaces a full activity audit trail, letting users see completed and
 *   planned actions.
 *
 * 一个 agent 的自然语言很容易把"我已经开始做了"说成"我做完了"。
 * 这不是模型在撒谎——它只是在生成最像答案的文本。
 * 所以"完成"必须由**执行系统**产生，而不是由**生成系统**断言。
 *
 * 用到的技术（真实）
 *   - 显式状态机：状态只能沿合法边迁移，非法迁移被拒绝
 *   - 权威来源分离（single source of truth）：状态在 runtime，不在对话里
 *   - 正交失败分类：超时 / 拒绝 / 基底死亡 是不同的事实，不能压成一个 catch
 *   - action identity：每个动作有稳定 id，审计轨迹才能串起来
 *
 * 运行：node code/step8-state-machine.mjs
 */

const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))

// ══════════════════════════════════════════════════════════════════════
// 执行层的状态机 —— 唯一能改状态的地方
// ══════════════════════════════════════════════════════════════════════
const LEGAL_TRANSITIONS = {
  queued: ['running', 'canceled'],
  running: ['waiting', 'completed', 'failed', 'canceled'],
  waiting: ['running', 'canceled', 'failed'], // ← waiting 不能直接到 completed
  completed: [], // 终态
  failed: [], // 终态
  canceled: [], // 终态
}

class ExecutionRuntime {
  #tasks = new Map()
  #nextId = 0

  /** 每个动作有稳定 id —— 审计轨迹靠它串起来 */
  createTask(label) {
    const id = `task_${++this.#nextId}`
    this.#tasks.set(id, {
      id,
      label,
      state: 'queued',
      authority: 'proposed',
      evidence: [],
      transitions: [{ to: 'queued', at: Date.now(), by: 'runtime' }],
    })
    return id
  }

  /** ★ 只有执行层能调这个方法。模型侧拿到的 facade 里没有它。 */
  transition(id, to, { by = 'runtime', evidence } = {}) {
    const task = this.#tasks.get(id)
    const allowed = LEGAL_TRANSITIONS[task.state]
    if (!allowed.includes(to)) {
      throw new Error(`非法迁移：${task.state} → ${to}（允许：${allowed.join('/') || '无，终态'}）`)
    }
    task.state = to
    task.transitions.push({ to, at: Date.now(), by })
    if (evidence) task.evidence.push(evidence)
    say(3, `[runtime] ${id} ${task.transitions.at(-2).to} → ${to}  (by=${by})`)
    return task
  }

  setAuthority(id, authority) {
    const task = this.#tasks.get(id)
    task.authority = authority
    say(3, `[runtime] ${id} authority = ${authority}`)
  }

  snapshot(id) {
    const t = this.#tasks.get(id)
    return { id: t.id, label: t.label, state: t.state, authority: t.authority, evidence: [...t.evidence] }
  }
}

// ══════════════════════════════════════════════════════════════════════
// 模型侧拿到的 facade —— 只读，不能改状态
// ══════════════════════════════════════════════════════════════════════
function modelFacadeFor(runtime, taskId) {
  return Object.freeze({
    /** 模型可以查状态，用它来组织语言 */
    describe: () => runtime.snapshot(taskId),
    /** 但没有任何 setState / transition / markCompleted */
  })
}

// ══════════════════════════════════════════════════════════════════════
// 渲染层：状态优先于模型的措辞
// ══════════════════════════════════════════════════════════════════════
function renderResponse(modelText, snapshot) {
  const claimLooksDone = /(已完成|完成了|已修复|修好了|已创建|建好了|做好了|改好了|done|completed|fixed)/.test(modelText)
  const actuallyDone = snapshot.state === 'completed'

  if (claimLooksDone && !actuallyDone) {
    return {
      corrected: true,
      text: `[已修正措辞] ${modelText}`,
      banner: `实际状态：${snapshot.state}${snapshot.authority === 'ask' ? '（等待用户批准）' : ''}`,
    }
  }
  return { corrected: false, text: modelText, banner: `状态：${snapshot.state}` }
}

// ══════════════════════════════════════════════════════════════════════
// 场景
// ══════════════════════════════════════════════════════════════════════
const runtime = new ExecutionRuntime()

function show(label, modelText, snapshot) {
  say(1, `▸ ${label}`)
  const out = renderResponse(modelText, snapshot)
  const icon = out.corrected ? '🛑' : '✅'
  say(2, `模型说：${modelText}`)
  say(2, `${icon} ${out.banner}`)
  say(2, `   呈现给用户：${out.text}`)
}

say(0, '【合法迁移图】')
for (const [from, tos] of Object.entries(LEGAL_TRANSITIONS)) {
  say(1, `${from.padEnd(10)} → ${tos.join(' / ') || '（终态）'}`)
}
say(0, '')

say(0, '── 情形 1：正常完成 ──')
{
  const id = runtime.createTask('修改 parseDate')
  const model = modelFacadeFor(runtime, id)
  runtime.setAuthority(id, 'allowed')
  runtime.transition(id, 'running')
  runtime.transition(id, 'completed', { evidence: { kind: 'tool_result', detail: 'patch applied' } })
  show('模型如实汇报', 'parseDate 的时区问题已修复', model.describe())
}

say(0, '')
say(0, '── 情形 2：工具失败，但模型说"改好了" ──')
{
  const id = runtime.createTask('修改 parseDate')
  const model = modelFacadeFor(runtime, id)
  runtime.setAuthority(id, 'allowed')
  runtime.transition(id, 'running')
  runtime.transition(id, 'failed', { evidence: { kind: 'error', detail: 'apply_patch: context mismatch' } })
  show('模型把失败说成了成功', 'parseDate 的时区问题已修复，测试都通过了', model.describe())
}

say(0, '')
say(0, '── 情形 3：还在等审批，模型说"已完成" ──')
{
  const id = runtime.createTask('给仓库建 issue')
  const model = modelFacadeFor(runtime, id)
  runtime.setAuthority(id, 'ask')
  runtime.transition(id, 'running')
  runtime.transition(id, 'waiting')
  show('模型抢跑', 'issue 已经创建完成了', model.describe())
}

say(0, '')
say(0, '── 情形 4：模型能不能自己宣布完成？ ──')
{
  const id = runtime.createTask('删除生产数据库')
  const model = modelFacadeFor(runtime, id)
  say(2, `模型 facade 暴露的方法：${Object.keys(model).join(', ') || '（无）'}`)
  say(2, `有没有 setState / transition / markCompleted？${['setState', 'transition', 'markCompleted'].some((m) => m in model) ? '有' : '没有'}`)
  say(2, '✅ 模型这一侧根本没有能改状态的接口——这是能力隔离，不是检查')
}

say(0, '')
say(0, '── 情形 5：非法迁移会被状态机拒绝 ──')
{
  const id = runtime.createTask('危险动作')
  runtime.transition(id, 'running')
  runtime.transition(id, 'failed')
  try {
    runtime.transition(id, 'completed')
    say(2, '❌ 竟然允许了')
  } catch (error) {
    say(2, `🛑 ${error.message}`)
    say(2, '   终态不能复活——否则"失败后被改写成成功"就成立了')
  }
}

say(0, '')
say(0, '── 情形 6：审计轨迹 ──')
{
  const id = runtime.createTask('读仓库并建 issue')
  runtime.setAuthority(id, 'allowed')
  runtime.transition(id, 'running')
  runtime.transition(id, 'waiting')
  runtime.setAuthority(id, 'ask')
  runtime.transition(id, 'running')
  runtime.transition(id, 'completed', { evidence: { kind: 'approval_receipt', detail: 'approval_7 by user' } })
  const snap = runtime.snapshot(id)
  say(2, `任务 ${snap.id} 的证据：`)
  for (const e of snap.evidence) say(3, `${e.kind}: ${e.detail}`)
  say(2, '每个动作都有稳定 id + 证据链，用户才能看到"完成了什么、计划做什么"')
}

say(0, '')
say(0, '【这一章的核心】')
say(1, '模型是**生成系统**，它输出的东西"最像答案"而不是"最接近事实"。')
say(1, '状态是**执行系统**的事实。两者必须分开，且渲染时以事实为准。')
