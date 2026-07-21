# Kea Agent

一个最小化的 TypeScript 命令行编程代理。它通过统一的异步 LLM Client 调用 Anthropic、OpenAI 或 Gemini，并允许模型在当前工作目录中执行 shell 命令。

当前版本专注于核心 Agent loop；TUI 尚未加入。

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

程序启动后，在 `s01 >>` 提示符后输入任务并回车。模型产生的工具调用会以黄色 `$` 前缀显示。Bash 命令以及写入、编辑文件会在执行前请求确认，直接回车默认拒绝。输入 `q`、`exit` 或直接按空回车退出。

请只在可信目录中运行本程序，并检查模型生成的命令。BashTool 具有最小危险片段拦截，但它不是完整沙箱，也不能替代系统权限隔离。

在 Windows 上，BashTool 优先使用 Git Bash；未安装时使用 `bash.exe`（例如 WSL）。因此模型生成的命令统一采用 Bash 语法，例如 Windows 目录在 WSL 中写为 `/mnt/d/project`，不要使用 `cd D:\\project`。

## 工具系统

工具通过 `ToolRegistry` 显式注册。每个工具继承泛型 `Tool<TParameters>`，使用 TypeBox 明确定义参数 schema，并实现异步 `execute()`。Registry 负责：

- 导出 OpenAI function-tool schema；
- 严格校验参数，不做类型转换或默认值注入；
- 处理工具 timeout 和错误结果；
- 按模型返回顺序逐个执行同一轮工具调用。

第一版不并行执行工具，也没有全局 Registry、装饰器注册或反射式 schema 生成。
默认工具集合由 tools 模块中的 `createToolRegistry()` 创建，注册 `BashTool` 以及读、写、编辑文件和 glob 查找工具。

## Hooks 与权限

Hooks 是独立于 Agent loop 的切面扩展点。`HookRegistry` 管理显式注册的 hook；当前只定义实际使用的 `pre_tool_use`，并在工具参数验证通过后、工具 timeout 启动前顺序触发。第一个返回 `block` 的 hook 会阻止执行，hook 异常也会安全地阻止工具。

默认 CLI 注册内置 `PermissionHook`：

- `read_file` 和 `glob` 直接放行；
- `write_file`、`edit_file` 和普通 Bash 命令请求用户确认；
- Bash 危险片段直接拒绝，不询问用户。

Permission 等待不计入工具 timeout。`BashTool` 在启动进程前仍会再次检查危险片段，作为最后一道防线。权限确认只是防误操作机制，不是完整沙箱。

## CLI 与核心边界

`main.ts` 只负责加载本地环境并组装 LLM client、hooks、tools、`AgentSession` 和 CLI。`AgentSession` 持有完整消息历史并运行 Agent turn；`cli.ts` 只处理 `readline`、ANSI 展示和权限确认。未来 TUI 可以消费相同的 `AgentEvent` 并提供自己的权限交互，而不改动 Agent loop。

## 统一 LLM Client

`createLLMClient()` 默认根据唯一存在的 API key 环境变量选择 provider，也支持显式传入 `provider`、`model`、`apiKey` 和 `baseUrl`。该工厂是异步函数，只加载被选中的 adapter。公共选项使用 camelCase：`maxTokens`、`timeout`、`temperature`、`topP` 和 `stop`；每次调用的选项覆盖 client 默认值。`timeout` 单位为秒。

```ts
import { createLLMClient } from "./src/index.js";

const client = await createLLMClient({ maxTokens: 4_096, timeout: 60 });
const messages = [{ role: "user" as const, content: "你好" }];

const response = await client.invoke(messages);
console.log(response.content);
console.log(response.toolCalls, response.usage, response.latencyMs);

for await (const event of client.stream(messages)) {
  if (event.type === "text_delta") process.stdout.write(event.text);
  else console.log(event.response.toolCalls);
}
```

工具调用使用 OpenAI function-tool schema 作为 Kea 的统一输入格式。OpenAI 直接使用该格式；Anthropic 和 Gemini 在各自 adapter 内转换。`invoke()` 和 `stream()` 都可接收 schema：

```ts
const tools = [
  {
    type: "function" as const,
    function: {
      name: "get_weather",
      description: "查询天气",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
    },
  },
];

const response = await client.invoke(messages, tools);
for (const call of response.toolCalls) {
  console.log(call.id, call.name, call.arguments);
}

for await (const event of client.stream(messages, tools)) {
  if (event.type === "text_delta") process.stdout.write(event.text);
  if (event.type === "response_done") console.log(event.response.toolCalls);
}
```

`invoke()` 返回完整 `LLMResponse`。`stream()` 返回 `AsyncIterable<LLMStreamEvent>`：文本到达时产生 `text_delta`，流完整结束时产生一次 `response_done`。Adapter 在内部拼接工具参数，只有 `response_done` 中才会出现完整 `ToolCall`。

Agent 层的 `runAgentTurn()` 将 provider 事件转为 `text_delta`、`tool_start`、`tool_end` 和 `turn_end`。这些事件只用于展示进度；完整 assistant/tool message 才会写入会话历史。工具调用会在 `response_done` 后按顺序执行。

当前基础版本保留 provider 和工具 timeout，但不暴露调用方取消信号。需要 Ctrl+C 传播、进程树终止等取消语义时再单独设计。

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
