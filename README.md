# dsh-trace-repeat

任务 Trace 记录/回放插件（DSH Web）：**原子、版本化**地记录任意会话的执行 trace——每次**推理完成**（assistant 消息收齐所有 chunk 后的最终消息）或 **tool 执行完成** 就是一个**不可变版本**，含完整可复现元数据（provider/model/reasoningEffort/maxTokens/token 用量/输入输出）；支持**回放**（版本时间线 + 详情）与**从历史版本恢复执行**；与 **task-control 暂停/恢复** 衔接；多版本经 **git commit + worktree** 物化。

## 功能

| 环节 | 行为 |
|---|---|
| **记录** | 宿主订阅 `session/event`（post-commit 馈送，按序）：`assistant/message` → `reasoning` 版本；`tool/call`+`tool/result` → `tool` 版本（含工具名/参数/结果）；普通用户输入 → `user` 版本；不记 chunk 增量，只记收齐后的最终消息 |
| **原子性** | 每版本一个不可变 JSON（tmp 写 + rename 原子落盘），`trace.json` 索引同样原子更新；按源事件 seq 幂等去重 |
| **可复现元数据** | provider/model/reasoningEffort/maxTokens/usage/完整 content（推理）；工具名/callId/参数/结果/isError（工具）；会话头记 workspace/cwd/preset/agentOptions |
| **git 版本化** | 默认开启：trace 根（`.dsh-trace/`）即专用 git 仓库（自动 init，不污染工作区），每版本一个 commit；worktree 物化在 `.dsh-trace-worktrees/<session>-v<seq>`（git 不允许 worktree 建在仓库内） |
| **暂停/恢复** | 通过 `taskControl` 服务（task-control 自管的持久化状态，Route A：不再写 `task-control/*` 会话事件）在**每个会话事件上对账**：安全暂停（延迟语义）下 tool 运行期间 trace 持续记录、`tool/result` 落地后（安全界限）才暂停；**强制暂停**的 paused 版本记录 `forced` 与 `interruptedTool` 详情；恢复时记 `resumed` 标记版本并续记；与 task-control 通过服务解耦 |
| **回放** | `/trace` 命令族：会话选择 → 版本时间线（类型/时间/git commit）→ 详情（完整输入输出 + 元数据）→ 从该版本恢复（自动物化 worktree） |
| **恢复执行** | `/trace resume <session> <vN>`：以 vN 前 trace 重建**平衡上下文**（自动截断到最近一个无悬挂 tool 调用的「推理完成」版本），在对应 worktree 里**新开会话**继续执行，新会话自身继续被记录 |

## 限制

- 只记录**收齐后**的最终消息（不含流式增量）。
- 恢复执行只能在「推理完成」版本（无悬挂 tool 调用）进行；回合中间版本会报错并提示更早的平衡版本。
- 回放/恢复不修改原会话 trace；新会话产生独立 trace。
- git 物化只覆盖 trace 文件（不含该时刻工作区文件快照）。
- 暂停/恢复标记版本在「暂停/恢复后的下一个会话事件」时写入（状态来自 `taskControl` 服务对账）；纯暂停+恢复且中间无任何事件时不会产生标记版本。

## 安装

包内已含 `dsh.bundle` manifest，安装后自动激活（无需手动修改任何配置）：

```bash
# 从 GitHub 安装
dsh plugin --profile web add github:p2coder/dsh-trace-repeat
# 发布 npm 后亦可：dsh plugin --profile web add dsh-trace-repeat
```

安装后**完整重启 dsh web**（宿主插件不支持运行时热装），并在浏览器中刷新页面。

## 使用

- 任意会话运行即自动记录（无需开启）。
- 命令：`/trace`（列会话）、`/trace show <session> [vN]`（版本时间线/详情）、`/trace resume <session> <vN>`（从该版本恢复执行）。

## 结构

```
dsh-trace-repeat/
├── package.json          # dsh.bundle.patch 声明（纯宿主端，无浏览器半）
├── cordis.patch.yml      # 一行：- id: trace-repeat / name: dsh-trace-repeat
├── lib/
│   └── index.js          # 宿主端：记录器 + 原子存储 + git/worktree + /trace 命令 + 恢复执行（零外部 import）
└── test/
    └── host-smoke.mjs    # 宿主端逻辑冒烟测试（node test/host-smoke.mjs）
```
