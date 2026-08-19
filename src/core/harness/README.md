# Harness

`harness` 是通用 agent 的实现，把 `ai` 的 `ModelRuntime` 与 `events` 的共享通道组合成一次完整
运行。一个通用 agent 包含三大能力与一个组合根：

- **agent-loop**：`runAgentLoop()` 无状态执行一次多 Turn Agent Run；
- **tools**：`AgentTool`/`AgentToolRegistry` 提供工具定义、校验、执行与三阶段拦截；
- **session**：`Session`/`SessionRepository` 提供会话数据与持久化；
- **AgentHarness**：session-bound 的组合根，把三者在共享 `Events` 上绑成一份 Session 的运行器。

深入文档：通用 agent 的 loop/tool/事件契约见 [docs/agent.md](./docs/agent.md)；
session-bound 运行器见 [docs/harness.md](./docs/harness.md)；Session 模型与持久化见
[docs/session.md](./docs/session.md)。

## 最小用法

下面的 Session 只存在于内存中。调用方订阅 Harness 后，`prompt()` 启动一次完整的 Run：

```ts
import { createModelRuntime } from "../ai/index.js";
import { Events } from "../events/index.js";
import { AgentHarness, AgentToolRegistry, Session } from "./index.js";

const runtime = createModelRuntime({
  providers: [
    { name: "openai", protocol: "openai", apiKey: "sk-...", baseUrl: "https://api.openai.com/v1" },
  ],
});
const session = Session.inMemory({ cwd: process.cwd() });
const harness = new AgentHarness({
  session,
  runtime,
  modelConfig: { provider: "openai", model: "gpt-5" },
  toolRegistry: new AgentToolRegistry(),
  systemPrompt: "You are a helpful assistant.",
  events: new Events(),
});

const unsubscribe = harness.subscribe((event) => {
  if (event.type === "text-delta") process.stdout.write(event.text);
});

await harness.prompt("Explain what a session is.");
unsubscribe();
```

`subscribe(listener)` 把 Harness 收到的 `HarnessEvent` 按 `sessionId` 过滤后转交给 listener，
返回的取消函数幂等。调用方不需要直接接触共享 `Events` 实例。

## 包边界与公开导出

Harness 组合下层能力：`ai` 提供 `ModelRuntime` 与 `ModelConfig`；Harness 把
`runtime.stream` 适配成 `StreamFn`，并实现 `runAgentLoop()`、`AgentTool`/`AgentToolRegistry`、
Session 与 `AgentHarness`；`events` 提供共享 dispatcher。具体 coding Tool 和项目级组装属于
Harness 上层（`coding-agent`）。

以下清单与 `src/core/harness/index.ts` 一致。

### 值

- `runAgentLoop`：无状态多 Turn Agent Run 驱动；
- `AgentHarness`：运行绑定的 Session；
- `Session`：保存和重建一份会话；
- `SessionRepository`：在一个存储目录中创建、打开、列举、fork 和删除 Session；
- `SessionError`：带有 `SessionErrorCode` 的会话错误；
- `AgentTool`、`AgentToolRegistry`：工具定义、校验与执行。

### 类型

- Agent：`AgentContext`、`AgentLoopConfig`、`AgentMessage`、`AgentRunIdentity`、`StreamFn`、
  `HarnessConfig`、`HarnessRunEnd`、`HarnessEvent`；
- Tool：`AgentToolCall`、`AgentToolResult`、`ToolExecutionContext`、`ToolCallEvent`、
  `ToolResultEvent`、`PreToolDecision`；
- Session：`SessionMetadata`、`SessionNode`、`SessionErrorCode`。
