# Kea Agent

一个最小化的 TypeScript 命令行编程代理。它在当前工作目录中执行 shell 命令，支持 Anthropic、OpenAI 或 Gemini 作为模型后端。

当前版本专注于核心 Agent loop；TUI 尚未加入。

架构文档：[docs/architecture.md](docs/architecture.md)

## 环境要求

- Node.js 24 LTS
- npm 11 或 Node.js 24 自带的兼容 npm 版本
- Anthropic、OpenAI 或 Gemini 中任意一家可用的 API 凭据

## 初始化（Linux / macOS）

```bash
npm ci
cp .env.example .env
$EDITOR .env
npm run build
npm start
```

如果本地已经存在 `.env`，请跳过复制命令，避免覆盖凭据。

## Windows PowerShell

```powershell
npm ci
Copy-Item .env.example .env  # 仅首次使用且 .env 不存在时执行
notepad .env
npm run build
npm start
```

## Provider 配置

`.env` 中必须且只能启用一家 provider。以下三组配置任选其一：

```dotenv
ANTHROPIC_API_KEY=你的_API_密钥
MODEL_ID=claude-模型标识
ANTHROPIC_BASE_URL=可选的兼容接口地址
```

```dotenv
OPENAI_API_KEY=你的_API_密钥
MODEL_ID=gpt-模型标识
OPENAI_BASE_URL=可选的兼容接口地址
```

```dotenv
GEMINI_API_KEY=你的_API_密钥
MODEL_ID=gemini-模型标识
GEMINI_BASE_URL=可选的兼容接口地址
```

Client 自动检测时只检查 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 和 `GEMINI_API_KEY`。没有发现 provider 或同时发现多家 provider 都会抛出配置错误；不会根据模型名、URL、key 内容、已安装 SDK 或网络请求猜测。

CLI 启动时使用 `dotenv.config({ override: true })` 加载 `.env`。公共库入口本身不会加载 `.env`，也不会在导入时创建 provider client。

## 使用方法

程序启动后，在 `>>` 提示符后输入任务并回车。模型产生的工具调用会以 `$` 前缀显示。Bash 命令会在执行前请求确认，直接回车默认拒绝。输入 `q`、`exit` 或直接按空回车退出。

请只在可信目录中运行本程序，并检查模型生成的命令。BashTool 具有最小危险片段拦截，但它不是完整沙箱，也不能替代系统权限隔离。

在 Windows 上，BashTool 优先使用 Git Bash；未安装时使用 `bash.exe`（例如 WSL）。因此模型生成的命令统一采用 Bash 语法，例如 Windows 目录在 WSL 中写为 `/mnt/d/project`，不要使用 `cd D:\\project`。

## 启动路径

```text
createStreamFn → Session.create → createHarness → CliFrontend
```

`main.ts` 加载环境变量，创建 `CliFrontend`（实现 `CodingHookUI`），通过 `createHarness` 组装 Agent，最后调用 `cli.run(harness)`。

## 包结构

| 包 | README | 职责 |
|----|--------|------|
| `ai` | — | LLM 客户端抽象、StreamFn、消息类型 |
| `agent` | [agent/README.md](src/agent/README.md) | Agent loop、Hook、工具注册、AgentEvent |
| `agent/harness` | [harness/README.md](src/agent/harness/README.md) | 运行时、Session、订阅、Hook 透传 |
| `coding-agent` | [coding-agent/README.md](src/coding-agent/README.md) | 默认工具集、Bash 策略、五个 Hook、UI port |

## 工具系统

工具通过 `AgentToolRegistry` 注册。每个工具继承 `AgentTool<TParameters>`，使用 TypeBox 定义参数 schema，并实现异步 `execute()`。默认工具集由 `createToolRegistry()` 创建，注册：

- `BashTool` — shell 命令执行
- `ReadFileTool`、`WriteFileTool`、`EditFileTool` — 文件操作
- `GlobTool` — 文件通配符匹配
- `TodoWriteTool` — 任务列表管理

## Hooks 与权限

Hook 系统位于 `agent/hooks/`，提供类型化的控制通道。五个默认 Hook 在 `coding-agent/hooks/` 中定义：

- **Context Inject** — 通知当前工作目录
- **Permission** — Bash 命令的 allow/ask/deny 策略，通过 `CodingHookUI.confirm()` 询问
- **Log** — 记录每次工具调用
- **Large Output** — 大输出提醒
- **Summary** — 会话停止时统计工具调用次数

Bash 安全策略分为三层：
1. **硬拒绝**（`sudo`、`mkfs`、`> /dev/`、`rm -rf /` 等）：Hook 和 BashTool 均阻止，不询问 UI
2. **询问**（`rm`、`> /etc/`、`chmod 777`）：通过 UI port 确认；无 UI 时 fail-closed
3. **允许**：直接放行

文件工具始终拒绝 workspace 路径逃逸。权限确认只是防误操作机制，不是完整沙箱。

## CLI 与核心边界

`main.ts` 负责加载环境变量并组装 stream、session、harness 和 CLI。`CliFrontend` 实现 `CodingHookUI`，处理 `readline`、ANSI 展示和权限确认。未来 TUI 可以消费相同的 `AgentEvent` 并提供自己的权限交互，而不改动 Agent loop。

## AI 层

`createStreamFn()` 默认根据唯一存在的 API key 环境变量选择 provider，也支持显式配置。该工厂函数返回 `{ stream, defaultModel }`，其中 `stream` 是 Agent 层注入的 `StreamFn`。

详见 AI 层源码（`src/ai/`）。

## 开发与验证

```bash
npm run typecheck
npm test
npm run build
```

测试使用 Node.js 内置 test runner。`npm test` 会先编译到 `dist/`，再运行编译后的测试。

## 更新依赖

依赖使用精确版本并由 `package-lock.json` 锁定。例如：

```bash
npm install --save-exact openai@6.48.0
npm install --save-dev --save-exact typescript@7.0.2
```

更新后运行 `npm test`、`npm run typecheck`，并提交 `package.json` 与 `package-lock.json`。

## 常见问题

- 启动时提示缺少 `MODEL_ID`：确认 `.env` 存在且该变量非空。
- 提示没有配置 provider：填写三家 API key 中的一项。
- 提示配置了多家 provider：只保留当前要使用的一项 API key。
- SDK 提示缺少 API key：确认所选 provider 的 key 非空且 CLI 已加载正确的 `.env`。
- 自定义接口无法连接：检查对应的 `*_BASE_URL`、网络以及服务端支持的模型标识。
- 安装成功但调用失败：本地依赖安装成功不代表凭据、网络或 provider 服务可用。
