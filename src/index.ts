/**
 * dsh-tool-workflow-plus —— 官方 @deepseek-ai/dsh-tool-workflow 的 drop-in
 * 增强 fork。官方 README 明确写着 "No saved or nested workflows —
 * caller-supplied scripts only"，并把 saved workflows 列为官方 deferred
 * direction——本插件补上这个缺口：
 *
 *  1. workflow 工具 fork 本体（模型面与官方逐字一致 + description 声明
 *     saved 库的存在；config.toolName 可配，与官方共存时让位）；
 *  2. saved workflow 库五件套（workflow_save / workflow_list / workflow_get /
 *     workflow_delete / workflow_run_saved），持久化走 ctx.storageDomain
 *     的自有域 `workflow_saved`（per-record json 文档，默认路由 base bundle
 *     的 json backend）；
 *  3. fork 工具与 workflow_run_saved 共用官方同款 run 生命周期：durable
 *     `tool-workflow/*` 会话记录（官方 UI 照常折叠）、后台 job 镜像、abort 桥。
 *
 * 纪律（与官方 postmortem 0001 / 既有插件一致）：
 *  - 绝不 export default（Loader 的 unwrapExports 会折叠模块并丢掉 inject）；
 *  - apply() 内不做任何 IO：域是懒打开的，任何激活期失败都降级为 warn/error
 *    日志 + 继续激活（entry 激活失败会让会话创建失败，输家必须优雅退出）；
 *  - 工具名撞车时确定性让位：先查 ctx.tools.get，被占就跳过并 warn，
 *    绝不抛错去赌注册顺序。
 *
 * @module dsh-tool-workflow-plus
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.js'
import type { Config, ResolvedConfig } from './config.js'
import { buildForkTool } from './fork-tool.js'
import { createWorkflowRecordMirror, createWorkflowRecorder } from './lifecycle.js'
import { buildSavedTools } from './saved-tools.js'
import { SavedWorkflowStore } from './store.js'

export const name = 'tool-workflow-plus'

/** 宿主服务依赖：工具注册表、workflow 引擎（官方同款）、系统提示分区。 */
export const inject = ['tools', 'workflowEngine', 'systemPrompt'] as const

/** saved 库五件套的工具名（注册前逐个做让位检查）。 */
const SAVED_TOOL_NAMES = [
  'workflow_save', 'workflow_list', 'workflow_get', 'workflow_delete', 'workflow_run_saved',
] as const

/** saved 库使用纪律：随本插件的 system prompt 分区下发给模型。 */
const SAVED_LIBRARY_GUIDANCE = `The saved workflow library (workflow_save / workflow_list / workflow_get / workflow_delete / workflow_run_saved) persists orchestration scripts across sessions. Discipline: before writing a long workflow script from scratch, call workflow_list — run an existing fit via workflow_run_saved with fresh args; after an ad-hoc workflow run proves itself, or whenever the user asks to keep a workflow, save it with workflow_save (overwrite: true replaces a same-name workflow deliberately, never silently). The library is shared storage: review a workflow with workflow_get before modifying or deleting it, and confirm with the user before deleting something you did not create in this session.`

/**
 * 注册 workflow fork 工具与 saved 库五件套。由 Cordis Loader 在组合挂载时调用。
 * @param ctx - 携带 tools / workflowEngine / systemPrompt 的 Cordis 上下文。
 * @param config - patch 行里的 config（缺省时用默认值）。
 */
export function apply(ctx: Context, config: Config | undefined): void {
  let resolved: ResolvedConfig
  try {
    resolved = resolveConfig(config)
  } catch (error) {
    // 配置笔误不该炸会话创建：降级为禁用本插件并留一行 warn。
    ctx.logger.warn(`tool-workflow-plus disabled: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  const recorder = createWorkflowRecorder(ctx)
  const mirror = createWorkflowRecordMirror(ctx)
  const store = new SavedWorkflowStore(ctx)

  // fiber 销毁时关闭存储域（未打开过时是 no-op）。
  ctx.effect(function* () {
    yield async () => {
      await store.dispose()
    }
  }, 'tool-workflow-plus saved-library lifecycle')

  // —— fork 本体：确定性让位 ——
  if (ctx.tools.get(resolved.toolName) !== undefined) {
    // 官方 tool-workflow（或任何同名工具）已注册：让位。与官方共存时本插件
    // 是纯增量（saved 五件套照常注册）；想用 fork 本体请参考 README 的
    // drop-in 段落（profile patch 里 disable 官方行，或改 toolName 共存）。
    ctx.logger.warn(
      `tool-workflow-plus: tool "${resolved.toolName}" is already registered by another plugin`
      + ' — the fork is standing by (only the saved-library tools register;'
      + ' see the README drop-in section to take over the name)',
    )
  } else {
    try {
      ctx.tools.register(buildForkTool(ctx, {
        toolName: resolved.toolName,
        recorder,
        mirror,
        maxResultChars: resolved.maxResultChars,
        enableRunInBackground: resolved.enableRunInBackground,
      }))
    } catch (error) {
      // fork 注册失败不能冒泡（那会让会话创建失败）；saved 五件套继续尝试。
      ctx.logger.error(
        `tool-workflow-plus: failed to register fork tool "${resolved.toolName}"`
        + ` — ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  // —— saved 五件套：逐个让位 + 逐个容错 ——
  if (resolved.savedTools) {
    const tools = buildSavedTools(ctx, {
      toolName: resolved.toolName,
      recorder,
      mirror,
      maxResultChars: resolved.maxResultChars,
      enableRunInBackground: resolved.enableRunInBackground,
      store,
    })
    for (let index = 0; index < tools.length; index++) {
      const tool = tools[index]!
      const toolName = SAVED_TOOL_NAMES[index]!
      if (ctx.tools.get(toolName) !== undefined) {
        ctx.logger.warn(
          `tool-workflow-plus: tool "${toolName}" is already registered by another plugin — standing by`,
        )
        continue
      }
      try {
        ctx.tools.register(tool)
      } catch (error) {
        ctx.logger.error(
          `tool-workflow-plus: failed to register tool "${toolName}"`
          + ` — ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    // —— saved 库使用纪律：system prompt 分区（失败不连累工具） ——
    try {
      ctx.systemPrompt.section({
        name: 'tool:workflow-saved-library',
        order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
        text: SAVED_LIBRARY_GUIDANCE,
      })
    } catch (error) {
      ctx.logger.warn(
        'tool-workflow-plus: failed to register the saved-library system prompt section'
        + ` — ${error instanceof Error ? error.message : String(error)};`
        + ' the saved tools remain available (their descriptions carry the same guidance)',
      )
    }
  }
}
