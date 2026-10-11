import { beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { createFakeAgent, createFakeCtx, fakeExec, sampleSaveArgs } from './helpers.js'

interface Env {
  ctx: Record<string, unknown>
  tools: Map<string, { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }>
  storage: Map<string, unknown>
  engineRequests: Record<string, unknown>[]
  engineQueue: unknown[]
  startedJobs: { spec: Record<string, unknown>; handle: { cancel: (reason?: string) => void; done: Promise<unknown> } }[]
  sessionEvents: [string, unknown][]
  warnings: string[]
  errors: string[]
  sections: unknown[]
  emit: (event: string, ...args: unknown[]) => void
  disposers: (() => Promise<void>)[]
  runDisposals: string[]
}

let env: Env

beforeEach(() => {
  env = createFakeCtx() as unknown as Env
  apply(env.ctx as never, undefined)
})

type RegisteredTool = { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }

/**
 * 调用一个已注册工具并返回其结果。测试统一经由这里触达工具，
 * 调用面（agent/parent/signal）与模型驱动路径保持一致。
 * agent 缺省时给一个带 session 的假父 agent（durable 记录落在 target.sessionEvents）。
 */
async function callTool(name: string, args: unknown, agent?: { id: string }, target: Env = env): Promise<unknown> {
  const registered: RegisteredTool | undefined = target.tools.get(name)
  if (registered === undefined) throw new Error(`tool "${name}" was not registered`)
  const actualAgent = agent ?? createFakeAgent(target.sessionEvents)
  const run = registered.execute.bind(registered)
  return await run(args, fakeExec(actualAgent))
}

/** 以"无调用 agent"的原始路径触发一次工具调用（exec.agent === undefined）。 */
async function callWithoutAgent(name: string, args: unknown): Promise<unknown> {
  const registered: RegisteredTool | undefined = env.tools.get(name)
  if (registered === undefined) throw new Error(`tool "${name}" was not registered`)
  const run = registered.execute.bind(registered)
  return await run(args, fakeExec(undefined))
}

/** 断言一次调用 reject 且消息匹配。 */
async function expectRejected(promise: Promise<unknown>, pattern: RegExp | string): Promise<void> {
  await expect(promise).rejects.toThrow(pattern)
}

describe('apply(): 注册面与让位纪律', () => {
  it('registers the fork tool and all five saved tools', () => {
    expect([...env.tools.keys()].sort()).toEqual([
      'workflow', 'workflow_delete', 'workflow_get', 'workflow_list', 'workflow_run_saved', 'workflow_save',
    ].sort())
  })

  it('the fork yields when the tool name is already taken; saved tools still register', () => {
    const env2 = createFakeCtx() as unknown as Env
    env2.tools.set('workflow', { name: 'workflow', execute: async () => ({}) })
    apply(env2.ctx as never, undefined)
    expect(env2.tools.has('workflow')).toBe(true)
    expect(env2.tools.has('workflow_save')).toBe(true)
    expect(env2.warnings.join('\n')).toMatch(/already registered by another plugin[\s\S]*standing by/)
  })

  it('a taken saved-tool name yields individually', () => {
    const env2 = createFakeCtx() as unknown as Env
    env2.tools.set('workflow_list', { name: 'workflow_list', execute: async () => ({}) })
    apply(env2.ctx as never, undefined)
    expect(env2.tools.has('workflow_save')).toBe(true)
    expect(env2.tools.has('workflow_list')).toBe(true)
    expect(env2.warnings.join('\n')).toMatch(/"workflow_list" is already registered/)
  })

  it('savedTools: false registers only the fork and skips the prompt section', () => {
    const env2 = createFakeCtx() as unknown as Env
    apply(env2.ctx as never, { savedTools: false })
    expect([...env2.tools.keys()]).toEqual(['workflow'])
    expect(env2.sections).toEqual([])
  })

  it('an invalid config disables the plugin with a warn', () => {
    const env2 = createFakeCtx() as unknown as Env
    apply(env2.ctx as never, { toolNmae: 'x' } as never)
    expect(env2.tools.size).toBe(0)
    expect(env2.warnings.join('\n')).toMatch(/tool-workflow-plus disabled/)
  })

  it('registers the saved-library system prompt section', () => {
    expect(env.sections).toHaveLength(1)
    expect(env.sections[0]).toMatchObject({ name: 'tool:workflow-saved-library' })
  })
})

describe('workflow_save', () => {
  it('stores the record with the meta.name key', async () => {
    const result = await callTool('workflow_save', sampleSaveArgs()) as { kind: string; name: string; overwritten: boolean }
    expect(result).toMatchObject({ kind: 'saved', name: 'code-audit', overwritten: false })
    const stored = env.storage.get('code-audit') as { meta: { name: string }; script: string }
    expect(stored.meta.name).toBe('code-audit')
    expect(stored.script).toContain('await agent')
  })

  it('refuses to overwrite without overwrite: true', async () => {
    await callTool('workflow_save', sampleSaveArgs())
    await expectRejected(callTool('workflow_save', sampleSaveArgs()), /already saved[\s\S]*overwrite: true/)
  })

  it('overwriting preserves createdAt and bumps updatedAt', async () => {
    await callTool('workflow_save', sampleSaveArgs())
    const first = env.storage.get('code-audit') as { createdAt: number; updatedAt: number }
    await new Promise(resolve => setTimeout(resolve, 5))
    const result = await callTool('workflow_save', sampleSaveArgs({ overwrite: true })) as { overwritten: boolean }
    const second = env.storage.get('code-audit') as { createdAt: number; updatedAt: number }
    expect(result.overwritten).toBe(true)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt)
  })

  it('rejects an invalid meta with the violation list', async () => {
    await expectRejected(callTool('workflow_save', {
      meta: { name: 'x', description: 'y', nope: 1 },
      script: 'return 1',
    }), /1 violation\(s\)[\s\S]*meta\.nope is not a recognized field/)
  })

  it('rejects a script carrying an export const meta block', async () => {
    await expectRejected(callTool('workflow_save', {
      meta: { name: 'x', description: 'y' },
      script: 'export const meta = { name: "x" }\nreturn 1',
    }), /export const meta/)
  })
})

