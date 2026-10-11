/**
 * run 生命周期设施：从官方 @deepseek-ai/dsh-tool-workflow 0.2.1-alpha.2 的
 * index.ts / record.ts 逐字移植（微调仅限入参形状与文案拼接点），包括：
 *
 *  - createWorkflowRecorder：把顶层 run 投影进父 Session 的 durable 记录
 *    （`tool-workflow/*` 事件；官方 UI 靠它们折叠 workflow-run 节点）；
 *  - createWorkflowRecordMirror：后台 run 的进度镜像（引擎 workflow/* 事件 →
 *    所属 job 的输出环）；
 *  - stopReasonError / renderResult / jobOutcomeOf / startBackgroundRun：
 *    前台等待与后台 job 注册的完整生命周期。
 *
 * 移植而非 import：官方包只导出 apply()，内部件不外露；逐字移植保证 fork
 * 的 run 行为与官方可观察面完全一致（同样的事件、同样的错误文案、同样的
 * job outcome 映射）。
 *
 * @module dsh-tool-workflow-plus/lifecycle
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobHandle, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { Session, SessionEventMap } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  WorkflowMeta, WorkflowResult, WorkflowRun, WorkflowRunId, WorkflowStopReason,
} from '@deepseek-ai/dsh-workflow'
import type {
  ToolWorkflowAgentEndData, ToolWorkflowAgentStartData,
  ToolWorkflowRunEndData, ToolWorkflowRunStartData,
} from './types.js'

/** 一次 run 启动请求里来自模型调用的部分（引擎请求去掉 parent/signal）。 */
export interface RunArgs {
  script: string
  meta: WorkflowMeta
  args?: Record<string, unknown>
  run_in_background?: boolean
}

/** durable 记录 taps：fork 工具与 workflow_run_saved 共用。 */
export interface WorkflowRecorder {
  start(session: Session, run: WorkflowRun): void
  finish(runId: WorkflowRunId, stopReason: WorkflowStopReason): void
  abandon(runId: WorkflowRunId): void
}

interface ToolWorkflowRecordEventMap {
  'tool-workflow/run-start': ToolWorkflowRunStartData
  'tool-workflow/agent-start': ToolWorkflowAgentStartData
  'tool-workflow/agent-end': ToolWorkflowAgentEndData
  'tool-workflow/run-end': ToolWorkflowRunEndData
}

