# Readline UI、主应用与配置设计

## 目标与阅读前提

本文完成 Kea 第一版可交互应用的外层设计。它在已经验证的 `core` 与 `coding-agent` 之上定义：

- readline CLI 的线性输入循环和展示边界；
- UI 如何观察一份 Session 对应的 `AgentHarness`；
- Permission Interaction 如何在一次运行中临时接管输入；
- `main.ts` 如何发现 Project、加载配置、创建 Runtime、选择 Session 并启动 UI；
- 用户配置、Project 配置、凭据文件、显式配置文件和 CLI 参数的优先级；
- `kea init`、错误处理、凭据脱敏和资源清理行为。

本文以当前 `src/core` 和 `src/coding-agent` 的实现为基础。Core 的 Agent Loop、Events、Session、
Harness 和 ModelRuntime 仍是可信的通用机制；Coding Agent 的 Project、内建 Tool、Permission 和
Interactions 仍是可信的领域组合。本文只调整这些模块为了真实应用入口必须暴露或接收的少量接口。

现有 `src/ui` 与 `src/main.ts` 不作为设计依据。实现应根据本文重新建立应用外层，不能为了兼容旧的
临时代码破坏本文边界。

## 1. 总体结构

应用保持四层依赖：

```text
main / application helpers
        |
        v
readline UI <-> coding-agent Project / Interactions
                         |
                         v
                  core AgentHarness
                         |
                         v
                  core Agent / AI
```

各层职责如下：

| 模块 | 职责 |
| --- | --- |
| `main.ts` | 解析启动参数，编排启动顺序，处理顶层错误和退出码 |
| application helpers | Project 目录发现、配置加载、`kea init` 等无长期运行状态的启动能力 |
| readline UI | 当前 Harness、输入/命令循环、历史和事实事件展示、Permission 回答 |
| Coding Agent Project | Project 记录、Session 集合、Harness 组装、内建 Tool 和 Permission |
| AgentHarness | 一份 Session 的运行、模型状态、取消和 Session 级事实订阅 |
| Core Events | Core 与 Coding Agent 内部的控制和事实分发机制 |

第一版不增加 `Application`、`AppController` 或 `SessionManager` 运行对象。readline UI 的循环直接持有
`Project` 和当前 `AgentHarness`；`main.ts` 只进行一次性组装。配置、Project 发现和初始化逻辑可以
拆成小模块，但这些模块是纯启动能力，不形成第二套应用状态机。

## 2. CLI 入口

第一版支持以下启动形式：

```text
kea [--config <path>] [--verbose] [<directory>]
kea -c [--config <path>] [--verbose] [<directory>]
kea init
```

`directory` 省略时使用 `process.cwd()`。参数解析必须在读取配置、发现 Project 或创建 Runtime 之前
完成。未知选项、重复的单值选项、缺失的 `--config` 参数和多个位置参数都属于参数错误。

`kea` 与 `kea -c` 的区别只发生在初始 Session 选择：

- `kea`：为解析出的 Project 创建一份新 Session；
- `kea -c`：打开该 Project 最近更新的 Session；没有历史时创建新 Session。

进入 UI 后，两种启动方式完全相同。`-c` 不是持续模式，也不影响之后的 `/new`、`/session` 或
`/model`。

`kea init` 是独立命令。第一版不为它接受 `--config`、`-c` 或位置目录；无意义组合直接报告参数
错误，不静默忽略。

## 3. Project 目录发现移到应用层

### 3.1 原因

Project 配置位于 `<project>/.kea/config.json`，因此配置加载前必须知道 Project directory。当前
`openOrCreateProject()` 在内部解析 cwd 和 Git 根，但调用它之前又必须创建由配置决定的
ModelRuntime 和默认模型，形成启动依赖环。

解决方式是把 Project directory 发现从 Coding Agent 工厂拆到应用层：

```ts
async function resolveProjectDirectory(
  startupDirectory: string,
): Promise<string>;
```

它沿用当前已经验证的发现规则：

1. 把启动目录解析为绝对路径；
2. 通过 `realpath` 取得规范路径并确认它是目录；
3. 在该目录执行等价于 `git rev-parse --show-toplevel` 的 Git work-tree 根发现；
4. 位于 Git work-tree 时返回规范化后的根目录；
5. 明确不是 Git repository 时返回规范化后的启动目录；
6. Git 无法启动、返回空根或目录访问失败时明确报错。

