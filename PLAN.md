# Kea 实现计划与完成记录

> 本文件是课程提交入口。细粒度的原始计划保存在
> `docs/superpowers/plans/`；这里按可独立验收的功能聚合，并持续记录
> 依赖、测试方法和完成 commit。

## 目标

交付一个 TypeScript 终端 Coding Agent Harness：它自行实现模型调用循环、
工具分发、会话持久化、危险操作治理和分层 JSON 配置；核心机制可用 mock LLM
在无网络环境下确定性测试，并可通过 `npm install -g .` 全局安装运行。

## 全局约束

- Node.js 24，TypeScript 7，测试框架为 `node:test`。
- 依赖方向保持为 `ui -> coding-agent -> harness -> ai`。
- 核心机制测试不得依赖真实 LLM、真实 API Key 或网络。
- 每个模型产生的工具调用必须得到且仅得到一个持久化工具结果。
- 凭据不得进入项目配置、日志、Git 历史或错误消息；正式运行不依赖 `.env`。
- 本项目为个人、本地优先的 CLI；PR 流程和 WebUI 部署不在本次及格范围。

## 依赖与并行关系

```text
配置与凭据 ──> CLI 生命周期
          └─> Provider 协议分离 ──> 内置工具 ─┐
循环治理/事件 ─────────────> 会话持久化 ────────┤
权限与安全 ──────────────────────────────────> 终端 UI
全功能与测试稳定 ───────────────────────────> 分发与 CI
```

## Task 1：分层配置与凭据边界

**状态：** 已完成
**完成 commits：** `9fa9376`、`49b7e8e`、`1a4ae22`

**目标：** 读取用户、项目与 `--config` 三层 JSON 配置，按优先级合并校验；凭据
只从 `~/.kea/auth.json` 读取；首次运行自动创建缺失模板且不覆盖已有文件。

**文件：**

- `src/coding-agent/config/config.ts`
- `src/coding-agent/config/schema.ts`
- `src/coding-agent/config/defaults.ts`
- `src/coding-agent/config/templates.ts`
- `tests/coding-agent/config/`