/** Render a contained recording failure without trusting the thrown value. */
function renderRecordingError(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/**
 * Project active top-level workflow runs into their parent Sessions without
 * letting recording failure affect tool execution.
 */
export function createWorkflowRecorder(ctx: Context): WorkflowRecorder {
  const active = new Map<WorkflowRunId, Session>()
  const append = <Type extends keyof ToolWorkflowRecordEventMap>(
    session: Session,
    type: Type,
    data: SessionEventMap[Type],
  ): boolean => {
    // These four package-owned events are all log-only. Narrowing the generic
    // append face here discharges Session.append's conditional options tuple.
    const appendRecord = session.append.bind(session) as <Event extends keyof ToolWorkflowRecordEventMap>(
      event: Event,
      value: SessionEventMap[Event],
    ) => void
    try {
      appendRecord(type, data)
      return true
    } catch (error: unknown) {
      ctx.logger.warn(`tool-workflow-plus: disabled durable record after ${type} append failed: ${renderRecordingError(error)}`)
      return false
    }
  }

  ctx.on('workflow/agent-start', (info, agent) => {
    const session = active.get(info.id)
    if (session === undefined) return
    const data: ToolWorkflowAgentStartData = {
      runId: info.id,
      seq: agent.seq,
      label: agent.label,
      ...agent.phase === undefined ? {} : { phase: agent.phase },
      childId: agent.childId,
    }
    if (!append(session, 'tool-workflow/agent-start', data)) active.delete(info.id)
  })
  ctx.on('workflow/agent-end', (info, agent) => {
    const session = active.get(info.id)
    if (session === undefined) return
    const data: ToolWorkflowAgentEndData = {
      runId: info.id,
      seq: agent.seq,
      outcome: agent.outcome,
    }
    if (!append(session, 'tool-workflow/agent-end', data)) active.delete(info.id)
  })

  return {
    start(session, run) {
      if (append(session, 'tool-workflow/run-start', { runId: run.id, name: run.meta.name })) {
        active.set(run.id, session)
      }
    },
    finish(runId, stopReason) {
      const session = active.get(runId)
      if (session !== undefined) append(session, 'tool-workflow/run-end', { runId, stopReason })
      active.delete(runId)
    },
    abandon: (runId) => { active.delete(runId) },
  }
}

/** Job-ring taps for the background runs the tool tracks. */
export interface WorkflowRecordMirror {
  /**
   * Route a run's progress events into a job's ring. Call once per background
   * run, from the job starter, before the worker publishes its first event.
   * @param runId - the started run.
   * @param job - the owning job's producer face.
   */
  start(runId: WorkflowRunId, job: JobHandle): void
  /**
   * Stop routing a settled or abandoned run. Idempotent.
   * @param runId - the run to drop.
   */
  stop(runId: WorkflowRunId): void
}

/**
 * Create the run-to-ring mirror and subscribe the engine's live progress
 * events for the runs it tracks.
 * @param ctx - plugin context whose event bus carries the `workflow/*` events.
 * @returns the mirror taps the tool wires around each background run.
 */
export function createWorkflowRecordMirror(ctx: Context): WorkflowRecordMirror {
  const active = new Map<WorkflowRunId, JobHandle>()

  ctx.on('workflow/phase', (info, title) => {
    const job = active.get(info.id)
    if (job === undefined) return
    job.updateProgress(title)
    job.append(`▸ ${title}\n`, { channel: 'log' })
  })
  ctx.on('workflow/log', (info, message) => {
    active.get(info.id)?.append(`${message}\n`, { channel: 'log' })
  })
  ctx.on('workflow/agent-start', (info, agent) => {
    active.get(info.id)?.append(`agent #${agent.seq} ${agent.label} started\n`, { channel: 'log' })
  })
  ctx.on('workflow/agent-end', (info, agent) => {
    active.get(info.id)?.append(`agent #${agent.seq} ${agent.outcome}\n`, { channel: 'log' })
  })

  return {
    start(runId, job) {
      active.set(runId, job)
    },
    stop(runId) {
      active.delete(runId)
    },
  }
}

/** A non-`completed` stop reason means the script did not finish cleanly. */
export function stopReasonError(result: WorkflowResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'cancelled':
      return `workflow run was cancelled${result.error !== undefined ? ` (${result.error})` : ''}`
    case 'error':
      return `workflow run failed: ${result.error ?? 'unknown error'}`
    /* v8 ignore start -- defensive: WorkflowStopReason is a closed union, exhaustive by construction; a future variant fails here loudly */
    default:
      return `workflow run ended abnormally (${String(result.stopReason satisfies never)})`
    /* v8 ignore stop */
  }
}

/**
 * Map a settled background run onto the job outcome vocabulary. A completed
 * run carries the rendered return value as the job's result; a
 * cancelled run leaves the detail to the registry's kill-reason merge (the
 * cancel reason it forwarded is the same string); an errored run fails with
 * the script's failure message.
 */
export function jobOutcomeOf(result: WorkflowResult, name: string, maxChars: number): JobOutcome {
  switch (result.stopReason) {
    case 'completed':
      return {
        status: 'completed',
        detail: `${result.agentsStarted} agent${result.agentsStarted === 1 ? '' : 's'}`,
        result: renderResult(name, result.agentsStarted, result.value as JsonValue, maxChars),
      }
    case 'cancelled':
      return { status: 'killed' }
    case 'error':
      return { status: 'failed', detail: result.error ?? 'unknown error' }
    /* v8 ignore start -- defensive: WorkflowStopReason is a closed union, exhaustive by construction; a future variant fails here loudly */
    default:
      return { status: 'failed', detail: `workflow run ended abnormally (${String(result.stopReason satisfies never)})` }
    /* v8 ignore stop */
  }
}

