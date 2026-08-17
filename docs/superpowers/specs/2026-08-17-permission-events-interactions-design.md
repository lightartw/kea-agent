# Permission、Events 与 Interactions 设计

## 1. 目标

本设计重新定义 Coding Agent 的 Tool Events、Permission 和主动交互边界。目标是：

1. Tool 只实现工具逻辑，不知道 Permission、Events、Session、Project 或 UI；
2. Permission 作为 `tools/pre-execute` listener，在 Tool 执行前做逻辑决策；
3. Events 表达内部已经发生的事实或可拦截的执行控制点；
4. Interactions 表达内部逻辑主动向外部索取回答；
5. Event 与 Interaction 都不包含终端、网页、按钮或排版语义；
6. 为未来插件注册 Tool 及其配套 Permission listener 保留边界，但本次不设计插件系统。

本设计接续 `2026-08-17-built-in-tools-design.md`。六个内置 Tool 仍是直接的
`AgentTool`，不向 Tool 注入 Permission 或 Interactions。

## 2. 本次范围

本次设计并实现以下内容：

- Tool Event 的输入身份与执行顺序；
- UI 无关的 `Interactions.permission()`；
- Permission request、reply、规则语义和失败行为；
- Permission listener 与 `tools/pre-execute` 的连接；
- 现有 UI interaction 类型从 Coding Agent 逻辑层移除。

以下内容明确延后：

- Project 对 Session cwd、project directory 和已授权目录的具体装配；
- Permission 规则的磁盘持久化位置和 Project 配置格式；
- 插件发现、加载、生命周期和 Extension Context；
- 通用 Question、confirm、select、input 等其他交互；
- UI 的 Permission 弹窗和 Tool Result 展示组件。

外部目录与危险命令的规则语义在本文定稿，但依赖 Project 环境的数据来源在后续
Project 设计中接入。

## 3. 参考产品及取舍

### 3.1 Pi

Pi 的 extension handler 接收丰富的 `ExtensionContext`，其中直接包含
`ExtensionUIContext`、cwd、Session、模型和取消能力。它的 permission-gate 示例在
`tool_call` handler 内调用 `ctx.ui.select()`；没有 UI 时默认阻止危险命令。

这种设计对插件作者非常方便，但 Tool 事件处理逻辑直接依赖 UI 能力。Kea 保留它“一切功能可由
扩展注册”的方向，不采用 Permission 对 `ctx.ui` 的耦合方式。

参考：

- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts>
- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/permission-gate.ts>

### 3.2 OpenCode

OpenCode 的 Tool Context 暴露 `ask()`，Tool 主动发起 Permission。Permission service 保存
pending request 和已批准规则，并使用 `once`、`always`、`reject` 回答；远程 UI 通过 asked/replied
事件和 reply API 完成往返。

它的优点是 Tool 最了解自己的权限语义，缺点是每个 Tool 都感知 Permission。Kea 选择更彻底的
分离：Tool 不拥有发起 Permission 的能力；Permission listener 从 Tool Event 识别并拦截调用。
Kea 当前是直接异步调用拓扑，因此不复制 pending map、asked/replied Event 和 reply endpoint。

参考：

- <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/tool.ts>
- <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/permission/index.ts>

## 4. 两种数据流

Events 和 Interactions 解决的是相反方向的问题。

```text
外部输入 -> 内部执行 -> Event -> 外部 listener 消费并展示

内部逻辑 -> Interaction request -> 外部展示并取得回答
         <- Interaction reply   <-
```

Events 适合事实通知和已有执行过程的拦截点。Interactions 是内部主动等待外部回答的端口。
Permission 不能仅靠单向 Event 获得用户回答，也不新增 `permission/request` Event 来模拟一次
请求/响应协议。

Interactions 不叫 Bridge，也不带 `CodingAgent` 前缀。建议文件为：

```text
src/coding-agent/interactions.ts
```

