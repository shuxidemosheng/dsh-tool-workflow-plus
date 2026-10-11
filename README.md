# dsh-tool-workflow-plus

官方 [`@deepseek-ai/dsh-tool-workflow`](https://www.npmjs.com/package/@deepseek-ai/dsh-tool-workflow) 的 **drop-in 增强 fork**：补上官方 README 明确列为 deferred direction 的 **saved workflows**——模型可以把编排脚本存入持久库、检索、带新 args 重跑，而不是每次重发整段脚本。

官方工具的行为面（参数 schema、输出 schema、run 生命周期、`tool-workflow/*` durable 会话事件、后台 job 镜像、错误文案）从 0.2.1-alpha.2 逐字移植；增量全部集中在"存"与"取"上。

```
官方（deferred）：  "No saved or nested workflows — caller-supplied scripts only"
本插件：            workflow_save / workflow_list / workflow_get / workflow_delete / workflow_run_saved
```

## 工具面

| 工具 | 作用 |
| --- | --- |
| `workflow` | fork 本体，与官方等价；description 末尾追加 saved 库使用纪律。与官方共存时自动让位 |
| `workflow_save` | 存 `{meta, script}` 入库，key = `meta.name`；同名冲突默认拒绝，`overwrite: true` 显式覆盖（保留原始 createdAt） |
| `workflow_list` | 列出全部 saved workflow（名称/描述/whenToUse/phases/脚本大小，按更新时间倒序；不含脚本体） |
| `workflow_get` | 取完整记录（含脚本），供审阅、修改后重存 |
| `workflow_delete` | 按名删除 |
| `workflow_run_saved` | 用存的脚本 + meta 启动 `ctx.workflowEngine`，注入新 `args`；支持 `run_in_background`（与官方同款 job 语义） |

保存期校验与引擎 run 时同口径（meta 形状逐条对齐 `dsh-workflow-ptc` 的 META_INVALID 规则；脚本拒绝携带 `export const meta` 块），违规清单在"存"的时候就报给模型，不会出现"存得进、跑不起来"的记录。

## 持久化

存储走官方 storage 子系统的 **domain KV**（[`dsh-storage-domain`](https://www.npmjs.com/package/@deepseek-ai/dsh-storage-domain)）：

- 自有域 `workflow_saved`，单表 `workflows`，`per-record` layout（每条一个文档——脚本大、可单条清理）；
- 标准 base bundle（`backend: json`）下**零配置**：域默认路由到 json backend，落在 `dshHomePath('storages')`；
- record schema（zod strict）：`{ meta, script, createdAt, updatedAt }`；坏记录按默认策略整库拒绝打开（saved 脚本是用户资产，不是可丢弃的派生缓存）；
- 存储栈缺失（没挂 storage 三件套）不拖垮激活：五个 saved 工具的调用会返回点名缺失件的错误，fork 工具照常工作。

## 安装

```bash
# Git Bash
dsh plugin add dsh-tool-workflow-plus
```

或在 profile 的 bundle 依赖里加 `dsh-tool-workflow-plus` 后重载。

### 与官方工具的关系（默认：共存）

默认 patch 行只插入本插件，不动官方 `tool-workflow` 行。激活后：

- 官方已占住 `workflow` 工具名 → fork 本体让位（warn 一行），本插件是**纯增量**：只有五个 saved 工具上线，官方 `workflow` 工具照常用；
- 官方不在（headless/sdk 等没挂 workflow 的组合）→ fork 本体以 `workflow` 之名上线，行为与官方等价 + description 里的 saved 库提示。

### drop-in 接管官方工具

想让 fork 接管 `workflow` 工具名（替换官方工具，模型看到的是带 saved 库提示的版本）：

```yaml
# profile patch 里追加（对顶层 bundle 行有效；base bundle 的 tool-workflow 就是顶层行）
- id: tool-workflow
  disabled: true
```

注意：web/desktop 部署的官方行可能声明在 **agent preset 组内**——profile patch 够不着那种行（与 dsh-tool-todo-plus 的结论一致）。这种部署请保持共存模式：官方工具照常跑，saved 五件套并行上线，`workflow_run_saved` 用官方引擎启动存的脚本，两条路完全等价。

## 配置（patch 行 config）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `toolName` | `'workflow'` | fork 本体的注册名；想与官方并存两个工具时改成别的名字 |
| `savedTools` | `true` | 是否注册 saved 五件套 |
| `enableRunInBackground` | `true` | `run_in_background` 开关（fork 与 `workflow_run_saved` 共用；需 `ctx.jobs`） |
| `maxResultChars` | `50000` | 渲染结果截断上限 |

未知键在启动时抛错（降级为 warn + 本插件禁用），不静默忽略。

## 与其他 workflow 插件的差异

- `omdsh-dev/dsh_workflow`、`dsh-harness-one` 等：独立的重型 workflow 层（自建引擎/治理/恢复），**不是**官方工具的 fork；
- `988hj7tczd-oss/dsh-workflow-templates`：只内置固定模板，没有模型可写的保存路径，且明确让位官方工具；
- 本插件：官方 fork 的轻量 drop-in + 模型运行时可写的 saved library——引擎、校验、UI 折叠全部复用官方设施。

## 纪律与边界

- 绝不 `export default`；apply() 内零 IO，激活永不失败（输家优雅退出）；
- 工具名撞车确定性让位（先查后注册，不赌加载顺序）；
- saved 库是**共享存储**：system prompt 分区要求模型 review 后再改/删、删除非本会话创建的工作流前先确认；
- 引擎能力边界与官方一致：脚本无文件系统/网络/Node API，只靠 `agent()` 等 hook 干活。

## 开发

```bash
# Git Bash（仓库根目录）
npm install
npm run build     # tsc 类型检查 + esbuild bundle（--packages=external，产物只含第一方代码）
npm test          # vitest，55 用例
npm run smoke     # 构建产物 + 打桩宿主的端到端冒烟
```

发布：`npm publish` 由维护者本人执行（2FA/EOTP）。

## License

MIT