不能通过查找 `.git` 目录替代 Git 命令，因为 worktree 的 `.git` 可以是文件。

### 3.2 调整后的 Project 工厂

`openOrCreateProject()` 不再接收 `cwd`，改为接收应用已经解析出的 Project directory：

```ts
function openOrCreateProject(options: {
  readonly keaHome: string;
  readonly projectDirectory: string;
  readonly runtime: ModelRuntime;
  readonly modelConfig: ModelConfig;
  readonly interactions: Interactions;
  readonly maxTurns: number;
  readonly toolTimeoutSeconds: number;
  readonly onListenerError?: (
    error: unknown,
    name: string,
    input: unknown,
  ) => void;
}): Promise<Project>;
```

Coding Agent 仍在边界处验证 `projectDirectory` 是现存、规范化的绝对目录，不能盲目信任调用方。
验证完成后，它只负责：查找或创建 Project 记录、创建 SessionRepository、创建 Project 级
Permission/Events 状态，并返回 Project。

Project discovery 的所有权改变，但 Project identity、ProjectStorage 和 Session 路径格式不变。

## 4. Harness 的 Session 级订阅

### 4.1 订阅属于 Harness

UI 展示围绕当前 Session 展开，因此观察入口属于绑定该 Session 的 `AgentHarness`，不属于 Project。
Project 的共享 `Events` 是 Core 和 Coding Agent 的内部组合机制，不直接暴露给 UI。

`Project.events` 改为私有。`AgentHarness` 增加：

```ts
type HarnessListener = (event: HarnessEvent) => void;

class AgentHarness {
  subscribe(listener: HarnessListener): () => void;
}
```

返回的 unsubscribe 函数必须幂等。订阅不重放历史，只观察注册之后发生的事实。恢复 Session 的历史
通过 `harness.messages` 单独读取和渲染。

Harness 内部仍使用 Project 共享的 Events。`subscribe()` 为所有 UI 需要的 emit 事实注册内部
listener，并用本 Harness 的 `sessionId` 过滤。切换 Session 时 UI 取消旧订阅并订阅新 Harness；
Project 级 Permission listener 和 Events 实例继续存活，不随 UI 订阅关闭。

### 4.2 HarnessEvent

`HarnessEvent` 是 UI-facing 的封闭判别联合，不导出 Core `EventMap`、`Events` 或原始事件名称泛型：

```ts
type HarnessEvent =
  | {
      readonly type: "run-start";
      readonly runId: string;
    }
  | ({
      readonly type: "run-end";
      readonly runId: string;
    } & (
      | { readonly reason: "completed" | "aborted" }
      | { readonly reason: "error"; readonly errorMessage: string }
    ))
  | {
      readonly type: "turn-start";
      readonly runId: string;
    }
  | {
      readonly type: "turn-end";
      readonly runId: string;
      readonly message: AgentMessage;
      readonly toolResults: readonly AgentMessage[];
    }
  | {
      readonly type: "text-delta";
      readonly runId: string;
      readonly text: string;
    }
  | {
      readonly type: "thinking-delta";
      readonly runId: string;
      readonly thinking: string;
    }
  | {
      readonly type: "tool-call-start";
      readonly runId: string;
      readonly id: string;
      readonly name: string;
    }
  | {
      readonly type: "tool-call-delta";
      readonly runId: string;
      readonly id: string;
      readonly argumentsDelta: string;
    }
  | {
      readonly type: "tool-call";
      readonly runId: string;
      readonly cwd: string;
      readonly call: AgentToolCall;
    }
  | {
      readonly type: "tool-result";
      readonly runId: string;
      readonly cwd: string;
      readonly call: AgentToolCall;
      readonly result: AgentToolResult;
    };
```

`sessionId` 不进入公开事件，因为订阅本身已经绑定一份 Session；调用方可从
`harness.sessionId` 获得身份。`runId` 保留，用于关联一次 Run 内的 Turn、流片段和 Tool。

只投影 emit 事实。`agent/user-prompt`、`agent/context` 和三个 `tools/*` intercept 是内部控制点，
不能通过 `HarnessEvent` 暴露给 UI。

