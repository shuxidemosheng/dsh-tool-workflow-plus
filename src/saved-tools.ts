/**
 * saved workflow 库的五个模型工具：
 *
 *   workflow_save     —— 把 {meta, script} 存入持久域（key = meta.name）
 *   workflow_list     —— 列出全部 saved workflow（摘要，不含脚本体）
 *   workflow_get      —— 取一条完整记录（含脚本，供模型审阅/修改后重存）
 *   workflow_delete   —— 按名删除
 *   workflow_run_saved —— 用存的脚本启动 ctx.workflowEngine，注入新 args
 *
 * 设计纪律：
 *  - 存储栈缺失不拖垮激活：store 是懒打开的，缺 storage 时这些工具的调用
 *    返回点名缺失件的错误（由工具管线转 isError），entry 照常激活；
 *  - run 生命周期（前台等待/后台 job/abort 桥/dispose/记录）与 fork 工具
 *    共用同一套 lifecycle 设施，行为与官方工具一致；
 *  - 所有写入走 store 的完整记录（无部分合并），schema 校验在存储边界由
 *    domain spec 的 zod schema 兜底。
 *
 * @module dsh-tool-workflow-plus/saved-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkflowResult } from '@deepseek-ai/dsh-workflow'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SavedWorkflow } from './domain.js'
import type { ForkToolDeps } from './fork-tool.js'
import type { RunArgs } from './lifecycle.js'
import { bridgeAbort, renderResult, startBackgroundRun, stopReasonError } from './lifecycle.js'
import type { SavedWorkflowStore } from './store.js'
import type { WorkflowMetaShape } from './types.js'
import { asWorkflowMeta, metaViolations, scriptViolations, violationsMessage } from './validate.js'

/** saved 工具组的运行依赖。 */
export interface SavedToolsDeps extends ForkToolDeps {
  /** 持久化库句柄。 */
  store: SavedWorkflowStore
}

/** 校验工具入参里的 name（schema 已声明 string + required，这里兜底运行时面）。 */
function requireName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('`name` must be a non-empty string (the workflow\'s meta.name)')
  }
  return value
}

/** 渲染一条 workflow 摘要行（list 用；入参即输出 schema 推导出的摘要形状）。 */
function summaryLine(entry: {
  name: string
  description: string
  whenToUse?: string
  phases?: string[]
  scriptChars: number
  updatedAt: number
}): string {
  const phases = entry.phases !== undefined && entry.phases.length > 0
    ? `; phases: ${entry.phases.join(', ')}`
    : ''
  return `- ${entry.name} — ${entry.description} (updated ${new Date(entry.updatedAt).toISOString()}, ${entry.scriptChars} chars${phases})`
}

/**
 * 组装 saved 库五件套。
 * @param ctx - 插件上下文（engine 与可选 jobs 经此访问）。
 * @param deps - store + recorder/mirror/渲染上限/后台开关。
 * @returns 五个工具定义，按 workflow_save/list/get/delete/run_saved 排列。
 */