/** Render the run's outcome text: the meta name, agent count, and the JSON value (capped). */
export function renderResult(name: string, agentsStarted: number, value: JsonValue, maxChars: number): string {
  // The engine returns JSON data (null for a valueless script), so stringify never yields undefined.
  const rendered = JSON.stringify(value, null, 2)
  const clipped = rendered.length > maxChars
    ? `${rendered.slice(0, maxChars)}\n… [truncated: ${rendered.length - maxChars} more characters]`
    : rendered
  return `workflow "${name}" completed (${agentsStarted} agent${agentsStarted === 1 ? '' : 's'}).\nReturn value:\n${clipped}`
}

/**
 * Register a background run as an owned job. The engine run is started
 * inside the job starter with no tool-step signal — the run belongs to the
 * job, so a registry kill or owner teardown is what cancels it — and its
 * settlement is the job's settlement: dispose, stop the mirrors, then map the
 * stop reason onto the job outcome (a completed run's rendered return value
 * rides `result` to the model's first read after settlement).
 * @param ctx - plugin context (engine, optional jobs registry, logger).
 * @param args - the validated tool call.
 * @param parent - the calling agent; owns the job.
 * @param recordsRun - whether this top-level call records durable run events.
 * @param deps - the tool's recorder/mirror taps and the render cap.
 * @returns the background result for the tool's output schema.
 */
export function startBackgroundRun(
  ctx: Context,
  args: RunArgs,
  parent: Agent,
  recordsRun: boolean,
  deps: { recorder: WorkflowRecorder; mirror: WorkflowRecordMirror; maxResultChars: number },
): { kind: 'background'; jobId: JobId; runId: WorkflowRunId } {
  const jobs = ctx.get('jobs')
  if (jobs === undefined) {
    throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
  }
  let run!: WorkflowRun
  const jobId = jobs.start({
    kind: 'workflow',
    label: args.meta.name,
    owner: parent.id,
    run: (job) => {
      // A synchronous engine rejection (META_INVALID/SCRIPT_PARSE) propagates
      // out of the starter, so the registry registers nothing and the model
      // sees the violation list as an ordinary tool error.
      run = ctx.workflowEngine.start({
        script: args.script,
        meta: args.meta,
        ...args.args !== undefined ? { args: args.args } : {},
        parent,
      })
      deps.mirror.start(run.id, job)
      if (recordsRun) deps.recorder.start(parent.session, run)
      const done = run.result.then(async (result): Promise<JobOutcome> => {
        try {
          // Keep member listeners alive through disposal: an engine may
          // synthesize cancelled member endings while reaching quiescence.
          await run.dispose()
        } catch (error: unknown) {
          // done must not reject; a failed disposal still has a settled result to report.
          ctx.logger.warn(`background workflow run ${run.id} dispose failed: ${String(error)}`)
        }
        deps.mirror.stop(run.id)
        if (recordsRun) {
          deps.recorder.finish(run.id, result.stopReason)
          deps.recorder.abandon(run.id)
        }
        return jobOutcomeOf(result, args.meta.name, deps.maxResultChars)
      })
      return {
        cancel: (reason?: string) => { run.cancel(reason ?? 'background workflow job killed') },
        done,
      }
    },
  })
  return { kind: 'background' as const, jobId, runId: run.id }
}

/** The pending-state card: a generic card titled by the workflow's meta name. */
export function presentWorkflowCall(args: RunArgs): ToolCallView {
  return {
    card: 'generic',
    title: `workflow: ${args.meta.name}`,
    rawInput: args.script,
  }
}

/** Bridge a tool-call abort signal onto a live run (local safety net). */
export function bridgeAbort(execSignal: AbortSignal, run: WorkflowRun): () => void {
  const onAbort = (): void => { run.cancel('parent step aborted') }
  execSignal.addEventListener('abort', onAbort, { once: true })
  return () => { execSignal.removeEventListener('abort', onAbort) }
}