listener 是同步通知函数。展示异常通过内部 Events 的 listener error 路径报告，不能改变 Agent
运行结果。第一版不为 UI 建立异步消息队列、背压或 replay buffer；终端写入本身是轻量同步操作。

### 4.3 顺序

公开事件保持 Core 已有事实顺序。例如一次普通文本 Run 的关键顺序为：

```text
run-start
turn-start
text-delta ...
turn-end
run-end(completed)
```

有 Tool 时，`tool-call` 和 `tool-result` 按模型给出的源码顺序出现。UI 只展示事实，不通过订阅返回
控制结果。需要回答的问题使用 Interactions。

## 5. Readline UI

### 5.1 状态

readline UI 只保存运行所需的少量状态：

```ts
interface ReadlineUiState {
  readonly project: Project;
  current: AgentHarness;
  unsubscribe: () => void;
  readonly models: readonly ModelConfig[];
}
```

UI 不保存 Session 的第二份消息历史、模型状态或运行状态。历史来自 `harness.messages`，当前模型来自
`harness.model`，运行状态来自 `harness.isRunning`。

### 5.2 主循环

主逻辑是单一线性循环：

```ts
while (true) {
  const input = await readline.readPrompt();
  const action = parseInput(input);

  switch (action.kind) {
    case "prompt":
      renderUserPrompt(action.text);
      await current.prompt(action.text);
      break;
    case "new-session":
      await activate(await project.createHarness());
      break;
    case "switch-session":
      await chooseAndActivateSession();
      break;
    case "switch-model":
      await chooseAndSwitchModel();
      break;
    case "help":
      renderHelp();
      break;
    case "exit":
      return;
  }
}
```

`await current.prompt()` 期间外层循环暂停，不读取下一条普通 Prompt。第一版没有 steer、follow-up
队列或并发 Prompt。

普通 Prompt 在提交前先由 UI 原样展示，再调用 `current.prompt()`。之后的 assistant 文本、thinking、
Tool 和 Run 状态只根据 HarnessEvent 增量展示；UI 不等到 `prompt()` 返回后重新扫描消息并重复输出。
如果 Core 的 `agent/user-prompt` 控制点阻止或改写输入，Session 最终保存的内容仍以 Core 提交结果为
准，而终端保留用户实际输入的回显。

### 5.3 Slash 命令

第一版固定以下命令：

```text
/new
/session
/model
/help
/exit
```

解析规则：

- 只有输入第一个字符是 `/` 时才尝试解析命令；
- 第一项必须精确匹配已注册命令；
- 未知 `/name` 作为普通 Prompt 提交；
- 输入中间出现 `/` 没有特殊含义；
- 已识别命令收到不支持的参数时报告命令错误，不退化为 Prompt；
- 普通 Prompt 不调用 `trim()`，原始文本原样提交。

因此命令只占用输入开头的一小组已知名称，不会把包含文件路径、URL、正则或自然语言斜杠的普通
Prompt 误判成命令。

### 5.4 Session 激活

新建和恢复都先构造候选 Harness，成功后才替换当前 Harness：

```text
create/open candidate
→ 检查 candidate.model 是否仍在配置模型列表
→ 必要时请求用户重新选择模型
→ 取消旧 subscription
→ current = candidate
→ 展示 Session 标题、模型和历史
→ subscribe(candidate)
```

候选 Harness 创建、Session 读取或模型修复失败时，旧 Harness 和旧订阅保持不变。

`project.listSessions()` 已按 `updatedAt` 从新到旧返回 metadata。`/session` 展示该列表并打开用户
选择的 ID。用户取消选择时不改变状态。

恢复 Session 时，如果持久化的模型不在当前配置模型列表中，不能静默换成默认模型：

- 交互式切换时要求用户从当前配置列表重新选择；取消则保留旧 Session；
- 初始 `-c` 恢复时要求选择；取消则退出启动，而不是用未知模型继续运行。

### 5.5 模型切换

`/model` 只展示 `Config.models`。选择当前模型是 no-op；选择其他模型时调用：

```ts
await current.switchModel(selected);
```

Harness 只有在 Session 成功写入 `model_selection` 后才更新内存模型。持久化失败时 UI 展示错误，
当前模型不变。

### 5.6 展示配置

`ui.thinking` 只控制 `thinking-delta` 的终端展示：`hidden` 忽略增量，`visible` 按收到顺序输出。
它不改变模型请求、Session 消息或 HarnessEvent。