**验证：**

    npm run build
    node --test dist/tests/coding-agent/config/*.test.js

详细步骤：
`docs/superpowers/plans/2026-08-18-readline-application-configuration.md`。

## Task 2：CLI 生命周期与交互

**状态：** 已完成
**完成 commits：** `7eda976`、`8856b70`、`2460106`、`4baa78a`、`4a8eaed`

**目标：** 提供 `kea [directory] [-c] [--verbose] [--config <path>]`；交互命令
`/new`、`/session`、`/model`、`/help`、`/exit`；`Ctrl+C` 中止、`Ctrl+D` 退出；
`-c` 恢复最近会话。不提供 `init`（首次运行自动建配置）。

**文件：**

- `src/main.ts`
- `src/coding-agent/cli/args.ts`
- `src/coding-agent/cli/project-directory.ts`
- `src/ui/commands.ts`
- `tests/main.test.ts`、`tests/ui/commands.test.ts`

**验证：**

    npm run build
    node --test dist/tests/main.test.js dist/tests/ui/commands.test.js

## Task 3：确定性的循环治理与事件

**状态：** 已完成
**完成 commits：** `fdf5890`（agent 合入 harness）

**目标：** 统一 Agent 循环与 Harness，通过代码限制 turn 数，保持取消、停止原因
和工具结果基数可预测；事件系统收敛为 `emit/intercept`。

**文件：**

- `src/core/harness/agent-harness.ts`
- `src/core/harness/agent-loop.ts`
- `src/core/events/`
- `tests/harness/agent-harness.test.ts`、`tests/harness/agent-loop.test.ts`

**验证：**

    npm run build
    node --test dist/tests/harness/agent-harness.test.js dist/tests/harness/agent-loop.test.js

详细步骤：
`docs/superpowers/plans/2026-08-16-model-runtime-and-agent-stopping.md`。

## Task 4：内置工具集

**状态：** 已完成
**完成 commits：** `2026-08-17` built-in tools 计划对应实现

**目标：** 提供六个工具：`bash`、`read_file`、`write_file`、`edit_file`、`glob`、
`todo_write`。每个工具路径相对会话 cwd 解析，并受权限与超时约束。

**文件：**

- `src/coding-agent/tools/factory.ts`
- `src/coding-agent/tools/builtin/`
- `tests/coding-agent/tools/builtin/`

**验证：**

    npm run build
    node --test dist/tests/coding-agent/tools/builtin/*.test.js

详细步骤：`docs/superpowers/plans/2026-08-17-built-in-tools.md`。

## Task 5：权限与安全治理

**状态：** 已完成
**完成 commits：** `2026-08-17` permission 计划对应实现

**目标：** Bash 命令按 allow/ask/deny 分类；硬拒绝 `sudo`、`mkfs`、`dd` 原始写入、
`/dev` 重定向、递归强制根删除；询问 `rm`、写 `/etc/`、`chmod 777`；文件工具限制在
项目目录内。

**文件：**

- `src/coding-agent/events/permission/`
- `src/utils/workspace.ts`
- `tests/coding-agent/events/permission/`

**验证：**

    npm run build
    node --test dist/tests/coding-agent/events/permission/*.test.js

详细步骤：
`docs/superpowers/plans/2026-08-17-permission-events-interactions.md`。

## Task 6：会话持久化

**状态：** 已完成
**完成 commits：** `ed43a12`（title 改为 header 字段）

**目标：** 以 JSONL 保存父链会话树；header 含 id/cwd/title/createdAt/updatedAt；
恢复时显式校验，损坏存储报错而不静默掩盖；标题生成失败回退到首条 prompt 文本。

**文件：**

- `src/core/harness/session/`
- `tests/harness/session.test.ts`、`tests/harness/session-repository.test.ts`

**验证：**

    npm run build
    node --test dist/tests/harness/session*.test.js

详细步骤：`docs/superpowers/plans/2026-08-16-session-refactor.md`。

## Task 7：Provider 协议分离与终端 UI

**状态：** 已完成
**完成 commits：** `6a9d6ff`、`c3b1f77`、`2a625ba`、`7e285f3`

**目标：** provider 与协议分离、支持多模型并按 provider 分组切换；UI 默认显示
thinking、紧凑工具详情，补齐 text/thinking 块的 start/end 事件贯通流。

**文件：**

- `src/core/ai/`
- `src/ui/cli/`
- `tests/ai/`、`tests/ui/cli/`

**验证：**

    npm run build
    node --test dist/tests/ai/*.test.js dist/tests/ui/cli/*.test.js

详细步骤：
`docs/superpowers/plans/2026-08-18-ai-provider-protocol-model.md`。

## Task 8：分发、文档与 CI

**状态：** 已完成
**完成 commits：** `ed43a12` 之后的 README/CI 同步（未提交，见工作区）

**目标：** 以 `npm install -g .` 全局分发（`bin` 指向 `dist/src/main.js`）；README
覆盖安装、运行、分发与卸载命令；CI 提供 `unit-test` job（`npm ci` + `npm run typecheck`
+ `npm test`）。

**文件：**

- `package.json`（`bin`）
- `README.md`
- `.gitlab-ci.yml`、`.github/workflows/ci.yml`

**验证：**

    npm test
    git diff --check

## 完成定义

- [x] 六个 harness 维度均有可运行实现（配置、CLI、循环治理、工具、权限、会话）。
- [x] 核心治理与停止机制可脱离真实 LLM 测试。
- [x] 有一键测试命令，`npm test` 331/333 通过（2 跳过）。
- [x] 有 npm 全局安装分发及安装、运行、卸载、安全边界说明。
- [x] 详细设计与细粒度计划保存在 `docs/superpowers/`。
- [ ] 最后一次 CI 运行为绿色（需提交并 push 后确认）。

## 计划维护说明

早期细粒度计划中的 checkbox 保留了实施时的原始状态，完成事实以本文件列出的
commit、当前源码及自动化测试为准。本轮课程材料与当前提交位于同一分支，其 hash
通过 `git log` 查询，避免在提交内容中产生无法自引用的 hash。远程 CI 通过后再把
最后一项完成定义标记为已完成。