本次只有 Permission 需要主动交互，因此不增加 `question()`，也不提前增加
`confirm()`、`select()`、`input()`。这些方法描述 UI 操作方式，而不是 Coding Agent 的领域需求。
通知属于单向事实，不放入 Interactions。

## 5. ToolExecutionContext 与 Tool Event

`AgentToolRegistry.execute(call, executionContext)` 已经接收 `ToolExecutionContext`：

```ts
interface ToolExecutionContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly events: Events;
  readonly signal?: AbortSignal;
}
```

它是 Registry 编排一次 Tool Call 所需的环境，不传给具体 Tool。`call` 是明确的执行对象，继续作为
`execute()` 的第一个参数。

不能把整个 `ToolExecutionContext` 放进 Event 输入：`events` 会形成无意义的自引用并鼓励 listener
触发嵌套 Event；`signal` 已经由 `intercept()` 单独传给 listener。Registry 只提取 Event 消费者需要的
Run 身份。

为避免在 `EventMap` 中反复拼接交叉类型，定义两个可读的事件输入：

```ts
interface ToolCallEvent {
  readonly sessionId: string;
  readonly runId: string;
  readonly call: AgentToolCall;
}

interface ToolResultEvent extends ToolCallEvent {
  readonly result: AgentToolResult;
}
```

Tool Event 契约为：

```ts
"tools/pre-execute": InterceptEvent<ToolCallEvent, PreToolDecision>;
"tools/execute": InterceptEvent<ToolCallEvent, AgentToolResult>;
"tools/post-execute": InterceptEvent<ToolResultEvent, AgentToolResult>;
```

`ToolCallEvent` 和 `ToolResultEvent` 是 Event 输入，不是新的执行 Context。它们也可以被
`agent/tool-call` 和 `agent/tool-result` 复用，避免两套相同的 Session/Run/Call 结构。

### 5.1 执行顺序

```text
Agent Loop
-> registry.execute(call, executionContext)
-> lookup Tool
-> validate arguments
-> tools/pre-execute
-> tools/execute
-> tools/post-execute
-> agent/tool-result
```

lookup 和参数校验必须在 `tools/pre-execute` 前完成。未知 Tool 或参数无效时直接返回错误，不询问
Permission。

`tools/pre-execute` 是只读控制点。listener 只能继续或拒绝，调用 `proceed(input)` 时必须传回同一
input，不能用它改写 Tool Call。实际参数变换不属于 Permission 设计。

## 6. Interaction 契约

`PermissionRequest` 是内部逻辑与外部 adapter 之间必要的结构化契约，不包含 title、message、
按钮文字或其他 UI 排版。

```ts
type PermissionOperation =
  | "read"
  | "write"
  | "edit"
  | "glob"
  | "execute";

type PermissionRequest =
  | {
      readonly kind: "dangerous-command";
      readonly sessionId: string;
      readonly runId: string;
      readonly call: AgentToolCall;
      readonly command: string;
      readonly cwd: string;
      readonly reason: string;
    }
  | {
      readonly kind: "external-directory";
      readonly sessionId: string;
      readonly runId: string;
      readonly call: AgentToolCall;
      readonly operation: PermissionOperation;
      readonly targetPath: string;
      readonly directory: string;
      readonly reason: string;
    };

type PermissionReply =
  | { readonly kind: "once" }
  | { readonly kind: "always" }
  | { readonly kind: "deny"; readonly reason?: string };

interface Interactions {
  permission(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<PermissionReply>;
}
```

`request.reason` 解释系统为什么要求授权；`reply.reason` 是用户拒绝时给 Agent/LLM 的反馈。
UI 可以按 `request.kind` 做不同展示，但不能改变授权范围。

直接调用由返回的 Promise 关联请求和回答，因此领域契约不需要 `requestId`。RPC、WebSocket 等远程
adapter 如需 pending map 和 transport request ID，应在 adapter 内部实现，不能迫使进程内调用也
承担远程传输协议。

没有可用 adapter 时，默认 `Interactions` 必须返回带原因的 deny，不能自动批准。例如原因可以是
`Permission request failed: interaction unavailable`。listener 对显式 reason 原样传递；只有 reason
缺失时才使用 `Permission denied by user`。