`ui.toolDetails` 控制 Tool 展示密度：

- `compact`：展示 Tool 名、关键目标和成功/失败摘要；
- `full`：额外展示完整结构化参数和 Tool Result 内容。

两种模式消费同一个 `tool-call` / `tool-result` 事实，不修改 Tool 执行。无法识别的 Tool 使用通用
JSON-safe fallback；展示失败报告为 listener error，不能改变 Tool Result。

## 6. Interactions 与输入接管

UI 实现 Coding Agent 已有的最小端口：

```ts
interface Interactions {
  permission(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<PermissionReply>;
}
```

一次需要授权的真实控制流为：

```text
readPrompt()
→ await harness.prompt(prompt)
   → Permission listener
      → await interactions.permission(request)
         → readline 临时询问 once / always / deny
         ← PermissionReply
      ← Permission decision
   → Agent 继续执行
← harness.prompt() 完成
→ 外层循环读取下一条普通 Prompt
```

这不是另一个 Permission Event，也不需要 UI intercept。Interaction 是内部主动请求并等待回答；
Harness 事实订阅仍是被动展示。

Agent Loop 当前按顺序执行 Tool Call，因此一份 Harness 在同一时刻最多存在一个 Permission 输入。
`AgentHarness.assertIdle()` 又禁止同一 Harness 并发运行。第一版无需 Permission 请求队列。

Interaction 使用传入的 Run signal。Run 取消时，正在等待的 Permission 输入必须停止并传播取消，
不能转换成普通用户 deny。用户主动取消 Permission 选择则返回 `deny`，不结束应用。

## 7. Ctrl+C、EOF 与资源清理

UI 根据当前阶段处理终端控制：

- Agent Run 中按 Ctrl+C：调用 `current.abort()`；等待 `run-end(aborted)` 后回到普通输入；
- Permission 输入中取消整个 Run：同一个 abort signal 结束 Interaction 和 Agent Run；
- 普通输入收到 EOF：等价于 `/exit`；
- 普通输入中的局部清行行为可以由 readline adapter 实现，不进入领域接口。

UI 的最外层始终使用 `try/finally`：

```ts
try {
  await ui.run(project, initialHarness);
} finally {
  unsubscribe();
  readline.close();
}
```

`close()` 必须幂等。退出不关闭 Project 的持久化对象，因为当前 Project、SessionStorage 和 Events
没有独立异步 close 协议。

## 8. 配置文件与优先级

### 8.1 文件位置

普通配置按以下优先级解析，顶部最高：

```text
显式 CLI 字段覆盖（例如 --verbose）
--config <path> 指定的额外配置文件
<project>/.kea/config.json
~/.kea/config.json
内建默认值
```

`--config` 是一个额外的最高优先级文件层，不替代用户或 Project 配置。相对路径从启动进程 cwd
解析为绝对路径。

凭据只从以下文件读取：

```text
~/.kea/auth.json
```

Auth 不参与普通配置合并。Project 配置和 `--config` 文件不能携带 API Key；用户普通配置也不能，
因为所有凭据都必须集中在 auth 文件。

生产启动不调用 `dotenv`。`.env` 只作为开发和测试便利，由开发脚本或 Node 的开发期
`--env-file` 支持加载；生产 application path 不从环境变量读取凭据。

### 8.2 唯一的 Config 实体

配置在应用中只有一个实体。文件内容、合并中的中间值和最终验证只是 `Config.load()` 的内部阶段，
不形成额外的应用类型。

```ts
type ProviderId = "anthropic" | "openai" | "gemini";

class Config {
  readonly defaultProvider: ProviderId;
  readonly maxTurns: number;
  readonly toolTimeoutSeconds: number;
  readonly thinking: "hidden" | "visible";
  readonly toolDetails: "compact" | "full";
  readonly verbose: boolean;

  #providers: ReadonlyMap<
    ProviderId,
    {
      readonly model: string;
      readonly baseUrl?: string;
      readonly apiKey: string;
    }
  >;

  static load(options: {
    readonly keaHome: string;
    readonly projectDirectory: string;
    readonly configOverride?: string;
    readonly verbose: boolean;
  }): Promise<Config>;

  get models(): readonly ModelConfig[];
  get defaultModel(): ModelConfig;
  runtimeProviders(): readonly RuntimeProviderConfig[];
  redact(message: string): string;
}
```