export function buildSavedTools(ctx: Context, deps: SavedToolsDeps): ReturnType<typeof defineTool>[] {
  const { store, recorder, mirror, maxResultChars, enableRunInBackground } = deps

  const saveTool = defineTool({
    name: 'workflow_save',
    description: 'Save a workflow script into the persistent library so it can be listed and rerun later without resending the script. '
      + 'The save key is `meta.name` — saving again with the same name overwrites only when `overwrite` is true. '
      + 'Save a workflow after it has proven itself in a run (or whenever the user asks to keep one); the script is stored verbatim.',
    parameters: {
      meta: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description: 'The workflow identity as plain JSON, not code (same shape as the workflow tool\'s `meta`).',
        properties: {
          name: { type: 'string', required: true, description: 'Short kebab-case workflow name; doubles as the save key.' },
          description: { type: 'string', required: true, description: 'One-line description of what the workflow does.' },
          whenToUse: { type: 'string', description: 'Optional guidance on when this workflow applies (shown in workflow_list).' },
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
      script: {
        type: 'string',
        required: true,
        description: 'The plain JavaScript body, not TypeScript and without an `export const meta` statement; top-level await is allowed. '
          + 'End with `return <value>`.',
      },
      overwrite: {
        type: 'boolean' as const,
        description: 'Overwrite an existing workflow with the same name (default false: a name clash is an error, so you cannot clobber a saved workflow by accident).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'saved' },
          name: { type: 'string', required: true },
          overwritten: { type: 'boolean', required: true },
          scriptChars: { type: 'integer', required: true },
          updatedAt: { type: 'integer', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `saved workflow "${value.name}" (${value.scriptChars} chars, ${value.overwritten ? 'overwrote the previous version' : 'new'}).`
          + ` Rerun it later with workflow_run_saved {name: "${value.name}", args: {...}}.`,
      }],
    },
    async execute(args) {
      const violations = [...metaViolations(args.meta), ...scriptViolations(args.script)]
      if (violations.length > 0) {
        // 存储边界的 zod schema 是第二道网；这里提前报是为了让模型在保存时
        // 就看到完整违规清单（与引擎 run 时同口径）。
        throw new Error(violationsMessage(violations))
      }
      const meta = asWorkflowMeta(args.meta as WorkflowMetaShape)
      const existing = await store.get(meta.name)
      if (existing !== undefined && args.overwrite !== true) {
        throw new Error(
          `a workflow named "${meta.name}" is already saved (${existing.script.length} chars,`
          + ` updated ${new Date(existing.updatedAt).toISOString()}) — pass overwrite: true to replace it,`
          + ' or pick another name',
        )
      }
      const now = Date.now()
      await store.put({
        meta,
        script: args.script,
        // 覆盖时保留原始 createdAt：库的语义是"同一工作流的版本演进"。
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      return {
        kind: 'saved' as const,
        name: meta.name,
        overwritten: existing !== undefined,
        scriptChars: args.script.length,
        updatedAt: now,
      }
    },
  })

  const listTool = defineTool({
    name: 'workflow_list',
    description: 'List every workflow in the persistent saved library (name, description, when-to-use, phases, script size — not the script bodies). '
      + 'Check this BEFORE writing a long orchestration script from scratch: a saved workflow may already fit, in which case run it with workflow_run_saved and pass fresh args.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'list' },
          workflows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                whenToUse: { type: 'string' },
                phases: { type: 'array', items: { type: 'string' } },
                scriptChars: { type: 'integer', required: true },
                updatedAt: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.workflows.length === 0
          ? 'The saved workflow library is empty. Save one with workflow_save {meta, script}.'
          : `${value.workflows.length} saved workflow(s), most recently updated first:\n`
            + value.workflows.map(summaryLine).join('\n'),
      }],
    },
    async execute() {
      const entries = await store.list()
      return {
        kind: 'list' as const,
        workflows: entries.map(entry => ({
          name: entry.meta.name,
          description: entry.meta.description,
          ...entry.meta.whenToUse !== undefined ? { whenToUse: entry.meta.whenToUse } : {},
          phases: (entry.meta.phases ?? []).map(phase => phase.title),
          scriptChars: entry.script.length,
          updatedAt: entry.updatedAt,
        })),
      }
    },
  })

  const getTool = defineTool({
    name: 'workflow_get',
    description: 'Fetch one saved workflow in full: its meta block and the verbatim script body. '
      + 'Use it to review a workflow before running it, or to read a script you intend to modify and re-save.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'The saved workflow\'s meta.name (see workflow_list).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'record' },
          meta: {
            type: 'object',
            additionalProperties: true,
            required: true,
            description: 'The saved workflow\'s identity block.',
            properties: {
              name: { type: 'string', required: true },
              description: { type: 'string', required: true },
              whenToUse: { type: 'string' },
              phases: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    title: { type: 'string', required: true },
                    detail: { type: 'string' },
                    provider: { type: 'string' },
                    model: { type: 'string' },
                  },
                },
              },
            },
          },
          script: { type: 'string', required: true },
          createdAt: { type: 'integer', required: true },
          updatedAt: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `workflow "${value.meta.name}" (saved ${new Date(value.createdAt).toISOString()}`
          + `, updated ${new Date(value.updatedAt).toISOString()})\n`
          + `description: ${value.meta.description}\n`
          + `script:\n\`\`\`\n${value.script}\n\`\`\``,
      }],
    },
    async execute(args) {
      const name = requireName(args.name)
      const entry = await store.get(name)
      if (entry === undefined) {
        throw new Error(`no saved workflow named "${name}" — check workflow_list for what exists`)
      }
      return {
        kind: 'record' as const,
        meta: entry.meta,
        script: entry.script,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      }
    },
  })

  const deleteTool = defineTool({
    name: 'workflow_delete',
    description: 'Delete one saved workflow from the persistent library. Deleting is permanent — fetch the script with workflow_get first if it matters.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'The saved workflow\'s meta.name (see workflow_list).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'deleted' },
          name: { type: 'string', required: true },
          deleted: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.deleted
          ? `deleted saved workflow "${value.name}".`
          : `no saved workflow named "${value.name}" — nothing to delete.`,
      }],
    },
    async execute(args) {
      const name = requireName(args.name)
      const deleted = await store.delete(name)
      return { kind: 'deleted' as const, name, deleted }
    },
  })

  const runSavedTool = defineTool({
    name: 'workflow_run_saved',
    description: 'Run a saved workflow from the persistent library: starts the same engine the workflow tool uses, with the stored script and meta, '
      + 'and injects fresh `args` into the script. Prefer this over resending a full script through the workflow tool whenever the orchestration is already saved.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'The saved workflow\'s meta.name (see workflow_list).',
      },
      args: {
        type: 'object',
        additionalProperties: true,
        description: 'Optional JSON input exposed to the script as the `args` global (overrides nothing — the saved script reads whatever you pass here).',
      },
      ...enableRunInBackground ? {
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
          ? `workflow "${args.name}" (saved) started in the background as job ${value.jobId}. Its return value arrives with the completion notice; check on it with job_output, stop it with job_kill.`
          : renderResult(args.name, value.agentsStarted, value.result, maxResultChars),
      }],
    },
    async execute(args, exec) {
      const name = requireName(args.name)
      const parent = exec.agent
      if (!parent) {
        throw new Error('workflow_run_saved requires a calling agent (exec.agent was undefined)')
      }
      const entry = await store.get(name)
      if (entry === undefined) {
        throw new Error(`no saved workflow named "${name}" — check workflow_list for what exists`)
      }
      const runArgs: RunArgs = {
        script: entry.script,
        meta: entry.meta,
        ...args.args !== undefined ? { args: args.args as Record<string, unknown> } : {},
        run_in_background: args.run_in_background,
      }
      if (args.run_in_background === true) {
        if (!enableRunInBackground) {
          throw new Error('run_in_background is disabled for this tool')
        }
        return startBackgroundRun(ctx, runArgs, parent, exec.parent === undefined, {
          recorder,
          mirror,
          maxResultChars,
        })
      }

      const run = ctx.workflowEngine.start({
        script: entry.script,
        meta: entry.meta,
        ...args.args !== undefined ? { args: args.args } : {},
        parent,
        signal: exec.signal,
      })
      const recordsRun = exec.parent === undefined
      if (recordsRun) recorder.start(parent.session, run)
      const removeAbortBridge = bridgeAbort(exec.signal, run)

      let result: WorkflowResult | undefined
      try {
        result = await run.result
        const error = stopReasonError(result)
        if (error !== undefined) {
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
          await run.dispose()
          if (recordsRun) {
            if (result === undefined) throw new Error('workflow run settled without a result')
            recorder.finish(run.id, result.stopReason)
          }
        } finally {
          if (recordsRun) recorder.abandon(run.id)
        }
      }
    },
    presentCall: args => ({
      card: 'generic' as const,
      title: `workflow: ${args.name} (saved)`,
      rawInput: args.name,
    }),
    presentResult: (_args, _result) => ({ card: 'generic' as const }),
  })

  return [saveTool, listTool, getTool, deleteTool, runSavedTool]
}
