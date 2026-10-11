/**
 * 共享类型面。
 *
 * 1) WorkflowMetaShape：模型侧 meta 参数的输入形状（校验前的宽类型）。
 * 2) `tool-workflow/*` durable 会话事件：与官方 @deepseek-ai/dsh-tool-workflow
 *    的 types.ts 逐字段一致——事件名与载荷形状都不变，官方
 *    dsh-client-ui-workflow-run 才能把本插件（fork 工具与 workflow_run_saved）
 *    发起的 run 折叠进同一个 workflow-run 会话节点。纯类型层声明，运行时的
 *    session.append 是 log-only，无需注册。
 * 3) `workflow` JobKind：后台 run 经 ctx.jobs 注册为 kind: 'workflow' 的任务
 *    （与官方一致）。
 *
 * @module dsh-tool-workflow-plus/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  WorkflowAgentOutcome, WorkflowPhase, WorkflowRunId, WorkflowStopReason,
} from '@deepseek-ai/dsh-workflow/types'

/** 模型侧 meta 参数的输入形状（校验前；与引擎字段面一致，宽在 unknown）。 */
export interface WorkflowMetaShape {
  name: string
  description: string
  whenToUse?: string
  phases?: WorkflowPhase[]
}

/** Opens one durable top-level workflow run record. */
export interface ToolWorkflowRunStartData {
  readonly runId: WorkflowRunId
  readonly name: string
}

/** Records one workflow member after its child Session is published. */
export interface ToolWorkflowAgentStartData {
  readonly runId: WorkflowRunId
  readonly seq: number
  readonly label: string
  readonly phase?: string
  readonly childId: SessionId
}

/** Settles one previously started workflow member. */
export interface ToolWorkflowAgentEndData {
  readonly runId: WorkflowRunId
  readonly seq: number
  readonly outcome: WorkflowAgentOutcome
}

/** Settles one workflow run after its live resources reach quiescence. */
export interface ToolWorkflowRunEndData {
  readonly runId: WorkflowRunId
  readonly stopReason: WorkflowStopReason
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Opens one top-level workflow record.
     * @param data - stable run identity and display name.
     */
    'tool-workflow/run-start': ToolWorkflowRunStartData
    /**
     * Records one published workflow member.
     * @param data - run identity, member sequence, display identity, and child Session.
     */
    'tool-workflow/agent-start': ToolWorkflowAgentStartData
    /**
     * Records one member settlement.
     * @param data - run identity, paired member sequence, and outcome.
     */
    'tool-workflow/agent-end': ToolWorkflowAgentEndData
    /**
     * Closes one workflow record after cleanup.
     * @param data - stable run identity and terminal reason.
     */
    'tool-workflow/run-end': ToolWorkflowRunEndData
  }
}

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    workflow: 'workflow'
  }
}
