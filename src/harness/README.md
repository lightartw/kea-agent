# harness

应用编排层。连接 agent 内核、ai 传输层和 CLI 展示层。

管理 session 持久化、模型切换、system prompt 构建、工具注册和 hook 管线。

## AgentHarness

### `AgentHarness` — [agent-harness.ts](agent-harness.ts)

单次 session 生命周期的编排器。持有 Agent、Session、工具和 hook 的引用。

```ts
import { AgentHarness } from "./harness/agent-harness.js";

harness.messages     // readonly Message[]
harness.isRunning    // boolean
harness.model        // ModelConfig

harness.prompt("hi")           // AsyncIterable<AgentEvent>
harness.abort()                // 取消当前 run
harness.switchModel(config)    // 切换模型，持久化到 session
harness.registerTool(tool)     // 动态注册工具
harness.registerHook(hook)     // 动态注册 hook
harness.getHook("permission")  // 按名查找 hook
```

`prompt()` 在每次调用前从 session 同步 model，调用后将新消息批量写入 session。

### `createHarness` — [agent-harness.ts](agent-harness.ts)

工厂函数。内部创建 hook 管线、工具集和 session，组装完整的 AgentHarness。

```ts
import { createHarness } from "./harness/agent-harness.js";

const harness = await createHarness({
  project: { workDir, storageDir },
  streamFn: createStreamFn(),
});
// model 从 env 自动检测，systemPrompt 使用内置 CODING_SYSTEM_PROMPT
```

`CreateHarnessConfig`：

```ts
interface CreateHarnessConfig {
  project: { workDir: string; storageDir: string };
  streamFn: StreamFn;
  model?: ModelConfig;                          // 可选，默认 detectModel()
  systemPrompt?: string | SystemPromptBuilder;  // 可选，默认 CODING_SYSTEM_PROMPT
  cwd?: string;                                 // 可选，默认 process.cwd()
}
```

## Session

### `Session` — [session/session.ts](session/session.ts)

追加式对话树，JSONL 文件后端。三种工厂方法明确区分持久化模式：

```ts
import { Session } from "./harness/session/session.js";

// 持久化——文件在 <storageDir>/sessions/<timestamp>_<uuid>.jsonl
const session = await Session.create(storageDir);

// 打开已有会话
const session = await Session.open(storageDir, sessionId);

// 纯内存——不落盘，用于测试
const session = Session.inMemory();
```

读写：

```ts
session.id               // string
session.appendMessage(msg)         // Promise<void>，自动落盘
session.appendModelChange(p, m)    // Promise<void>
session.buildContext()             // → { messages: Message[], model: ModelConfig | null }
session.messages()                 // → Message[]
```

**延迟落盘**：`create()` 模式下，在第一条 assistant 消息到达前不会创建文件——只有用户消息的会话（被放弃的 prompt）不产生空文件。第一条 assistant 消息到达时，一次性刷入之前 buffer 的所有 entry，之后逐条追加。`inMemory()` 模式无此行为。

**树形结构**：每个 entry 有 `id` + `parentId`。`leafId` 跟踪当前叶子，追加时以 leafId 为 parent。`buildContext()` 从 leaf 向 root 遍历，收集 message 并找最近的 model_change。

## System Prompt

### `SystemPromptBuilder` — [system-prompt.ts](system-prompt.ts)

```ts
type SystemPromptBuilder = (ctx: SystemPromptContext) => string;

interface SystemPromptContext {
  model: ModelConfig;
  tools: readonly AgentTool[];
  cwd: string;
  date: Date;
  extraContext?: string;
}
```

### `formatSystemPrompt` — [system-prompt.ts](system-prompt.ts)

模板替换。支持 `{{cwd}}` 和 `{{date}}`。

```ts
import { formatSystemPrompt } from "./harness/system-prompt.js";
formatSystemPrompt("Working in {{cwd}}", { cwd: "/home/user" });
```

### `defaultSystemPrompt` — [system-prompt.ts](system-prompt.ts)

把模板字符串包装成 `SystemPromptBuilder`。

### `CODING_SYSTEM_PROMPT` — [system-prompt.ts](system-prompt.ts)

内置的默认 coding 系统提示词。`createHarness` 在未指定 `systemPrompt` 时使用。

## Tools

### 内置工具 — [tools/](tools/)

6 个工具，全部直接 extend `AgentTool`：

- `BashTool(cwd, ops?)` — 执行 shell 命令
- `ReadFileTool(workspace)` — 读取文件
- `WriteFileTool(workspace)` — 写入文件
- `EditFileTool(workspace)` — 精确文本替换
- `GlobTool(workspace)` — 通配符查找文件
- `TodoWriteTool()` — 管理任务列表

自定义工具：extend `AgentTool`，实现 `execute(args, signal)`，注册到 `ToolRegistry`。

### `createToolRegistry` — [tools/factory.ts](tools/factory.ts)

```ts
import { createToolRegistry } from "./harness/tools/factory.js";

const registry = createToolRegistry(cwd);  // ToolRegistry
```

### `BashOperations` — [tools/bash.ts](tools/bash.ts)

Shell 执行的可替换后端。默认 `LocalBashOperations`（本地子进程）。

```ts
interface BashOperations {
  exec(command: string, cwd: string, signal: AbortSignal): Promise<string>;
}
```

## Hooks

### `createHookRegistry` — [hooks/factory.ts](hooks/factory.ts)

```ts
import { createHookRegistry } from "./harness/hooks/factory.js";

const registry = createHookRegistry(cwd, extraHooks?);  // HookRegistry
```

8 个内置 hook：

- `ContextInjectHook` — `user_prompt_submit`，打印工作目录
- `PermissionHook` — `pre_tool_use`，阻止危险命令（`rm -rf /` 等）
- `LogHook` — `user_prompt_submit`，记录请求日志
- `LargeOutputHook` — `post_tool_use`，截断过长输出
- `SummaryHook` — `stop`，token 预算告警
- `TodoResetHook` — `user_prompt_submit`，重置 todo 提醒计数
- `TodoCalledHook` — `pre_tool_use`，检测 todo_write 调用
- `TodoRemindHook` — `pre_turn`，未使用 todo 时提醒

## 用法

最小 harness（使用所有默认值）：

```ts
import { createHarness } from "./harness/agent-harness.js";
import { createStreamFn } from "./ai/factory.js";

const harness = await createHarness({
  project: { workDir: process.cwd(), storageDir: "~/.kea/projects/my-project" },
  streamFn: createStreamFn(),
});

for await (const event of harness.prompt("Hello")) {
  // render events
}
```

自定义 system prompt：

```ts
const harness = await createHarness({
  project,
  streamFn: createStreamFn(),
  systemPrompt: "You are a helpful assistant. CWD: {{cwd}}",
});
```

## 依赖

从 agent 导入：`Agent`、`AgentTool`、`ToolRegistry`、`HookRegistry`、`Hook`

从 ai 导入：`StreamFn`、`ModelConfig`、`Message`
