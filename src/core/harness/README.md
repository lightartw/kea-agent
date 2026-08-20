# Harness

`harness` 是通用 agent 的实现，把 `ai` 的 `ModelRuntime` 组合成一次完整运行。一个通用 agent
包含三大能力与一个组合根：

- **agent-loop**：`runAgentLoop()` 无状态执行一次多 Turn Agent Run；
- **tools**：`AgentTool`/`AgentToolRegistry` 提供工具定义、校验与执行；权限通过 `beforeTool`
  控制钩子完成；
- **session**：`Session`/`SessionRepository` 提供会话数据与持久化；
- **AgentHarness**：session-bound 的组合根，把三者绑成一份 Session 的运行器，并自持一个
  观察事件总线 `HarnessEventBus` 和一组固定控制钩子 `HarnessHooks`。

观察（事件）与控制（钩子）分离：事件总线只负责发布已发生的事实（listener 返回 `void`）；
控制钩子是一组固定命名的点（`beforePrompt` / `transformContext` / `beforeTool`），handler
通过返回值影响流程。

深入文档：通用 agent 的 loop/tool/事件与钩子契约见 [docs/agent.md](./docs/agent.md)；
session-bound 运行器见 [docs/harness.md](./docs/harness.md)；Session 模型与持久化见
[docs/session.md](./docs/session.md)。

## 最小用法

下面的 Session 只存在于内存中。调用方创建 `HarnessEventBus` 与 `HarnessHooks`，连同其他
依赖一起注入 `AgentHarness`，然后 `prompt()` 启动一次完整的 Run：

```ts
import { createModelRuntime } from "../ai/index.js";
import {
  AgentHarness,
  AgentToolRegistry,
  HarnessEventBus,
  HarnessHooks,
  Session,
} from "./index.js";

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
  events: new HarnessEventBus(),
  hooks: new HarnessHooks(),
});

const unsubscribe = harness.subscribe((event) => {
  if (event.type === "text-delta") process.stdout.write(event.text);
});

await harness.prompt("Explain what a session is.");
unsubscribe();
```

`subscribe(listener)` 把 Harness 发布到自持总线上的 `HarnessEvent` 直接转交给 listener，
返回的取消函数幂等。每个 Harness 绑定一份 Session，因此无需按 `sessionId` 过滤。控制钩子
（如 `beforeTool` 的权限决策）由调用方在创建 `HarnessHooks` 时注册。

## 包边界与公开导出

Harness 组合下层能力：`ai` 提供 `ModelRuntime` 与 `ModelConfig`；Harness 把
`runtime.stream` 适配成 `StreamFn`，并实现 `runAgentLoop()`、`AgentTool`/`AgentToolRegistry`、
Session、`AgentHarness`、`HarnessEventBus` 与 `HarnessHooks`。具体 coding Tool 和项目级组装
属于 Harness 上层（`coding-agent`）。

以下清单与 `src/core/harness/index.ts` 一致。

### 值

- `runAgentLoop`：无状态多 Turn Agent Run 驱动；
- `AgentHarness`：运行绑定的 Session；
- `HarnessEventBus`：观察事件总线（`on`/`emit`）；
- `HarnessHooks`：固定控制钩子注册表（`on`）；
- `Session`：保存和重建一份会话；
- `SessionRepository`：在一个存储目录中创建、打开、列举、fork 和删除 Session；
- `SessionError`：带有 `SessionErrorCode` 的会话错误；
- `AgentTool`、`AgentToolRegistry`：工具定义、校验与执行。

### 类型

- Agent：`AgentContext`、`AgentLoopConfig`、`AgentMessage`、`AgentRunIdentity`、`StreamFn`、
  `HarnessConfig`、`HarnessRunEnd`、`HarnessEvent`、`HarnessEventType`；
- Hook：`HookName`、`HookContext`、`PreToolDecision`；
- Tool：`AgentToolCall`、`AgentToolResult`、`ToolExecutionContext`；
- Session：`SessionMetadata`、`SessionNode`、`SessionErrorCode`。