`Config` 构造成功就表示所有来源已经读取、合并并验证，所有启用 Provider 也已经取得凭据。Provider
明细保持私有，避免普通日志或对象检查直接输出 API Key。Runtime 通过 `runtimeProviders()` 取得创建
adapter 所需的短生命周期数组；其他调用方只读取模型和非秘密 setting。`redact()` 用已经加载的 Key
清理下游错误文本，不引入单独的 redactor 对象。

磁盘文件仍保持不同的安全 schema，但这些 schema 是 `Config.load()` 的内部校验规则，不是应用
实体：

- 普通 `config.json` 允许 `defaultProvider`、`providers.*.model`、`providers.*.baseUrl`、
  `agent.maxTurns`、`tools.timeoutSeconds`、`ui.thinking` 和 `ui.toolDetails`；
- `auth.json` 只允许 `providers.*.apiKey`；
- CLI 的 `--verbose` 最后覆盖 `Config.verbose`。

每个 Provider 第一版配置一个 UI 可选模型。一个 Provider 的 Runtime adapter 仍能按每次请求收到的
model 字符串工作；“每 Provider 一个模型”只是当前应用配置和选择列表的限制，不是 ModelRuntime
能力限制。

`verification`、`memory` 和 `agent.maxToolCalls` 当前没有消费者，因此不进入内部 schema。配置中
出现这些字段要作为未知字段报错，不能接受后忽略。

### 8.3 内建默认值

```json
{
  "agent": {
    "maxTurns": 20
  },
  "tools": {
    "timeoutSeconds": 120
  },
  "ui": {
    "thinking": "hidden",
    "toolDetails": "compact"
  }
}
```

内建默认值不虚构 Provider、模型或凭据。Provider 至少由一个配置文件明确给出。

### 8.4 合并语义

`Config.load()` 把每个 JSON 文件读取为 `unknown`，独立校验后再放入内部合并值。合并规则固定为：

- 普通对象递归合并；
- `providers` 按 Provider ID 递归合并；
- 标量由高优先级值替换；
- 缺失字段继承低优先级结果；
- `null` 不是删除标记，属于类型错误；
- 未知字段始终报错；
- 第一版没有数组字段，也不定义数组拼接语义。

配置源只有在自身合法后才参加合并，避免高优先级值掩盖低优先级文件中的拼写错误。

### 8.5 验证与解析

完成合并并读入 auth 后执行跨字段验证：

- 至少配置一个已知 Provider；
- Provider 的 `model` 必须是非空字符串；
- `defaultProvider` 必须引用已配置 Provider；
- 未指定 `defaultProvider` 时，一个 Provider 自动成为默认值，多个 Provider 明确报错；
- 每个已配置 Provider 必须在 auth 文件中具有非空 API Key；
- `baseUrl` 必须是绝对 HTTP 或 HTTPS URL；
- `agent.maxTurns` 必须是 `1..1000` 的整数；
- `tools.timeoutSeconds` 必须是大于 `0` 且不超过 `3600` 的有限数；
- UI 枚举值必须精确匹配 schema。

Auth 可以保存当前普通配置未启用的已知 Provider 凭据，加载器忽略这些额外凭据；未知 Provider ID
仍然报错。这样用户可以提前保存凭据，而 Project 配置决定本次运行实际启用哪些 Provider。

`Config.models` 按内建 Provider 注册顺序稳定生成；默认模型在 UI 中标记，但不通过改变列表顺序表达
语义。加载中任何一步失败都不产生半初始化 Config。

## 9. ModelRuntime 组装

### 9.1 Provider 与 ModelConfig

`providers` 表示本次运行已配置、已认证的全部 Provider 连接。每个连接包含 Provider ID、API Key 和
可选 base URL。它不保存“当前模型”。

`ModelConfig` 表示一次请求选择哪个 Provider，以及该 Provider 下使用哪个模型：

```ts
interface ModelConfig {
  readonly provider: string;
  readonly model: string;
}
```

请求路径为：

```text
ModelConfig.provider
→ Runtime 查找 Provider adapter
→ 把 ModelConfig.model 传给 adapter
→ 发起请求
```

