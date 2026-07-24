# Kea Agent 架构

**更新:** 2026-07-24

## 两层类型模型

### llm-client — 传输层

定义 LLM 协议格式。纯数据 — 无行为、无执行、无 hook。

```
Tool               { name, description, parameters: TObject }
ToolCall           { type:"toolCall", id, name, arguments }
Message            UserMessage | AssistantMessage | ToolResultMessage
UserMessage        { role:"user", content: string }
AssistantMessage   { role:"assistant", content: ContentBlock[], model, stopReason, usage?, errorMessage?, latencyMs }
ToolResultMessage  { role:"tool", toolCallId, name, content, isError? }

Context            { systemPrompt?, messages: Message[], tools?: Tool[] }
LLMClient          { stream(ctx, options?): AsyncIterable<AssistantMessageEvent> }
```

`LLM` 前缀的类型（`LLMClient`、`LLMOptions`、`LLMConfig`）是传输层内部细节。
其余都是全局数据类型 — 任何包都可以从 llm-client 直接导入 `Message`、`ToolCall`、`AssistantMessage`。

适配器在 `llm-client/adapters/` 中。它们把统一的 `AssistantMessageEvent` 流翻译成各 provider 的原生协议。
`createLLMClient()` 从环境变量自动检测 provider。

### agent — 行为层

在 llm-client 类型之上添加执行逻辑。不重定义、不重导出 llm-client 类型。

```
AgentTool<T>  extends Tool     抽象类 — 加了 validate() + execute()
ToolResult                     { content: string, isError: boolean }
AgentEvent                     11 种可辨识联合事件（流式 + 生命周期）
AgentState                     { messages, systemPrompt, isRunning, errorMessage? }

Agent                          有状态包装器 — 持有 history，委托给 runAgentLoop
runAgentLoop()                 纯异步生成器 — LLM 流 + 工具循环
ToolRegistry                   存储 AgentTool，校验参数，运行 hook 管道

Hook<T>                        通用生命周期 hook 接口
HookRegistry                   注册 hook，按事件类型链式调用（首个非 void 返回值停止）
HookEventUnion                 5 种事件：user_prompt_submit, pre_tool_use, post_tool_use, pre_turn, stop
HookResult                     { block?, reason?, messages?, context?, forceContinue? }
```

**命名规则：** `Agent` 前缀 = 有行为。无前缀 = 纯数据 / 传输格式。
`AgentTool extends Tool` — 前者执行，后者只是 LLM 看到的 schema。

Kea 没有 `AgentMessage` 和 `AgentContext`。Pi 有它们是因为 Pi 在 session 历史中存储了非 LLM 消息
（Bash 执行记录、UI 通知等），发给 LLM 前需要过滤掉。Kea 只存 llm-client 的 `Message` 类型 — 不需要转换层。

### harness — 应用层

连接 agent 和外部世界。内置工具（bash、files、glob）、内置 hook（permission、log、summary）、session 持久化。

```
AgentHarness      包装 Agent + SessionStore — prompt() → 持久化
SessionRepo       管理每个 project 的 JSONL session 文件
SessionStore      { load(): Message[], append(msg): void }
```

Harness 从 llm-client 导入 `Message`、`Tool`、`ToolCall`（全局数据）。
从 agent 导入 `AgentTool`、`Hook`、`HookRegistry`（行为类型）。
绝不导入传输层类型（`LLMClient`、`Context`、`AssistantMessageEvent`）。

## 数据流

一次用户对话：`CliFrontend → AgentHarness.prompt() → Agent.prompt() → runAgentLoop() → client.stream()`

对话期间，11 种 `AgentEvent` 通过异步生成器流回。CLI 在流式输出期间将 stdin 切换为 raw mode，
ESC 键通过 `agent.abort()` 取消当前 run，`AbortSignal` 经由 `LLMOptions.signal` 一路传到
provider HTTP 请求。