## 7. Permission 的三层语义

必须区分策略计算和用户回答。

策略计算结果是：

```text
allow | ask | deny
```

- `allow`：已有规则已经允许，不发生 Interaction；
- `ask`：没有现成结论，需要外部回答；
- `deny`：硬性规则直接拒绝，不允许用户覆盖。

Interaction 回答是：

```text
once | always | deny
```

- `once`：只执行当前 Tool Call，不修改规则；
- `always`：先记录当前请求对应的 allow 规则，再执行当前 Tool Call；
- `deny`：拒绝当前 Tool Call，不创建永久 deny 规则。

因此 `allow` 与 `once`/`always` 不重复：`allow` 是询问前的既有策略结论，后两者是发生询问后的
用户选择。

## 8. Permission 规则

Permission 保存两类逻辑规则：

```ts
type PermissionRule =
  | {
      readonly kind: "command";
      readonly command: string;
      readonly cwd: string;
    }
  | {
      readonly kind: "directory";
      readonly directory: string;
    };
```

`PermissionRule` 是 `always` 真正写入并在后续请求中匹配的状态，不是 UI DTO。

### 8.1 危险命令

危险命令的 remembered allow 使用完整命令文本和执行 cwd 精确匹配。不能按风险类别批准所有
`rm`，第一版也不引入 Shell pattern 推导。

Shell 文本不做自定义归一化，因为空格、引号和转义可能改变语义。command 或 cwd 任一不同就重新
询问。硬性 deny 始终先判断，旧 allow 规则不能覆盖后来命中的硬性禁止规则。

### 8.2 外部目录

Project directory 是默认可信范围，不是不能逃出的硬边界。目标位于 Project directory 外时需要
Permission；用户选择 `always` 后记录规范化的绝对目录。

目录规则允许该目录及其所有后代，对所有内置 Tool 的 read、write、edit、glob、execute 生效；不
允许其父目录或兄弟目录。路径包含关系必须用平台路径语义判断，不能使用字符串 `startsWith()`。

规范化与符号链接处理属于 Project/path-policy 集成，但最终比较对象必须是可信的绝对路径。对于
尚不存在的写入目标，需要以最近存在的祖先解析实际路径，避免通过符号链接逃逸已批准目录。

Shell 可以动态计算路径，静态命令分析只能提供尽力检查，不能被描述成完整文件系统沙箱。若产品
需要强安全边界，必须在执行环境增加 OS 级 sandbox；这不属于 Event 或 Permission listener。

### 8.3 规则优先级和生命周期

判断顺序固定为：

```text
hard deny > remembered allow > ask
```

本阶段规则状态由 Permission listener 持有，生命周期与它所在的 Coding Agent runtime 相同。
Project 阶段再决定 durable storage；持久化位置不能反向改变本文的 request、reply 或 Event 契约。
当前内存规则写入是同步操作，不增加 RuleStore 抽象。未来接入持久化后，只有规则保存成功才能把
`always` 当作批准；保存失败必须拒绝当前执行，不能静默退化成 `once`。

## 9. Permission listener 数据流

Permission 注册为 `tools/pre-execute` listener。Tool 不调用它，也不知道它存在。

```text
收到 ToolCallEvent
│
├─ 与 Permission 无关
│  └─ proceed(input)
│
├─ 命中 hard deny
│  └─ PreToolDecision.deny(rule reason)
│
├─ 命中 remembered allow
│  └─ proceed(input)
│
└─ ask
   └─ interactions.permission(request, signal)
      ├─ once
      │  └─ proceed(input)
      ├─ always
      │  ├─ save allow rule
      │  └─ proceed(input)
      └─ deny
         └─ PreToolDecision.deny(user reason or default)
```

这条链只有一个 Event 截断点和一次普通 Interaction 调用，不产生嵌套 Event。

`PreToolDecision.deny.reason` 最终进入错误 `AgentToolResult`，成为 LLM 可见反馈：

