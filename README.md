# dsh-trace-repeat

任务 Trace 记录/回放插件（DSH Web）：**原子、版本化**地记录任意会话的执行 trace——每次**推理完成**（assistant 消息收齐所有 chunk 后的最终消息）或 **tool 执行完成** 就是一个**不可变版本**，含完整可复现元数据（provider/model/reasoningEffort/maxTokens/token 用量/输入输出）；支持**回放**（版本时间线 + 详情）与**从历史版本恢复执行**；与 **task-control 暂停/恢复** 衔接；多版本经 **git commit + worktree** 物化。

## 功能

| 环节 | 行为 |
|---|---|
| **记录** | 宿主订阅 `session/event`（post-commit 馈送，按序）：`assistant/message` → `reasoning` 版本；`tool/call`+`tool/result` → `tool` 版本（含工具名/参数/结果）；普通用户输入 → `user` 版本；不记 chunk 增量，只记收齐后的最终消息 |
| **原子性** | 每版本一个不可变 JSON（tmp 写 + rename 原子落盘），`trace.json` 索引同样原子更新；按源事件 seq 幂等去重 |
| **可复现元数据** | provider/model/reasoningEffort/maxTokens/usage/完整 content（推理）；工具名/callId/参数/结果/isError（工具）；会话头记 workspace/cwd/preset/agentOptions |
| **git 版本化** | 默认开启：trace 根（`.dsh-trace/`）即专用 git 仓库（自动 init，不污染工作区），每版本一个 commit；worktree 物化在 `.dsh-trace-worktrees/<session>-v<seq>`（git 不允许 worktree 建在仓库内） |
| **暂停/恢复** | 观察 `task-control/paused`/`resumed` 事件：暂停后推理/tool 不再产生版本（以暂停点为界），恢复时记一个 `resumed` 标记版本并续记；与 task-control 完全解耦 |
| **回放** | 设置页「Trace 回放」+ `/trace` 命令族：会话选择 → 版本时间线（类型/时间/git commit）→ 详情（完整输入输出 + 元数据）→ 打开 worktree / 从此版本恢复 |
| **恢复执行** | `/trace resume <session> <vN>`：以 vN 前 trace 重建**平衡上下文**（自动截断到最近一个无悬挂 tool 调用的「推理完成」版本），在对应 worktree 里**新开会话**继续执行，新会话自身继续被记录 |

## 限制

- 只记录**收齐后**的最终消息（不含流式增量）。
- 恢复执行只能在「推理完成」版本（无悬挂 tool 调用）进行；回合中间版本会报错并提示更早的平衡版本。
- 回放/恢复不修改原会话 trace；新会话产生独立 trace。
- git 物化只覆盖 trace 文件（不含该时刻工作区文件快照）。

## 安装

与 `dsh-task-batch` 同流程：

```bash
dsh plugin --profile web add /Users/wx/Desktop/DSH/dsh-trace-repeat
# 然后在 /Users/wx/.dsh/profiles/web/package.json 的 dsh.profile.bundles 追加 "dsh-trace-repeat"
```

重启 dsh web 后生效。

## 使用

- 任意会话运行即自动记录（无需开启）。
- 设置 →「Trace 回放」：选会话 → 版本时间线 → 详情 / worktree / 恢复。
- 命令：`/trace`（列会话）、`/trace show <session> [vN]`、`/trace resume <session> <vN>`。

## 结构

```
dsh-trace-repeat/
├── package.json          # dsh.bundle.patch + dsh.client(platform: web) 声明
├── cordis.patch.yml      # 一行双面行：- id: trace-repeat / name: dsh-trace-repeat
├── lib/
│   ├── index.js          # 宿主端：记录器 + 原子存储 + git/worktree + /trace 命令 + /trace-repeat 路由 + 恢复执行（零外部 import）
│   └── client.js         # 浏览器端：设置页「Trace 回放」面板（__ModuleLoader__ 格式）
└── test/
    └── host-smoke.mjs    # 宿主端逻辑冒烟测试（node test/host-smoke.mjs）
```