describe('workflow_list / workflow_get / workflow_delete', () => {
  it('lists saved workflows most recently updated first, without script bodies', async () => {
    await callTool('workflow_save', sampleSaveArgs())
    await new Promise(resolve => setTimeout(resolve, 5))
    await callTool('workflow_save', sampleSaveArgs({ meta: { name: 'newer', description: 'Newer workflow' } }))
    const result = await callTool('workflow_list', {}) as {
      kind: string
      workflows: { name: string; phases: string[] }[]
    }
    expect(result.kind).toBe('list')
    expect(result.workflows.map(entry => entry.name)).toEqual(['newer', 'code-audit'])
    expect(JSON.stringify(result.workflows)).not.toContain('await agent')
    expect(result.workflows[1]!.phases).toEqual(['scan', 'verify'])
  })

  it('an empty library lists as an empty array', async () => {
    const result = await callTool('workflow_list', {}) as { workflows: unknown[] }
    expect(result.workflows).toEqual([])
  })

  it('get returns the full record; missing names point at workflow_list', async () => {
    await callTool('workflow_save', sampleSaveArgs())
    const record = await callTool('workflow_get', { name: 'code-audit' }) as {
      kind: string
      meta: { name: string }
      script: string
    }
    expect(record.kind).toBe('record')
    expect(record.meta.name).toBe('code-audit')
    expect(record.script).toContain('await agent')
    await expectRejected(callTool('workflow_get', { name: 'nope' }), /no saved workflow named "nope"[\s\S]*workflow_list/)
  })

  it('delete reports whether anything was deleted', async () => {
    await callTool('workflow_save', sampleSaveArgs())
    expect(await callTool('workflow_delete', { name: 'code-audit' })).toMatchObject({ kind: 'deleted', deleted: true })
    expect(await callTool('workflow_delete', { name: 'code-audit' })).toMatchObject({ kind: 'deleted', deleted: false })
  })
})