默认模型是应用和新 Session 的选择，不是 Runtime 状态。恢复 Session 时 Harness 优先使用 Session
最后持久化的模型选择。

### 9.2 显式 Runtime 工厂

生产应用不能把已经解析的文件配置重新编码成伪环境变量。Core 工厂改为接收显式 Provider：

```ts
interface RuntimeProviderConfig {
  readonly id: ProviderId;
  readonly apiKey: string;
  readonly baseUrl?: string;
}

function createModelRuntime(options: {
  readonly providers: readonly RuntimeProviderConfig[];
}): ModelRuntime;
```

工厂为每个 Provider 创建 lazy adapter，拒绝重复或未知 Provider，并在请求时按
`ModelConfig.provider` 查找 adapter。它不读取 `process.env`，不选择默认 Provider，不要求
`MODEL_ID`，也不返回 `modelConfig`。

如果 Core 的开发和单元测试仍需要环境变量便利，可以提供明确命名的开发辅助入口：

```ts
function createModelRuntimeFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): ModelRuntime;
```

该辅助函数不被生产 `main.ts` 调用。应用不导入或调用 `dotenv`；Node 原生 `--env-file` 足够支持
需要环境变量的开发脚本。

## 10. 运行策略进入 Harness

配置中的 `maxTurns` 和 Tool timeout 都是本次应用运行策略，不写入 Session：

```text
config.maxTurns
→ Project
→ HarnessConfig
→ AgentHarness.createLoopConfig()
→ AgentLoopConfig.maxTurns

config.toolTimeoutSeconds
→ Project
→ createBuiltinToolRegistry(cwd, timeoutSeconds)
→ AgentToolRegistry(timeoutSeconds)
```

`HarnessConfig` 增加 `maxTurns`。Project 保存这两个只读策略，为新建或恢复的每个 Harness 使用同一
值。重新启动应用时，所有 Session 使用最新解析配置；Session 文件不复制应用策略。

## 11. `kea init`

`kea init` 在 Project discovery 和配置加载之前执行：

```text
parse argv
→ command == init
→ create ~/.kea when missing
→ create missing templates
→ exit
```

第一版只创建用户级文件：

```text
~/.kea/config.json
~/.kea/auth.json
```

它不自动修改当前 repository，也不创建 `<project>/.kea/config.json`。Project 配置由用户按需显式
创建；未来若需要 `kea init --project`，应单独设计其写入范围和模板。

用户配置模板为：

```json
{
  "defaultProvider": "openai",
  "providers": {
    "openai": {
      "model": "gpt-5",
      "baseUrl": "https://api.openai.com/v1"
    }
  },
  "agent": {
    "maxTurns": 20
  },
  "tools": {
    "timeoutSeconds": 120
  },
  "ui": {
    "thinking": "hidden",
    "toolDetails": "compact"
  }
}
```

凭据模板使用空字符串，确保用户填写前配置验证失败，而不是把占位文本发送给 Provider：

```json
{
  "providers": {
    "openai": {
      "apiKey": ""
    }
  }
}
```

文件创建规则：

- 递归创建 `~/.kea`；
- 每个目标独立使用 exclusive create，存在时报告 skipped；
- 一个文件存在不影响创建另一个文件；
- 并发 `kea init` 也不能覆盖已创建目标；
- auth 文件在支持 POSIX mode 的平台按 `0600` 创建；
- 一个文件创建成功、另一个失败时不回滚；再次运行只补缺失文件；
- 两个文件都已存在时退出码仍为 `0`；
- 模板使用 UTF-8、两空格缩进并以换行结束。

## 12. 错误与凭据脱敏

### 12.1 配置错误

```ts
class ConfigurationError extends Error {
  readonly sourcePath: string;
  readonly fieldPath?: string;
}
```

错误必须包含来源文件和具体字段，例如：

```text
C:\Users\alice\.kea\config.json: agent.maxTurns: expected an integer from 1 to 1000
D:\work\repo\.kea\config.json: providers.openai.apiKey: credentials are only allowed in ~/.kea/auth.json
C:\Users\alice\.kea\auth.json: providers.openai.apiKey: must be non-empty
```

规则如下：

