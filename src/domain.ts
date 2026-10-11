/**
 * saved workflow 的持久化声明：record zod schema + storage domain spec。
 *
 * 存储域选型依据（docs/subsystems/storage.md）：storage 子系统管的就是
 * "session 事件日志之外的一切持久化"，插件用 defineDomain 声明自己的域，
 * 经 ctx.storageDomain.open() 打开，默认路由到 base bundle 注册的 json
 * backend（`backend: json`），零部署配置。选 `per-record` layout：workflow
 * 脚本属于"记录大、可单条清理"的数据，每条一个文档，坏一条不会拖垮整库。
 *
 * 域名 `workflow_saved` 必须匹配 UNIT_NAME_RE（/^[a-z][a-z0-9_]*$/）。
 *
 * @module dsh-tool-workflow-plus/domain
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/**
 * 单个 phase 声明，字段面与引擎 WorkflowMeta.phases 完全一致
 * （packages/workflow/workflow/src/types.ts 的 WorkflowPhase）。
 */
export const workflowPhaseSchema = z.object({
  title: z.string().min(1),
  detail: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
}).strict()

/**
 * workflow 身份块，字段面与引擎 WorkflowMeta 一致：name/description 必填非空，
 * whenToUse/phases 可选，未知字段拒绝（引擎 META_INVALID 的同款规则）。
 */
export const workflowMetaSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  whenToUse: z.string().optional(),
  phases: z.array(workflowPhaseSchema).optional(),
}).strict()

/**
 * 一条 saved workflow。record key = meta.name（存储层 record key 是任意
 * 字符串、不进文件路径，所以 name 无需再限制字符集——与引擎"非空字符串"
 * 的校验口径一致）。
 */
export const savedWorkflowSchema = z.object({
  meta: workflowMetaSchema,
  script: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict()

/** 一条 saved workflow（zod 推导出的静态类型）。 */
export type SavedWorkflow = z.infer<typeof savedWorkflowSchema>

/**
 * 本插件的持久化域：单表 `workflows`，per-record layout。
 * `invalidRecords` 不声明（默认 invalid-record 整体拒绝）——saved 脚本是
 * 用户资产不是派生缓存，坏记录应当大声失败而不是悄悄丢掉。
 */
export const workflowSavedDomain = defineDomain({
  name: 'workflow_saved',
  version: 1,
  layout: 'per-record',
  tables: { workflows: domainTable<string, SavedWorkflow>(savedWorkflowSchema) },
})
