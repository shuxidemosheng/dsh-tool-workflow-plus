/**
 * 插件配置与手写校验。
 *
 * 官方 dsh-tool-workflow 用 schemastery（官方仓库 vendored 的包，npm 上不可靠，
 * 见 dsh-tool-todo-plus 的结论），这里照 dsh-tool-todo-plus / dsh-plan-mode-plus
 * 的惯例手写 resolveConfig：未知键直接抛错，让部署笔误在启动日志里炸出来，
 * 而不是静默忽略。
 *
 * @module dsh-tool-workflow-plus/config
 */

/** 插件配置（对应 patch 行里的 config 字段，全部可选）。 */
export interface Config {
  /**
   * 官方 workflow 工具 fork 本体注册的模型工具名（默认 'workflow'）。
   * 官方 tool-workflow 已挂载的部署里本插件会对这个名字让位（不覆盖、不报错）；
   * 想让 fork 与官方共存时可改成别的名字（如 'workflow_plus'）。
   */
  toolName?: string
  /** 渲染结果的上限字符数：超过则截断并附提示（默认 50000，与官方一致）。 */
  maxResultChars?: number
  /**
   * 是否暴露 run_in_background（默认 true，与官方一致）。关闭后 fork 工具与
   * workflow_run_saved 都会拒绝后台请求。后台执行需要 ctx.jobs（dsh-jobs +
   * dsh-jobs-local + dsh-tool-jobs），缺服务时调用会报错并点名缺失件。
   */
  enableRunInBackground?: boolean
  /** 是否注册 saved 库五件套（workflow_save/list/get/delete/run_saved，默认 true）。 */
  savedTools?: boolean
}

/** resolveConfig 的产出：所有字段已填默认值。 */
export interface ResolvedConfig {
  toolName: string
  maxResultChars: number
  enableRunInBackground: boolean
  savedTools: boolean
}

const KNOWN_KEYS = ['toolName', 'maxResultChars', 'enableRunInBackground', 'savedTools'] as const

/**
 * 校验并解析配置。
 * @param config - patch 行里的 config（缺省时全默认）。
 * @returns 填满默认值的配置。
 * @throws 未知键 / 字段类型不对时抛错（apply 会捕获并降级为 warn 后禁用本插件）。
 */
export function resolveConfig(config: Config | undefined): ResolvedConfig {
  if (config === undefined) {
    return { toolName: 'workflow', maxResultChars: 50_000, enableRunInBackground: true, savedTools: true }
  }
  const unknown = Object.keys(config).filter(key => !KNOWN_KEYS.includes(key as typeof KNOWN_KEYS[number]))
  if (unknown.length > 0) {
    throw new Error(
      `dsh-tool-workflow-plus config has unknown key(s) ${unknown.join(', ')}`
      + ' — config is { toolName?, maxResultChars?, enableRunInBackground?, savedTools? }',
    )
  }
  if (config.toolName !== undefined && (typeof config.toolName !== 'string' || config.toolName.trim() === '')) {
    throw new Error('dsh-tool-workflow-plus config: `toolName` must be a non-empty string when present')
  }
  if (config.maxResultChars !== undefined
    && (!Number.isInteger(config.maxResultChars) || config.maxResultChars < 1)) {
    throw new Error('dsh-tool-workflow-plus config: `maxResultChars` must be a positive integer when present')
  }
  if (config.enableRunInBackground !== undefined && typeof config.enableRunInBackground !== 'boolean') {
    throw new Error('dsh-tool-workflow-plus config: `enableRunInBackground` must be a boolean when present')
  }
  if (config.savedTools !== undefined && typeof config.savedTools !== 'boolean') {
    throw new Error('dsh-tool-workflow-plus config: `savedTools` must be a boolean when present')
  }
  return {
    toolName: config.toolName?.trim() ?? 'workflow',
    maxResultChars: config.maxResultChars ?? 50_000,
    enableRunInBackground: config.enableRunInBackground ?? true,
    savedTools: config.savedTools ?? true,
  }
}
