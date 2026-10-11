/**
 * saved workflow 库的存储访问层。
 *
 * 懒打开：apply() 期间不做任何 IO（entry 激活永远成功——激活失败会连累会话
 * 创建），第一次工具调用才 resolve `ctx.storageDomain` 并 open 域。宿主缺
 * storage 栈时，ready() 抛出的错误点名缺失件（照官方工具对 ctx.jobs 的处理
 * 模式），由工具管线转成 isError 结果，模型能读懂并转告用户。
 *
 * @module dsh-tool-workflow-plus/store
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { workflowSavedDomain } from './domain.js'
import type { SavedWorkflow } from './domain.js'

/** storage 域句柄的静态视图（我们只声明了这一种 spec，直接按它的形状取表）。 */
type WorkflowSavedDomain = Domain<typeof workflowSavedDomain>

/**
 * saved workflow 库。一个实例对应一个插件生命周期；dispose() 关闭底层域。
 * 所有方法在 storage 栈缺失/域打开失败时 reject，消息点名缺失件或根因。
 */
export class SavedWorkflowStore {
  /** 懒初始化的域句柄 promise；失败后重置，让下一次调用重试 open。 */
  private readyPromise: Promise<WorkflowSavedDomain> | undefined

  constructor(private readonly ctx: Context) {}

  /**
   * 解析并打开持久化域（幂等：并发调用共享同一个 promise；失败后可重试）。
   * `storageDomain` 服务不在 inject 里（缺它的部署不该连累 entry 激活），
   * 运行时经 ctx.get 解析——官方工具对 ctx.jobs 就是这么做的。
   * @returns 已打开的域句柄。
   */
  ready(): Promise<WorkflowSavedDomain> {
    if (this.readyPromise === undefined) {
      this.readyPromise = this.open().catch((error: unknown) => {
        // 失败即重置：下一次调用重新尝试（比如用户随后挂上了 storage 插件）。
        this.readyPromise = undefined
        throw error
      })
    }
    return this.readyPromise
  }

  private async open(): Promise<WorkflowSavedDomain> {
    const facility = (this.ctx as Context & { get?: (name: string) => unknown }).get?.('storageDomain')
    if (facility === undefined || facility === null) {
      throw new Error(
        'saved workflow storage unavailable: no `storageDomain` service on this context'
        + ' — load @deepseek-ai/dsh-storage, a kv backend (@deepseek-ai/dsh-storage-json'
        + ' or @deepseek-ai/dsh-storage-sqlite), and @deepseek-ai/dsh-storage-domain',
      )
    }
    const domain = await (facility as { open(spec: unknown): Promise<WorkflowSavedDomain> }).open(workflowSavedDomain)
    return domain
  }

  /**
   * 全量列出 saved workflow（按 updatedAt 降序，最近更新在前）。
   * @returns 记录快照数组。
   */
  async list(): Promise<SavedWorkflow[]> {
    const domain = await this.ready()
    const all = [...domain.table('workflows').entries()].map(([, value]) => value)
    return all.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * 按名取一条记录（key = meta.name）。
   * @param name - workflow 名。
   * @returns 记录，不存在时 undefined。
   */
  async get(name: string): Promise<SavedWorkflow | undefined> {
    const domain = await this.ready()
    return domain.table('workflows').get(name)
  }

  /**
   * 写入（插入或整体覆盖）一条记录。
   * @param record - 完整的新记录。
   */
  async put(record: SavedWorkflow): Promise<void> {
    const domain = await this.ready()
    await domain.table('workflows').put(record.meta.name, record)
  }

  /**
   * 按名删除一条记录。
   * @param name - workflow 名。
   * @returns 是否真的删了（本来就不存在时 false，且不产生写入）。
   */
  async delete(name: string): Promise<boolean> {
    const domain = await this.ready()
    return domain.table('workflows').delete(name)
  }

  /**
   * 关闭底层域（插件 fiber 销毁时调用）。幂等；未打开过时是 no-op。
   */
  async dispose(): Promise<void> {
    if (this.readyPromise === undefined) return
    const domain = await this.readyPromise
    await domain.close()
  }
}
