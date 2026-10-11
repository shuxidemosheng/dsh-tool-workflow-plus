/**
 * 官方 workflow 工具的 fork 本体：模型面（参数 schema、输出 schema、run 生命
 * 周期、事件与渲染）与官方 @deepseek-ai/dsh-tool-workflow 0.2.1-alpha.2 逐字
 * 一致，唯一增强在 description——告诉模型 saved 库的存在与用法（先查后写、
 * 跑得好就存），以及让 config.toolName 可配以支持与官方共存。
 *
 * 让位纪律：本工具的注册与否由 index.ts 决定；当部署里官方 tool-workflow 已
 * 占住目标名时，fork 让位（只有官方工具，saved 五件套照常注册）。
 *
 * @module dsh-tool-workflow-plus/fork-tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkflowResult } from '@deepseek-ai/dsh-workflow'
import type { RunArgs, WorkflowRecordMirror, WorkflowRecorder } from './lifecycle.js'
import {
  bridgeAbort, renderResult, startBackgroundRun, stopReasonError,
} from './lifecycle.js'

/** fork 工具的运行依赖（由 index.ts 组装，workflow_run_saved 共用同一套）。 */
export interface ForkToolDeps {
  /** 注册的模型工具名（默认 'workflow'）。 */
  toolName: string
  /** durable 会话记录 taps。 */
  recorder: WorkflowRecorder
  /** 后台 run 的 job 环镜像。 */
  mirror: WorkflowRecordMirror
  /** 渲染结果上限字符数。 */
  maxResultChars: number
  /** 是否允许 run_in_background（关了也拒绝调用）。 */
  enableRunInBackground: boolean
}

/**
 * The script-authoring contract, embedded in the tool description: the hooks,
 * their exact semantics, and the supported schema subset. Parameter-level
 * rules live in the parameter descriptions. （官方原文 + 末尾 saved 库段落。）
 */
const DESCRIPTION = `Run a JavaScript workflow script that orchestrates subagents at scale. Use this for work that fans out across many independent pieces — an audit over many files, a migration, multi-angle research, adversarial verification of findings — where you write the orchestration as a script instead of delegating turn by turn.

Script-body hooks:
- \`agent(prompt, opts?): Promise<any>\` — run one subagent to completion. Without \`opts.schema\` it resolves to the child's final text; with \`opts.schema\` (an object-rooted JSON Schema using ONLY type/properties/required/additionalProperties/items/enum/const/oneOf) it resolves to the validated object. Resolves \`null\` when the child fails (filter with \`.filter(Boolean)\`). Other opts: \`label\` (display), \`phase\` (progress group), and independent \`provider\`/\`model\` LLM target overrides.
- \`pipeline(items, ...stages)\` — run each item through the stages independently with NO barrier between stages (prefer this for multi-stage work). Each stage receives \`(prev, item, index)\`. A stage throw drops that ITEM to \`null\` and skips its remaining stages.
- \`parallel(thunks)\` — run zero-argument functions concurrently and await ALL of them (a barrier; use only when a stage genuinely needs every prior result together). A throwing thunk resolves to \`null\`.
- \`phase(title)\` — start a progress phase; \`log(message)\` — narrate progress; \`args\` — the tool call's \`args\` input, verbatim.

Misused hooks (bad arguments, unknown options, unsupported schemas, tripped caps) end the whole script instead of producing \`null\`. The script has no filesystem, network, timer, or Node.js APIs; the agents do the work.

Saved library: this deployment also exposes \`workflow_save\` / \`workflow_list\` / \`workflow_get\` / \`workflow_delete\` / \`workflow_run_saved\` for persisting orchestration scripts. Before writing a long orchestration from scratch, check \`workflow_list\` — a saved workflow may already fit (run it via \`workflow_run_saved\` with fresh \`args\` instead of resending the whole script). After an ad-hoc workflow proves itself (or the user asks to keep one), save it with \`workflow_save\` so it can be rerun later without rewriting.`

/**
 * 组装 fork 工具（官方 workflow 工具的等价物）。
 * @param ctx - 插件上下文（engine 与可选 jobs 经此访问）。
 * @param deps - 工具名 + recorder/mirror/渲染上限/后台开关。
 * @returns 交给 ctx.tools.register 的工具定义。
 */
