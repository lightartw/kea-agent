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

`.env` 中至少启用一家 provider。只启用一家时自动作为默认；同时启用多家时必须设置 `DEFAULT_PROVIDER`。以下是三组内置 provider 配置：

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

Client 自动检测时只检查 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 和 `GEMINI_API_KEY`。没有发现 provider 会抛出配置错误；同时发现多家但没有设置 `DEFAULT_PROVIDER` 也会抛错。它不会根据模型名、URL、key 内容、已安装 SDK 或网络请求猜测 provider。

CLI 启动时使用 `dotenv.config({ override: true })` 加载 `.env`。公共库入口本身不会加载 `.env`，也不会在导入时创建 provider client。

## 使用方法

程序启动后，在 `>>` 提示符后输入任务并回车。模型产生的工具调用会显示为 `[tool]`，执行状态使用 `[exec]`、`[done]`、`[error]` 或 `[rejected:*]`。只有被 Bash 安全策略归为 `ask` 的命令会请求确认，直接回车默认拒绝；硬拒绝命令不会询问。输入 `q`、`exit` 或直接按空回车退出。

请只在可信目录中运行本程序，并检查模型生成的命令。BashTool 具有最小危险片段拦截，但它不是完整沙箱，也不能替代系统权限隔离。

在 Windows 上，BashTool 优先使用 Git Bash；未安装时使用 `bash.exe`（例如 WSL）。因此模型生成的命令统一采用 Bash 语法，例如 Windows 目录在 WSL 中写为 `/mnt/d/project`，不要使用 `cd D:\\project`。

## 启动路径

```text
createStreamFn → createCodingAgent → continueRecent → cli.run(codingAgent, harness)
```

`main.ts` 加载环境变量并创建 `CliFrontend`（其 `interactions` 实现
`CodingAgentInteractions`）。`createCodingAgent()` 组装 Project 级能力，`continueRecent()` 打开最近
修改的 Session（没有历史时创建），最后 `cli.run(codingAgent, harness)` 进入交互循环。

```ts
const cli = new CliFrontend();
const { stream, defaultModel } = createStreamFn();
const codingAgent = await createCodingAgent({
  project: { workDir: process.cwd(), storageDir: ".kea" },
  streamFn: stream,
  model: defaultModel,
  interactions: cli.interactions,
});
const harness = await codingAgent.continueRecent();
await cli.run(codingAgent, harness);
```

## 包结构

| 包 | README | 职责 |
|----|--------|------|
| `ai` | [ai/README.md](src/ai/README.md) | LLM 客户端抽象、StreamFn、消息类型 |
| `agent` | [agent/README.md](src/agent/README.md) | Agent loop、Hook Call、工具注册、AgentEvent |
| `harness` | [harness/README.md](src/harness/README.md) | 运行时、Session、平坦 HarnessEvent、Hook 透传 |
| `coding-agent` | [coding-agent/README.md](src/coding-agent/README.md) | 默认工具定义、Bash 策略、permission Hook、交互 port |
| `ui` | — | 具体 CLI UI：交互适配、Harness event 渲染、Coding Tool presentation 消费 |

源码依赖方向始终向下：`ui -> coding-agent -> harness -> agent -> ai`。

## 工具系统

`createCodingAgent()` 在内部组装 `CodingToolDefinition`（可带 presentation），并为每个 Harness
创建独立的 `AgentToolRegistry` 与工具实例。默认内置工具为：

- `bash` — shell 命令执行
- `read_file`、`write_file`、`edit_file` — 文件操作
- `glob` — 文件通配符匹配
- `todo_write` — 任务列表管理（presentation 渲染 details）

## Hooks 与权限

Hook 系统位于 `agent/hooks/`，提供类型化的控制通道（`Hook Call` = 控制请求，返回结果；
`AgentEvent` = 观察事实，无返回）。默认只注册一个真正改变控制流的 Hook：

- **Permission** — Bash 命令的 allow/ask/deny 策略，通过 `CodingAgentInteractions.confirm()` 询问

被动的展示（工具调用日志、大输出提醒、工具计数 summary）不是 Hook，而是 UI 层针对
Harness `subscribe` 事件的 renderer 行为。

Bash 安全策略分为三层：
1. **硬拒绝**（`sudo`、`mkfs`、`> /dev/`、`rm -rf /` 等）：Hook 和 bash 工具定义均阻止，不询问 UI
2. **询问**（`rm`、`> /etc/`、`chmod 777`）：通过交互 port 确认；无交互时 fail-closed
3. **允许**：直接放行

文件工具始终拒绝 workspace 路径逃逸。权限确认只是防误操作机制，不是完整沙箱。

## 三种 UI 的边界

三种相近但不同的能力对应三条通道，不要混淆：

- **Hook UI（交互 port）**：Hook 需要用户决策时的交互端口（`CodingAgentInteractions.confirm`/`notify`），属于控制通道。
- **Harness UI**：订阅 `HarnessEvent` 后渲染已确定的运行事实（含 `run_start`/`run_end`），属于观察通道。
- **Tool UI（presentation）**：Harness UI 内部针对工具事件按工具名分派的专用 presentation（如 `todo_write`），不是第四套运行机制。

具体实现集中在 `src/ui`（`cli-frontend.ts`、`cli-harness-renderer.ts`、`cli-interactions.ts`），
`agent`、`harness` 与 `coding-agent` 不 import `src/ui`；`src/ui` 也不 import `src/agent`。

## CLI 与核心边界

`main.ts` 负责加载环境变量并组装 stream、`CodingAgent`、`AgentHarness` 和 CLI。`CliFrontend`
（位于 `src/ui/cli-frontend.ts`）把自己的 `interactions` 注入 `createCodingAgent()`，并通过
`run(codingAgent, harness)` 订阅 Harness 事件；工具事件由
`codingAgent.renderToolEvent(event)` 使用对应 presentation 渲染。未来 TUI 可以消费相同的
`CodingAgent`、`HarnessEvent`、Session 和 details，而不改动 Agent loop。

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
- 提示配置了多家 provider：设置 `DEFAULT_PROVIDER`，值为 `anthropic`、`openai` 或 `gemini` 中已配置的一项；也可以移除暂时不用的 API key。
- SDK 提示缺少 API key：确认所选 provider 的 key 非空且 CLI 已加载正确的 `.env`。
- 自定义接口无法连接：检查对应的 `*_BASE_URL`、网络以及服务端支持的模型标识。
- 安装成功但调用失败：本地依赖安装成功不代表凭据、网络或 provider 服务可用。
