/**
 * 保存期校验：meta 形状校验（与引擎 META_INVALID 同口径）+ script 静态体检。
 *
 * 引擎在 run 时会做完整校验（meta 形状 + script 解析），这里提前到 save 期
 * 是为了让模型在"存"的时候就看到违规清单，而不是等到 run_saved 才炸。
 * 校验规则从 packages/workflow/workflow-ptc/src/meta.ts 的 validateMetaShape
 * 逐条对齐——两边口径不一致的话，会出现"存得进、跑不起来"的库。
 *
 * @module dsh-tool-workflow-plus/validate
 */

import type { WorkflowMeta } from '@deepseek-ai/dsh-workflow'
import type { WorkflowMetaShape } from './types.js'

/**
 * 按引擎口径校验 meta 形状，返回违规清单（空数组 = 合法）。
 * 与 workflow-ptc 的 validateMetaShape 逐条对齐：
 *  - 必须是普通对象（非 null、非数组）
 *  - 字段面只认 name/description/whenToUse/phases，未知字段按名报违规
 *  - name/description 必须是非空字符串
 *  - whenToUse 存在时必须是字符串
 *  - phases 存在时必须是数组，元素字段面只认 title/detail/provider/model，
 *    title 必须非空字符串，其余存在时必须是字符串
 *
 * 这里只负责"存之前报得出错"，产出类型由调用方在违规为空时自行收窄。
 * @param meta - 待校验的 meta 值（来自模型调用的 JSON 数据）。
 * @returns 违规清单，每条都点名违规字段。
 */
export function metaViolations(meta: unknown): string[] {
  const violations: string[] = []
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return ['meta must be an object']
  }
  const record = meta as Record<string, unknown>
  const known = new Set(['name', 'description', 'whenToUse', 'phases'])
  for (const key of Object.keys(record)) {
    if (!known.has(key)) violations.push(`meta.${key} is not a recognized field (name/description/whenToUse/phases)`)
  }
  if (typeof record.name !== 'string' || record.name.length === 0) violations.push('meta.name must be a non-empty string')
  if (typeof record.description !== 'string' || record.description.length === 0) violations.push('meta.description must be a non-empty string')
  if (record.whenToUse !== undefined && typeof record.whenToUse !== 'string') violations.push('meta.whenToUse must be a string')
  if (record.phases !== undefined) {
    if (!Array.isArray(record.phases)) {
      violations.push('meta.phases must be an array')
    } else {
      record.phases.forEach((phase, index) => {
        if (typeof phase !== 'object' || phase === null || Array.isArray(phase)) {
          violations.push(`meta.phases[${index}] must be an object`)
          return
        }
        const entry = phase as Record<string, unknown>
        for (const key of Object.keys(entry)) {
          if (!['title', 'detail', 'provider', 'model'].includes(key)) {
            violations.push(`meta.phases[${index}].${key} is not a recognized field`)
          }
        }
        if (typeof entry.title !== 'string' || entry.title.length === 0) {
          violations.push(`meta.phases[${index}].title must be a non-empty string`)
        }
        if (entry.detail !== undefined && typeof entry.detail !== 'string') violations.push(`meta.phases[${index}].detail must be a string`)
        if (entry.provider !== undefined && typeof entry.provider !== 'string') violations.push(`meta.phases[${index}].provider must be a string`)
        if (entry.model !== undefined && typeof entry.model !== 'string') violations.push(`meta.phases[${index}].model must be a string`)
      })
    }
  }
  return violations
}

/**
 * script 的保存期静态体检。只做"确定永远跑不起来"的检查，不做风格审查：
 *  - 必须是非空（trim 后非空）字符串
 *  - 不得携带 `export const meta` 块——工具契约是"裸 JS body + meta 作为 JSON
 *    参数"，引擎对带 meta 块的脚本会 SCRIPT_PARSE；存一条永远跑不起来的脚本
 *    没有意义。这是对确切模式的正则匹配，注释/字符串里的误报率可忽略，
 *    而且引擎仍然是最终裁决者（run 时再查一次）。
 * @param script - 待保存的脚本文本。
 * @returns 违规清单（空数组 = 通过）。
 */
export function scriptViolations(script: string): string[] {
  const violations: string[] = []
  if (script.trim().length === 0) {
    violations.push('script must be a non-empty JavaScript body')
  }
  if (/\bexport\s+const\s+meta\b/.test(script)) {
    violations.push(
      'script must NOT contain an `export const meta` statement — pass the identity block as the meta parameter instead (the tool contract is a bare JS body; the engine rejects scripts carrying a meta block)',
    )
  }
  return violations
}

/**
 * 违规清单 → 单条工具错误消息（逐行缩进，模型可直接阅读修正）。
 * @param violations - 非空违规清单。
 * @returns 一条完整的 Error 消息文本。
 */
export function violationsMessage(violations: string[]): string {
  return `invalid workflow: ${violations.length} violation(s):\n- ${violations.join('\n- ')}`
}

/**
 * 违规为空时把已校验的 meta 值收窄成引擎的 WorkflowMeta 形状。
 * 只在 metaViolations() 返回空数组后调用——那里的检查保证了这里的断言成立。
 * @param meta - 已通过形状校验的 meta 值。
 * @returns 引擎 WorkflowMeta 形状的纯数据（浅拷贝，字段面已收窄）。
 */
export function asWorkflowMeta(meta: WorkflowMetaShape): WorkflowMeta {
  const record = meta as WorkflowMetaShape & Record<string, unknown>
  return {
    name: record.name,
    description: record.description,
    ...record.whenToUse !== undefined ? { whenToUse: record.whenToUse } : {},
    ...record.phases !== undefined ? { phases: record.phases } : {},
  }
}