```text
Error: sudo is not allowed
Error: 不要删除这个文件
Error: Permission request failed: interaction unavailable
```

## 10. 失败和取消

- Run signal 已取消：传播取消，不伪装成用户拒绝；
- Interaction 不存在、断开或抛错：关闭式失败，拒绝 Tool；
- adapter 返回无效 Reply：按 Interaction 错误处理并拒绝；
- 当前内存 `always` 先写入规则再继续；未来持久化保存失败时拒绝当前执行，不能静默退化成
  `once`；
- 用户 deny 且带 reason：将 reason 返回给 LLM；
- 用户 deny 未带 reason：使用 `Permission denied by user`；
- hard deny：不调用 Interactions。

listener 或 adapter 的技术错误不能让 Tool 绕过 Permission。错误文本应区分系统规则、用户拒绝和
交互故障，避免向 LLM 提供错误归因。

## 11. UI 与特殊 Tool 展示

UI adapter 实现 `Interactions.permission()`，可以用终端选择框、网页按钮、桌面弹窗或远程 RPC
取得相同的 `PermissionReply`。这些实现细节不进入 Coding Agent 逻辑契约。

`todo_write` 不需要特殊 Event 或 Interaction。它的完整状态已经位于
`AgentToolResult.details.todos`，`agent/tool-result` 同时携带 Session、Run、Call 和 Result。UI
可以按 Tool 名称读取结构化 details 做特殊展示；特殊呈现不等于特殊逻辑流。只有当 Todo 将来成为
可被 Tool 之外的 API 修改和查询的独立领域状态时，才增加专门的 Todo service/event。

## 12. 未来插件边界

本次不设计插件系统，但边界允许未来插件：

1. 注册新的 `AgentTool`；
2. 注册识别该 Tool Call 的 `tools/pre-execute` listener；
3. listener 在需要外部回答时使用语义化 Interaction；
4. 注册独立的 Tool Result renderer。

内置 Tool 和未来插件 Tool 使用同一 Registry/Event 契约。当前不增加万能 Context 或 service
locator；等插件生命周期、命令、MCP、subagent 等共同需求明确后，再设计 Extension Context。

## 13. 测试要求

### 13.1 Tool Events

- 三个 Tool Event 都携带正确的 sessionId、runId 和 call；
- post-execute 额外携带 result；
- unknown Tool 和参数校验失败不会触发 Permission；
- pre-execute deny 跳过 execute/post-execute 并生成唯一错误结果；
- listener 收到 Run signal。

### 13.2 Permission

- ordinary call 直接 proceed；
- hard deny 不调用 Interactions；
- ask + once 执行但不记录规则；
- ask + always 先记录规则再执行；
- remembered allow 不再次询问；
- hard deny 覆盖 remembered allow；
- deny reason 进入最终 Tool Result；
- 无 reason 时使用默认反馈；
- Interaction 故障和无效 Reply 均关闭式失败；
- abort 不被报告为用户拒绝。

### 13.3 规则匹配

- command 只有文本和 cwd 都相同时命中；
- directory 命中自身与后代，不命中相似前缀、父目录或兄弟目录；
- Windows 大小写和分隔符行为遵循所选路径规范化实现；
- 外部目录的 read、write、edit、glob、execute 使用同一 remembered directory rule。

## 14. 完成标准

设计落地后应满足：

1. `src/coding-agent/tools/` 不导入 Events、Permission、Interactions 或 UI；
2. core Tool Event 具有可关联的 Run 身份，但不包含 Project/UI 数据；
3. Coding Agent 通过 `Interactions.permission()` 主动索取回答；
4. Permission 只通过 `tools/pre-execute` 控制 Tool 执行；
5. 没有 `permission/request` 嵌套 Event；
6. 没有 `CodingAgentInteractions`、通用 confirm/select/input 或 notify 契约；
7. once、always、deny 及拒绝反馈语义有测试覆盖；
8. Project 改造可以在不改变 Event/Interaction 契约的前提下接入 cwd、可信目录和规则持久化。