- 用户配置、Project 配置不存在时视为没有该层；
- `--config` 显式文件不存在时失败；
- auth 文件不存在或缺少本次启用 Provider 的凭据时失败；
- JSON 语法错误报告来源路径和解析位置，不附带完整原文；
- 普通配置中的 `apiKey`、`token`、`secret`、`password` 等凭据字段给出专门安全错误；
- Auth 错误只报告字段路径和要求，不包含原值。

### 12.2 全局脱敏

已加载凭据只保存在 `Config` 的私有 Provider map，并通过 `runtimeProviders()` 进入 Runtime 组装；
它们不进入 UI state 或普通日志。最终顶层错误、verbose 日志和 listener error 报告都经过
`Config.redact()`：任何与已加载非空 Key 完全相同的片段都替换为 `[REDACTED]`。

`--verbose` 可以展示：

- 实际读取的普通配置来源路径；
- Project directory 和 Project ID；
- 启用的 Provider ID 和模型 ID；
- 某 Provider 的凭据状态为 configured。

它不能展示 API Key、Key 长度、Key 前后缀、Auth 原始对象或包含秘密的异常 cause。

### 12.3 启动与运行错误

启动期错误包括参数、Project discovery、配置、Auth、Runtime 和初始 Session 错误。`main.ts` 输出
一次脱敏诊断并设置退出码 `1`，不进入 readline 循环。

运行期错误局部处理：

- `harness.prompt()` 失败：展示错误，保留当前 Session，继续输入；
- 新建或恢复 Session 失败：保留旧 Harness 和订阅；
- 模型切换失败：保留原模型；
- Permission 用户取消：返回 deny；
- 展示 listener 失败：报告但不改变 Agent 运行；
- EOF 和 `/exit`：正常退出。

## 13. 完整启动路径

生产入口的确定顺序为：

```text
1. parse CLI
2. if init: create missing templates and exit
3. resolve startup directory and Project directory
4. resolve ~/.kea and ordinary config source paths
5. parse built-in defaults
6. load ~/.kea/config.json when present
7. load <project>/.kea/config.json when present
8. load --config file when specified
9. apply direct CLI overrides such as --verbose
10. load ~/.kea/auth.json
11. validate and construct the single Config
12. create explicit ModelRuntime providers from Config
13. create readline UI and obtain ui.interactions
14. open/create Coding Agent Project
15. create a new Harness, or for -c open sessions[0]
16. validate the initial Harness model against configured models
17. run the readline UI
18. finally unsubscribe and close readline
```

对应组合代码形状为：

```ts
async function main(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv);
  if (args.command === "init") {
    await initializeUserConfiguration();
    return;
  }

  const projectDirectory = await resolveProjectDirectory(args.directory);
  const keaHome = resolveKeaHome();
  const config = await Config.load({
    keaHome,
    projectDirectory,
    configOverride: args.config,
    verbose: args.verbose,
  });
  const runtime = createModelRuntime({
    providers: config.runtimeProviders(),
  });
  const ui = new ReadlineUi({
    models: config.models,
    thinking: config.thinking,
    toolDetails: config.toolDetails,
  });
  const project = await openOrCreateProject({
    keaHome,
    projectDirectory,
    runtime,
    modelConfig: config.defaultModel,
    interactions: ui.interactions,
    maxTurns: config.maxTurns,
    toolTimeoutSeconds: config.toolTimeoutSeconds,
    onListenerError: ui.reportListenerError,
  });
  const initial = await selectInitialHarness(project, args.continue);

  try {
    await ui.run(project, initial);
  } finally {
    ui.close();
  }
}
```

`resolveKeaHome()` 在生产中固定为 `resolve(homedir(), ".kea")`。测试可以把 home、文件系统路径和
环境显式注入各个 helper，但生产不通过普通配置改变凭据目录。

## 14. 建议模块位置

无需增加 Application 类，但应避免把所有逻辑堆进 `main.ts`：

```text
src/
  application/
    arguments.ts              # 启动参数解析
    project-directory.ts      # cwd / Git 根发现
    config.ts                 # Config 及其内部读取、合并、验证、脱敏
    init.ts                   # kea init
  ui/
    readline-ui.ts            # 主循环、Session 激活和命令执行
    commands.ts               # slash 命令解析
    interactions.ts           # readline Permission adapter
    renderer.ts               # HarnessEvent 与历史展示
  core/
    ...
  coding-agent/
    ...
  main.ts                     # 唯一生产组合根
```