describe('workflow_run_saved', () => {
  it('runs the stored script and meta with fresh args through the engine', async () => {
    await callTool('workflow_save', sampleSaveArgs())
    const agent = createFakeAgent(env.sessionEvents)
    const result = await callTool('workflow_run_saved', { name: 'code-audit', args: { files: ['a.ts'] } }, agent) as {
      kind: string
      runId: string
      agentsStarted: number
      result: unknown
    }

    expect(result.kind).toBe('foreground')
    expect(result.agentsStarted).toBe(2)
    expect(result.result).toEqual({ ok: true })
    const request = env.engineRequests[0]!
    expect(request.script).toContain('await agent')
    expect(request.meta).toMatchObject({ name: 'code-audit' })
    expect(request.args).toEqual({ files: ['a.ts'] })
    expect(request.parent).toBe(agent)
    expect(request.signal).toBeDefined()
    expect(env.runDisposals).toContain(`dispose:${result.runId}`)
  })

  it('records the durable session run for top-level calls', async () => {
    await callTool('workflow_save', sampleSaveArgs())
    const agent = createFakeAgent(env.sessionEvents)
    await callTool('workflow_run_saved', { name: 'code-audit' }, agent)
    const types = env.sessionEvents.map(([type]) => type)
    expect(types[0]).toBe('tool-workflow/run-start')
    expect(types[types.length - 1]).toBe('tool-workflow/run-end')
    expect(env.sessionEvents[0]![1]).toMatchObject({ name: 'code-audit' })
  })

  it('rejects a missing workflow with a workflow_list hint', async () => {
    await expectRejected(callTool('workflow_run_saved', { name: 'ghost' }), /no saved workflow named "ghost"[\s\S]*workflow_list/)
  })

  it('maps an engine error stop reason to a tool error', async () => {
    await callTool('workflow_save', sampleSaveArgs())
    env.engineQueue.push({ stopReason: 'error', error: 'boom', agentsStarted: 0 })
    await expectRejected(callTool('workflow_run_saved', { name: 'code-audit' }), 'workflow run failed: boom')
    expect(env.runDisposals.some(entry => entry.startsWith('dispose:'))).toBe(true)
  })

  it('without ctx.jobs a background request fails naming the missing pieces', async () => {
    const env2 = createFakeCtx({ withJobs: false }) as unknown as Env
    apply(env2.ctx as never, undefined)
    await callTool('workflow_save', sampleSaveArgs(), { id: 'agent-1' }, env2)
    await expectRejected(
      callTool('workflow_run_saved', { name: 'code-audit', run_in_background: true }, { id: 'agent-1' }, env2),
      /background jobs unavailable/,
    )
  })

  it('a background run registers a job and lands the rendered outcome on the job', async () => {
    await callTool('workflow_save', sampleSaveArgs())
    // 让 run 挂起，模拟真实引擎的异步结算。
    let release!: (result: unknown) => void
    env.engineQueue.push(new Promise(resolve => {
      release = resolve
    }))
    const agent = createFakeAgent(env.sessionEvents)
    const executing = callTool('workflow_run_saved', { name: 'code-audit', run_in_background: true }, agent) as Promise<{ kind: string; jobId: string; runId: string }>

    // 等一个宏任务：store 懒打开 + 后台注册链在多个微任务后完成。
    await new Promise(resolve => setTimeout(resolve, 5))
    const started = env.startedJobs[0]
    expect(started).toBeDefined()
    expect(started!.spec).toMatchObject({ kind: 'workflow', label: 'code-audit', owner: 'agent-1' })

    release({ stopReason: 'completed', value: { done: true }, agentsStarted: 3 })
    const result = await executing
    expect(result.kind).toBe('background')
    expect(result.jobId).toBe('job-1')

    const outcome = await started!.handle.done as { status: string; detail: string; result: string }
    expect(outcome.status).toBe('completed')
    expect(outcome.detail).toBe('3 agents')
    expect(outcome.result).toContain('workflow "code-audit" completed (3 agents)')
  })
})

describe('fork workflow tool', () => {
  it('runs foreground and passes the caller signal into the engine request', async () => {
    const agent = createFakeAgent(env.sessionEvents)
    const result = await callTool('workflow', sampleSaveArgs(), agent) as { kind: string; result: unknown }
    expect(result.kind).toBe('foreground')
    expect(result.result).toEqual({ ok: true })
    const request = env.engineRequests[0]!
    expect(request.meta).toMatchObject({ name: 'code-audit' })
    expect(request.script).toContain('await agent')
  })

  it('runs background via ctx.jobs', async () => {
    const agent = createFakeAgent(env.sessionEvents)
    const result = await callTool('workflow', { ...sampleSaveArgs(), run_in_background: true }, agent) as {
      kind: string
      jobId: string
    }
    expect(result.kind).toBe('background')
    expect(result.jobId).toBe('job-1')
  })

  it('rejects a background run when enableRunInBackground is false', async () => {
    const env2 = createFakeCtx() as unknown as Env
    apply(env2.ctx as never, { enableRunInBackground: false })
    await expectRejected(
      callTool('workflow', { ...sampleSaveArgs(), run_in_background: true }, { id: 'agent-1' }, env2),
      /run_in_background is disabled/,
    )
    expect(env2.tools.has('workflow_run_saved')).toBe(true)
  })

  it('requires a calling agent', async () => {
    await expectRejected(callWithoutAgent('workflow', sampleSaveArgs()), /requires a calling agent/)
    await expectRejected(callWithoutAgent('workflow_run_saved', { name: 'code-audit' }), /requires a calling agent/)
  })
})

describe('storage 栈缺失的降级', () => {
  it('saved tool calls fail naming the missing pieces; activation is unaffected', async () => {
    const env2 = createFakeCtx({ withStorage: false }) as unknown as Env
    apply(env2.ctx as never, undefined)
    expect(env2.tools.size).toBe(6)
    await expectRejected(
      callTool('workflow_save', sampleSaveArgs(), { id: 'agent-1' }, env2),
      /saved workflow storage unavailable[\s\S]*dsh-storage-domain/,
    )
  })
})

describe('fiber 销毁', () => {
  it('the effect disposer closes the storage domain', async () => {
    await callTool('workflow_save', sampleSaveArgs())
    expect(env.disposers).toHaveLength(1)
    await env.disposers[0]!()
    // close 是幂等的 fake；重复调用不应抛错。
    await env.disposers[0]!()
  })
})