对话结束后，`AgentHarness` 将新消息追加到 `SessionStore`。

## Abort 信号路径

```
ESC → CliFrontend → harness.abort() → agent.abort()
  → abortController.abort()
  → signal 经由 runAgentLoop → client.stream({ signal })
  → 适配器 mergeSignals(timeout, signal) → HTTP 请求取消
  → signal.aborted 检查跳过剩余工具
  → yield agent_end → Agent.isRunning = false
```

## Session 持久化

扁平 JSONL 文件，存储在 `~/.kea/projects/<project-id>/sessions/` 下。
每行是一个 `Message`（llm-client 的可辨识联合类型）。
`SessionRepo` 管理目录；`SessionStore` 提供 `load()` 和 `append()`。

没有树结构、没有 `model_change` 条目、没有 `buildContext()`。
这些是 Pi 为树导航和多模型 session 设计的概念。Kea 需要时再加 — 当前扁平 JSONL 足够支持线性对话。

## 工具系统

两层，遵循 Pi 的模式：

`ToolDefinition<T>`（harness）— 业务逻辑。在 `harness/tools/types.ts` 中。
纯接口：`{ name, description, parameters, execute }`。绝不从 agent 导入。

`AgentTool<T>`（agent）— schema + 校验 + 执行契约。在 `agent/tools/types.ts` 中。
继承 llm-client 的 `Tool` 的抽象类。

`wrapToolDefinition(def)`（`harness/tools/adapter.ts`）桥接两层。
`createToolRegistry(cwd, hooks?)`（`harness/tools/factory.ts`）通过工厂数组注册所有内置工具。

## Hook 系统

通用生命周期基础设施在 `agent/hooks/`（类型 + 注册器）。
具体实现在 `harness/hooks/`（permission、log、summary、context-inject、todo-reminder）。

一次 prompt 触发五个事件：

1. `user_prompt_submit` — Agent.prompt() — 阻止或注入上下文
2. `pre_turn` — runAgentLoop() — LLM 流之前注入上下文
3. `pre_tool_use` — ToolRegistry.execute() — 权限门禁
4. `post_tool_use` — ToolRegistry.execute() — 副作用（日志）
5. `stop` — runAgentLoop() — 替换历史、强制继续

链式语义：hook 按注册顺序执行。首个非 undefined 返回值停止链条。
Hook 失败会被捕获并以 hook 名称重新抛出，每个生命周期调用方自行决定失败策略。

## 目录结构

```text
src/
├── main.ts                     组合根
├── index.ts                    公开导出
│
├── cli/
│   ├── frontend.ts             CliFrontend — readline I/O、ESC 检测、权限提示
│   └── render.ts               renderAgentEvent — 纯 ANSI 函数
│
├── harness/                    应用层
│   ├── agent-harness.ts        AgentHarness(sessionStore, agent) — 持久化包装
│   ├── types.ts                Project、SessionStore
│   ├── system-prompt.ts        formatSystemPrompt(template, vars)
│   ├── session/                JSONL 持久化
│   ├── hooks/                  内置 hook 实现
│   └── tools/                  内置工具实现 + 工厂
│
├── agent/                      内核层
│   ├── agent.ts                Agent 类
│   ├── agent-loop.ts           runAgentLoop() 纯函数
│   ├── types.ts                AgentEvent、AgentState
│   ├── hooks/                  通用 hook 系统（类型 + 注册器）
│   └── tools/                  通用工具系统（AgentTool、ToolResult、ToolRegistry）
│
├── llm-client/                 传输层
│   ├── types.ts                Message、Tool、ToolCall、LLMClient、Context 等
│   ├── factory.ts              createLLMClient() — provider 自动检测
│   └── adapters/               Anthropic、OpenAI、Gemini
│
└── utils/
    ├── timeout.ts              runWithTimeout()、mergeSignals()、timeoutMilliseconds()
    └── workspace.ts            safePath()
```