这些文件位置表达职责，不建立一套新的领域层。`application` 不能依赖 UI 的内部组件；`main.ts`
从 Config 取出 UI 实际需要的值传给 UI，UI 不持有整个 Config。

## 15. 不在第一版范围内

本设计明确不增加：

- steer、follow-up、并发普通 Prompt 或后台 Run；
- 通用 `select/confirm/input` Coding Agent Interaction；
- Permission request/reply Events 或 UI intercept；
- Project 级公开 Events；
- 多 Project 切换；
- 每个 Provider 的多个配置模型；
- `maxToolCalls`、memory、verification；
- Project 配置中的任何凭据；
- dotenv production loading；
- 插件、MCP、远程 RPC UI 或异步 UI 事件队列；
- `Application`、`AppController` 或额外 Session manager。

这些能力出现真实需求时，应在现有边界上单独设计，而不是预留无消费者配置或抽象。

## 16. 验证要求

### 16.1 Project discovery 与工厂

- Git 子目录解析到规范 work-tree 根；
- 非 Git 目录使用自身规范路径；
- 缺失目录、文件路径、Git 执行故障明确失败；
- `openOrCreateProject()` 不再执行 Git discovery；
- 非规范、非绝对或不存在的 `projectDirectory` 被拒绝；
- 相同 Project directory 继续复用同一 Project 记录。

### 16.2 Harness subscription

- 每种公开 emit 事实投影成正确 `HarnessEvent`；
- 只收到当前 Harness sessionId 的内部事实；
- intercept 控制点不进入订阅；
- 订阅不重放历史；
- unsubscribe 幂等且之后不再收到事件；
- listener 抛错不终止 Run；
- Project 不再公开 raw Events。

### 16.3 UI 循环

- 普通 Prompt 原样提交并等待 Run 完成后才读取下一条；
- 只有开头精确已知 slash token 成为命令；
- 未知 slash 输入和中间 slash 保持普通 Prompt；
- Session 切换成功后取消旧订阅、渲染历史并订阅新 Harness；
- Session 切换失败时旧状态不变；
- 模型只从配置列表选择并持久化；
- 恢复到已移除模型时要求重新选择；
- `/exit`、EOF 和 abort 行为符合设计。

### 16.4 Interaction

- Permission 在 `harness.prompt()` 未完成期间临时使用 readline；
- Interaction 完成后 Agent 继续，Run 完成后外层循环再读取普通 Prompt；
- once、always、deny 映射到现有 PermissionReply；
- 用户取消和 Run abort 被区分；
- 没有并发 Permission 输入。

### 16.5 配置

- 缺失可选用户/Project 配置被跳过；
- `--config` 缺失明确失败；
- 优先级、Provider 深合并和 CLI override 正确；
- 每个文件在合并前独立拒绝未知字段；
- null、错误枚举、错误 URL 和数值边界被拒绝；
- defaultProvider 单一推断、多 Provider 缺省错误和未知引用正确；
- 普通配置中的所有 credential 字段被拒绝；
- 启用 Provider 缺少 auth 时失败；
- Config 只有私有 Provider map 持有秘密，普通字段、UI state 和日志不含秘密；
- models 和 defaultModel 稳定生成；
- 已删除功能字段不能被静默接受。

### 16.6 Runtime 与策略

- Runtime 为每个显式 Provider 创建 adapter；
- 未知、重复或未配置 Provider 请求明确失败；
- ModelConfig 的 provider 选择 adapter，model 原样传递；
- production main 不读取 process.env 凭据且不调用 dotenv；
- maxTurns 到达 AgentLoopConfig；
- timeoutSeconds 到达每个 Harness 的 Tool Registry；
- 两项运行策略不写入 Session。

### 16.7 Init、错误与脱敏

- `kea init` 创建缺失目录和两个模板；
- 任一已有文件永不覆盖；
- 只补缺失文件且可重复执行；
- auth 权限在支持平台符合要求；
- 配置错误包含来源路径和字段路径；
- JSON/Auth 错误不输出原始秘密；
- 顶层、verbose 和 listener error 中出现的实际 Key 被替换为 `[REDACTED]`；
- 启动错误退出码为 1，正常 init/exit 为 0。

所有测试使用 fake ModelRuntime、临时 home、临时 Project 和内存/临时 readline adapter，不发起真实
Provider 网络请求。
