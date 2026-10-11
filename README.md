<div align="center">

# dsh-tool-workflow-plus

**官方 workflow 工具的 drop-in 增强 fork —— 补上 saved workflows，让编排脚本可以存下来、下次直接跑。**

[![npm version](https://img.shields.io/npm/v/dsh-tool-workflow-plus)](https://www.npmjs.com/package/dsh-tool-workflow-plus)
[![npm downloads](https://img.shields.io/npm/dt/dsh-tool-workflow-plus)](https://www.npmjs.com/package/dsh-tool-workflow-plus)
[![license](https://img.shields.io/npm/l/dsh-tool-workflow-plus)](./LICENSE)
[![node](https://img.shields.io/node/v/dsh-tool-workflow-plus)](./package.json)
![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.0--rc.2-blue)

</div>

官方 [`@deepseek-ai/dsh-tool-workflow`](https://www.npmjs.com/package/@deepseek-ai/dsh-tool-workflow) 的模型面（参数 schema、run 生命周期、会话事件、UI 折叠）从 0.2.1-alpha.2 逐字移植，增量只有一件事：**官方 README 明确写着 "No saved or nested workflows — caller-supplied scripts only"，本插件补上持久化的 saved workflow 库**——模型把跑通过的编排脚本存入库，下次会话一行 `workflow_run_saved` 带新参数直接复跑，不用重发整段脚本。

## ✨ 特性一览

- **saved workflow 库**：`workflow_save` / `workflow_list` / `workflow_get` / `workflow_delete` / `workflow_run_saved` 五件套，存取删跑全闭环；
- **零配置持久化**：走官方 storage 子系统的 domain KV（自有域 `workflow_saved`，per-record 文档），标准部署默认路由 json backend，装上即用；
- **与引擎同口径的保存期校验**：meta 形状逐条对齐引擎的 META_INVALID 规则，脚本拒绝携带 `export const meta` 块——不会出现"存得进、跑不起来"的记录；
- **官方 UI 无缝折叠**：发起的 run 写入与官方同名的 `tool-workflow/*` durable 会话事件，`dsh-client-ui-workflow-run` 照常渲染；
- **让位纪律**：官方工具已占住 `workflow` 名时 fork 自动让位（纯增量共存）；存储栈缺失时 saved 工具调用报错点名缺失件，激活永不失败；
- **后台执行**：`workflow_run_saved` 支持 `run_in_background`，与官方同款 job 语义（job 输出环实时镜像进度）。

## 📦 安装

```bash
# Git Bash
dsh plugin add dsh-tool-workflow-plus
```

或在 profile 的 bundle 依赖里加入 `dsh-tool-workflow-plus` 后重载。

## 🚀 快速开始

安装后模型会多出六个工具。典型的一次闭环：

**第一次跑通后存入库**（模型视角）：

> **workflow_save**
>
> ```json
> {
>   "meta": {
>     "name": "code-audit",
>     "description": "对一批文件做审计，再做一轮对抗校验",
>     "whenToUse": "用户要求大范围代码审计时",
>     "phases": [{ "title": "scan" }, { "title": "verify" }]
>   },
>   "script": "const files = args.files\nconst found = await pipeline(files,\n  f => agent(`审计 ${f}，输出问题列表`, { phase: 'scan' }),\n  (issues, f) => agent(`对抗校验：${JSON.stringify(issues)}`, { phase: 'verify' })\n)\nreturn found"
> }
> ```
>
> → `{"kind":"saved","name":"code-audit","overwritten":false,"scriptChars":214,...}`

**之后的任何会话，一行复跑**：

> **workflow_run_saved** `{ "name": "code-audit", "args": { "files": ["src/a.ts", "src/b.ts"] } }`

模型每次调用都能看到工具描述里的使用纪律：写长脚本前先 `workflow_list` 查库，跑通了就 `workflow_save`。同名再存默认拒绝，`overwrite: true` 才覆盖（保留原始 `createdAt`）。

## 🧰 工具面

| 工具 | 作用 |
| --- | --- |
| `workflow` | fork 本体，与官方等价；description 末尾追加 saved 库纪律。与官方共存时自动让位 |
| `workflow_save` | 存 `{meta, script}`，key = `meta.name`；同名冲突默认拒绝 |
| `workflow_list` | 列出全部（名称/描述/whenToUse/phases/脚本大小，按更新时间倒序，不含脚本体） |
| `workflow_get` | 取完整记录（含脚本），供审阅、修改后重存 |
| `workflow_delete` | 按名删除 |
| `workflow_run_saved` | 用存的脚本 + meta 启动引擎，注入新 `args`；支持 `run_in_background` |

参数细节与官方 `workflow` 工具一致：脚本契约是裸 JS body（无文件系统/网络/Node API，hook 用法见官方工具描述），`meta` 是纯 JSON 数据，`args` 作为 `args` 全局注入脚本。

## ⚙️ 配置

patch 行 `config`，全部可选，未知键启动即报错（不会静默忽略）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `toolName` | `'workflow'` | fork 本体的注册名；想与官方并存两个工具时改掉 |
| `savedTools` | `true` | 是否注册 saved 五件套 |
| `enableRunInBackground` | `true` | `run_in_background` 开关（fork 与 `workflow_run_saved` 共用；需 `ctx.jobs`） |
| `maxResultChars` | `50000` | 渲染结果截断上限 |

## 🗄 存储与持久化

- 自有域 `workflow_saved`（单表 `workflows`，`per-record` layout，每条一个文档——脚本大、可单条清理）；
- record：`{ meta, script, createdAt, updatedAt }`（zod strict，坏记录整库拒绝打开——saved 脚本是用户资产，不是可丢弃的派生缓存）；
- 标准 base bundle（`backend: json`）下落在 `dshHomePath('storages')`，跨会话存活；
- 没挂 storage 三件套的部署：激活不受影响，saved 工具调用返回点名缺失件的错误。

## 🤔 什么时候用 / 什么时候不用

**适合**：

- 你反复让模型写相似的多 agent 编排脚本，希望"跑通一次、存下来、以后复用"；
- 你想把官方 workflow 工具换成带 saved 库的版本（drop-in 接管，见下节）；
- 你的部署本来没挂官方 workflow 插件，想要一个行为等价 + 带库的版本。

**不适合**：

- 需要可视化编排、治理、恢复等重型能力——那是 [`omdsh-dev/dsh_workflow`](https://github.com/omdsh-dev/dsh_workflow)、`dsh-harness-one` 这类独立 workflow 层的领域，本插件刻意不碰；
- 只想要固定模板素材、不需要模型运行时写入——[`dsh-workflow-templates`](https://github.com/988hj7tczd-oss/dsh-workflow-templates)（12 个内置模板，明确让位官方工具）更轻；
- 多个 saved workflow 同时大批量运行——存储域只管"存"，并发调度仍由引擎与 `ctx.jobs` 的既有语义决定。

## 🔀 与官方工具的关系

默认**共存**：patch 行只插入本插件。官方已占住 `workflow` → fork 让位（warn 一行），本插件是纯增量的 saved 库，官方工具照常工作；官方不在（headless/sdk 等组合）→ fork 以 `workflow` 之名上线。

想让 fork **接管** `workflow` 名（模型看到的是带 saved 库提示的版本），在 profile patch 里追加：

```yaml
- id: tool-workflow
  disabled: true
```

> 注意：web/desktop 部署的官方行可能声明在 **agent preset 组内**，profile patch 够不着那种行（与 dsh-tool-todo-plus 的结论一致）。这种部署保持共存即可——`workflow_run_saved` 复用同一引擎，与官方工具完全等价。

## ❓ FAQ

**saved 工具调用报 "saved workflow storage unavailable"？**
部署没挂 storage 栈。加载 `@deepseek-ai/dsh-storage` + 一个 kv backend（`dsh-storage-json` 或 `dsh-storage-sqlite`）+ `@deepseek-ai/dsh-storage-domain`（标准 base bundle 默认全有）。

**日志里有 "tool "workflow" is already registered — standing by"？**
正常让位行为：官方 tool-workflow 已注册了 `workflow`，本插件只上线五件套。想接管看上一节；或把 `toolName` 改成别的名字并存。

**`workflow_save` 报 "already saved"？**
同名工作流已存在且未带 `overwrite: true`。先 `workflow_get` 看看现存版本，确认要覆盖再显式传 `overwrite: true`——库不会让你误删别人的版本。

**npm 页面上的 README 和 GitHub 不一致？**
npm 页面展示的是发布时打进 tarball 的 README。GitHub 上的更新要等下一个 npm 版本才会在 npm 页面生效。

**脚本里的 `export const meta` 为什么不让存？**
工具契约是"裸 JS body + meta 作为 JSON 参数"，引擎对带 meta 块的脚本会 SCRIPT_PARSE。存一条永远跑不起来的脚本没有意义，保存期就拦下。

## 🛠 开发

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
