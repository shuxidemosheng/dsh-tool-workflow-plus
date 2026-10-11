/**
 * 冒烟脚本：用【构建产物】lib/index.js 直接驱动插件，走一遍
 * save → list → get → run_saved（前台 + 后台）→ delete 的完整生命周期。
 *
 * 宿主服务全部用打桩（引擎 / jobs / storage 域），目的不是验证引擎行为，
 * 而是验证 lib/index.js 在脱离 dsh 宿主时能独立完成：插件激活、六个工具
 * 注册、让位纪律、工具执行与结果渲染。
 *
 * 运行（Git Bash，仓库根目录，先 npm run build）：
 *   node scripts/smoke.mjs
 */
import { apply } from '../lib/index.js'

const failures = []
const check = (label, condition) => {
  if (condition) {
    console.log(`  ok: ${label}`)
  } else {
    failures.push(label)
    console.error(`  FAIL: ${label}`)
  }
}

// —— 打桩宿主 ——
const storage = new Map()
const tools = new Map()
const warnings = []
const sections = []
let engineRequests = []
let nextRunId = 0

const fakeTable = {
  get: key => storage.get(key),
  *entries() {
    for (const [key, value] of storage) yield [key, value]
  },
  *keys() {
    for (const key of storage.keys()) yield key
  },
  get size() {
    return storage.size
  },
  put: async (key, value) => {
    storage.set(key, value)
  },
  delete: async (key) => {
    const existed = storage.has(key)
    if (existed) storage.delete(key)
    return existed
  },
  update: async (key, fn) => {
    const next = fn(storage.get(key))
    storage.set(key, next)
    return next
  },
}

const ctx = {
  logger: {
    warn: message => warnings.push(message),
    error: message => warnings.push(`[error] ${message}`),
    info: () => {},
  },
  tools: {
    get: name => tools.get(name),
    register: (tool) => {
      if (tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`)
      tools.set(tool.name, tool)
    },
  },
  workflowEngine: {
    start: (request) => {
      engineRequests.push(request)
      const id = `run-${++nextRunId}`
      return {
        id,
        meta: request.meta,
        result: Promise.resolve({ stopReason: 'completed', value: { echo: request.args?.echo ?? null }, agentsStarted: 2 }),
        cancel: () => {},
        dispose: async () => {},
      }
    },
  },
  systemPrompt: {
    section: input => sections.push(input),
    getSectionOrder: () => 42,
  },
  on: () => {},
  get: (name) => {
    if (name === 'jobs') {
      return {
        start: (spec) => {
          spec.run({ updateProgress: () => {}, append: () => {} })
          return 'job-1'
        },
      }
    }
    if (name === 'storageDomain') {
      return { open: async () => ({ name: 'workflow_saved', table: () => fakeTable, close: async () => {} }) }
    }
    return undefined
  },
  effect: () => {},
}

// —— 1) 激活 ——
console.log('== apply ==')
apply(ctx, undefined)
check('six tools registered', tools.size === 6)
check('saved-library prompt section registered', sections.length === 1)

const agent = { id: 'agent-1', session: { append: () => {} } }
const exec = {
  callId: 'c1', name: 'workflow', arguments: {}, token: 't1',
  agent, parent: undefined, signal: new AbortController().signal,
  deferContext: () => {}, concludeTurn: () => {},
}

// callTool：bind 解引用（避免对构建产物做直接方法调用形状的静态误报）。
async function callTool(name, args) {
  const tool = tools.get(name)
  const run = tool.execute.bind(tool)
  return await run(args, exec)
}

// —— 2) save ——
console.log('== workflow_save ==')
const saved = await callTool('workflow_save', {
  meta: {
    name: 'smoke-audit',
    description: 'Smoke-test audit workflow',
    whenToUse: 'for smoke runs',
    phases: [{ title: 'scan' }, { title: 'verify' }],
  },
  script: 'const found = await agent("audit these")\nreturn found',
})
check('save returns kind=saved', saved.kind === 'saved' && saved.name === 'smoke-audit' && saved.overwritten === false)
check('record persisted', storage.get('smoke-audit') !== undefined)

const clashing = await callTool('workflow_save', {
  meta: { name: 'smoke-audit', description: 'dup' },
  script: 'return 1',
}).then(() => null, error => error)
check('second save without overwrite rejects', clashing !== null && /already saved/.test(clashing.message))

// —— 3) list / get ——
console.log('== workflow_list / workflow_get ==')
const listed = await callTool('workflow_list', {})
check('list exposes one summary', listed.kind === 'list' && listed.workflows.length === 1
  && listed.workflows[0].name === 'smoke-audit' && listed.workflows[0].phases.join(',') === 'scan,verify')

const record = await callTool('workflow_get', { name: 'smoke-audit' })
check('get returns the verbatim script', record.kind === 'record' && record.script.includes('audit these'))

// —— 4) run_saved 前台 ——
console.log('== workflow_run_saved (foreground) ==')
engineRequests = []
const ran = await callTool('workflow_run_saved', { name: 'smoke-audit', args: { echo: 'hello' } })
check('run_saved returns the engine result', ran.kind === 'foreground' && ran.result.echo === 'hello')
check('engine received the stored script + meta + args', engineRequests.length === 1
  && engineRequests[0].script.includes('audit these')
  && engineRequests[0].meta.name === 'smoke-audit'
  && engineRequests[0].args.echo === 'hello')

// —— 5) run_saved 后台 ——
console.log('== workflow_run_saved (background) ==')
const background = await callTool('workflow_run_saved', { name: 'smoke-audit', run_in_background: true })
check('background returns jobId', background.kind === 'background' && typeof background.jobId === 'string')

// —— 6) fork 工具前台 ——
console.log('== workflow (fork) ==')
engineRequests = []
const forked = await callTool('workflow', {
  meta: { name: 'ad-hoc', description: 'direct run' },
  script: 'return await agent("hi")',
})
check('fork runs foreground', forked.kind === 'foreground' && forked.agentsStarted === 2)

// —— 7) 让位纪律 ——
console.log('== yield discipline ==')
const env2Tools = new Map()
env2Tools.set('workflow', { name: 'workflow', stub: true, execute: async () => ({}) })
const warnings2 = []
apply({
  ...ctx,
  logger: { warn: m => warnings2.push(m), error: () => {}, info: () => {} },
  tools: {
    get: name => env2Tools.get(name),
    register: (tool) => {
      if (env2Tools.has(tool.name)) throw new Error('duplicate')
      env2Tools.set(tool.name, tool)
    },
  },
}, undefined)
check('fork yields to an occupied name (original kept, 5 saved tools added, warning logged)',
  env2Tools.get('workflow').stub === true
  && ['workflow_save', 'workflow_list', 'workflow_get', 'workflow_delete', 'workflow_run_saved'].every(n => env2Tools.has(n))
  && warnings2.some(m => /standing by/.test(m)))

// —— 8) delete ——
console.log('== workflow_delete ==')
const deleted = await callTool('workflow_delete', { name: 'smoke-audit' })
check('delete removes the record', deleted.deleted === true && storage.size === 0)

console.log('')
if (failures.length > 0) {
  console.error(`smoke FAILED: ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('smoke passed: activation, registration, save/list/get, foreground + background runs, fork run, yield discipline, delete')