export function buildForkTool(ctx: Context, deps: ForkToolDeps) {
  return defineTool({
    name: deps.toolName,
    description: DESCRIPTION,
    parameters: {
      script: {
        type: 'string',
        required: true,
        description: 'The plain JavaScript body, not TypeScript and without an `export const meta` statement; top-level await is allowed. '
          + 'End with `return <value>`; the JSON-serializable value is this tool\'s result.',
      },
      meta: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description: 'The workflow identity as plain JSON, not code. Its `name` doubles as the save key for `workflow_save`.',
        properties: {
          name: { type: 'string', required: true, description: 'Short kebab-case workflow name.' },
          description: { type: 'string', required: true, description: 'One-line description of what the workflow does.' },
          whenToUse: { type: 'string', description: 'Optional guidance on when this workflow applies.' },
          phases: {
            type: 'array',
            description: 'Optional phase declarations matched by phase() calls.',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                title: { type: 'string', required: true, description: 'The phase title phase() calls match by exact string.' },
                detail: { type: 'string', description: 'Optional one-line description of the phase.' },
                provider: { type: 'string', description: 'Optional provider override this phase is expected to use.' },
                model: { type: 'string', description: 'Optional model override this phase is expected to use.' },
              },
            },
          },
        },
      },
      args: {
        type: 'object',
        additionalProperties: true,
        description: 'Optional JSON input exposed to the script as the `args` global (wrap a bare list as a field, e.g. {"files": [...]}).',
      },
      ...deps.enableRunInBackground ? {
        run_in_background: {
          type: 'boolean' as const,
          description: 'Run as a background job: return a job id immediately instead of waiting; the return value arrives with the completion notice.',
        },
      } : {},
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              jobId: { type: 'string', required: true },
              runId: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              runId: { type: 'string', required: true },
              agentsStarted: { type: 'integer', required: true },
              result: { type: 'json', required: true },
            },
          },
        ],
      },
      render: (args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `workflow "${args.meta.name}" started in the background as job ${value.jobId}. Its return value arrives with the completion notice; check on it with job_output, stop it with job_kill.`
          : renderResult(args.meta.name, value.agentsStarted, value.result, deps.maxResultChars),
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        // The loop sets `exec.agent` for every model-driven call; its absence
        // means a non-agent caller invoked the tool directly, which has no
        // parent to attribute the children to. Fail loud rather than guess.
        throw new Error('workflow tool requires a calling agent (exec.agent was undefined)')
      }
      if (args.run_in_background === true) {
        if (!deps.enableRunInBackground) {
          throw new Error('run_in_background is disabled for this tool')
        }
        // No pre-abort check here, unlike bash/pwsh: ToolRuntime re-reads the
        // caller signal right before execute(), and this branch reaches
        // jobs.start synchronously from there. The shell tools await a
        // sandbox escalation approval before registering, which is the window
        // their check covers.
        return startBackgroundRun(ctx, args as RunArgs, parent, exec.parent === undefined, {
          recorder: deps.recorder,
          mirror: deps.mirror,
          maxResultChars: deps.maxResultChars,
        })
      }

      // Meta/body validation failures (META_INVALID/SCRIPT_PARSE) throw
      // synchronously here and become isError results via the registry — the
      // model sees the violation list and can correct the call.
      const run = ctx.workflowEngine.start({
        script: args.script,
        meta: args.meta,
        ...args.args !== undefined ? { args: args.args } : {},
        parent,
        signal: exec.signal,
      })
      const recordsRun = exec.parent === undefined
      // The engine publishes member events after start() returns and this run record is active.
      if (recordsRun) deps.recorder.start(parent.session, run)

      // The engine also bridges the signal itself; this local bridge preserves
      // the tool contract even if an implementation ignores it.
      const removeAbortBridge = bridgeAbort(exec.signal, run)

      let result: WorkflowResult | undefined
      try {
        result = await run.result
        const error = stopReasonError(result)
        if (error !== undefined) {
          // Map a non-clean finish to an isError result (the registry turns a
          // throw into an isError). Report the reason, not partial output.
          throw new Error(error)
        }
        return {
          kind: 'foreground' as const,
          runId: run.id,
          agentsStarted: result.agentsStarted,
          result: result.value as JsonValue,
        }
      } finally {
        removeAbortBridge()
        try {
          // Keep member listeners alive through disposal: an engine may
          // synthesize cancelled member endings while reaching quiescence.
          await run.dispose()
          if (recordsRun) {
            /* v8 ignore next -- WorkflowRun.result never rejects by contract, so result is assigned before finally. */
            if (result === undefined) throw new Error('workflow run settled without a result')
            deps.recorder.finish(run.id, result.stopReason)
          }
        } finally {
          if (recordsRun) deps.recorder.abandon(run.id)
        }
      }
    },
    presentCall: args => ({
      card: 'generic' as const,
      title: `workflow: ${args.meta.name}`,
      rawInput: args.script,
    }),
    // The completed-state card: keep the pending title; render the result content as-is.
    presentResult: (_args, _result: { content: ContentBlock[]; isError: boolean }) => ({ card: 'generic' as const }),
  })
}
