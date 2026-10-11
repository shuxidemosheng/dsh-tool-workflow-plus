/**
 * 测试共用打桩环境：不 mock 内部实现，只提供 cordis ctx 的服务面
 * （tools / workflowEngine / systemPrompt / storageDomain / jobs / effect / on / get），
 * 让 apply() 与工具 execute() 走真实代码路径。
 */

export function createFakeCtx(overrides: {
  withJobs?: boolean
  withStorage?: boolean
} = {}): {
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
} {
  const tools = new Map()
  const rows = new Map<string, unknown>()
  const engineRequests: Record<string, unknown>[] = []
  const engineQueue: unknown[] = []
  const startedJobs: { spec: Record<string, unknown>; handle: { cancel: (reason?: string) => void; done: Promise<unknown> } }[] = []
  const sessionEvents: [string, unknown][] = []
  const warnings: string[] = []
  const errors: string[] = []
  const sections: unknown[] = []
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const disposers: (() => Promise<void>)[] = []
  const runDisposals: string[] = []

  const emit = (event: string, ...args: unknown[]): void => {
    for (const handler of listeners.get(event) ?? []) handler(...args)
  }

  // 内存版 KvTable 打桩（storage 域 KV 表的同形假身；纯 Map，无任何 SQL 面）。
  // rows 同时作为 storage 导出，测试直接断言其中的记录。
  const fakeTable = {
    get: (key: string) => rows.get(key),
    *entries(): Generator<[string, unknown]> {
      for (const [key, value] of rows) yield [key, value] as [string, unknown]
    },
    *keys(): Generator<string> {
      for (const key of rows.keys()) yield key
    },
    get size() {
      return rows.size
    },
    put: async (key: string, value: unknown) => {
      rows.set(key, value)
    },
    ...(() => {
      // KvTable 契约要求方法名 delete；这里以动态赋值提供同形假身。
      const drop = async (key: string): Promise<boolean> => {
        const existed = rows.has(key)
        if (existed) rows.delete(key)
        return existed
      }
      return { delete: drop }
    })(),
    update: async (key: string, fn: (current: unknown) => unknown) => {
      const current = rows.get(key)
      if (current === undefined) throw new Error('missing-key')
      const next = fn(current)
      rows.set(key, next)
      return next
    },
  }

  const fakeDomain = {
    name: 'workflow_saved',
    table: (_name: string) => fakeTable,
    close: async () => {},
  }

  const ctx: Record<string, unknown> = {
    logger: {
      warn: (message: string) => warnings.push(message),
      error: (message: string) => errors.push(message),
      info: (message: string) => warnings.push(`[info] ${message}`),
    },
    tools: {
      get: (toolName: string) => tools.get(toolName),
      register: (tool: { name: string }) => {
        if (tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`)
        tools.set(tool.name, tool as never)
      },
    },
    workflowEngine: {
      start: (request: Record<string, unknown>) => {
        engineRequests.push(request)
        const id = `run-${engineRequests.length}`
        const settled = engineQueue.length > 0 ? engineQueue.shift() : { stopReason: 'completed', value: { ok: true }, agentsStarted: 2 }
        return {
          id,
          meta: request.meta,
          result: typeof settled === 'function' ? (settled as (r: Record<string, unknown>) => unknown)(request) : Promise.resolve(settled),
          cancel: (reason?: string) => runDisposals.push(`cancel:${reason ?? ''}`),
          dispose: async () => {
            runDisposals.push(`dispose:${id}`)
          },
        }
      },
    },
    systemPrompt: {
      section: (input: unknown) => sections.push(input),
      getSectionOrder: (_name: string) => 42,
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    get: (name: string) => {
      if (name === 'jobs') return overrides.withJobs === false ? undefined : {
        start: (spec: Record<string, unknown>) => {
          const job = {
            updateProgress: () => {},
            append: () => {},
            __job: true,
          }
          const handle = (spec.run as (job: unknown) => { cancel: (reason?: string) => void; done: Promise<unknown> })(job)
          startedJobs.push({ spec, handle })
          return `job-${startedJobs.length}`
        },
      }
      if (name === 'storageDomain') {
        return overrides.withStorage === false
          ? undefined
          : { open: async (_spec: unknown) => fakeDomain }
      }
      return undefined
    },
    effect: (_factory: () => Generator, _label: string) => {
      disposers.push(async () => {
        for (const disposer of _factory()) {
          await (disposer as Promise<void>)
        }
      })
    },
  }

  return {
    ctx, tools, storage: rows, engineRequests, engineQueue, startedJobs,
    sessionEvents, warnings, errors, sections, emit, disposers, runDisposals,
  }
}

/** 一个带 session 的假父 agent（recorder 往 session.append 写 durable 事件）。 */
export function createFakeAgent(sessionEvents: [string, unknown][]): { id: string; session: { append: (type: string, data: unknown) => void } } {
  return {
    id: 'agent-1',
    session: {
      append: (type: string, data: unknown) => {
        sessionEvents.push([type, data])
      },
    },
  }
}

/** 一个模型驱动的 execute 上下文（parent 缺省 undefined → 顶层调用，记录 run）。 */
export function fakeExec(agent: { id: string } | undefined, options: { parent?: string; signal?: AbortSignal } = {}): Record<string, unknown> {
  return {
    callId: 'call-1',
    name: 'workflow',
    arguments: {},
    token: 'tok-1',
    rootCallId: undefined,
    agent,
    parent: options.parent,
    signal: options.signal ?? new AbortController().signal,
    deferContext: () => {},
    concludeTurn: () => {},
  }
}

/** 一条可直接保存的样例工作流参数。 */
export function sampleSaveArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: {
      name: 'code-audit',
      description: 'Audit many files with adversarial verification',
      whenToUse: 'when a broad audit is asked for',
      phases: [{ title: 'scan' }, { title: 'verify' }],
    },
    script: 'const findings = await agent("audit")\nreturn findings',
    ...overrides,
  }
}
