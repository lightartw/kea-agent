# Permission、Events 与 Interactions 设计

## 阅读前提

本文的读者已经阅读 `src/core/ai`、`src/core/events`、`src/core/agent` 和
`src/core/harness` 的 README，理解 `Events.emit()`、`Events.intercept()`、
`AgentRunIdentity`、`ToolExecutionContext`、Tool Registry 和 Harness 的职责。本文不重复这些
机制，只解释 Coding Agent 在其上增加的 Permission 和主动交互语义。

本文接续 `2026-08-17-built-in-tools-design.md`。六个内置 Tool 仍是直接的 `AgentTool`；Tool
只实现操作，不接收 Permission、Interactions、Project 或 UI 能力。

## 1. Coding Agent 增加的两个能力

core 已经提供 Tool 执行和拦截机制，但不知道什么是危险命令、Project 外部目录或用户授权。
Coding Agent 在 core 之上增加两个能力：

- **Permission**：根据 Coding Agent 的安全规则决定一次 Tool Call 是 `allow`、`ask` 还是
  `deny`；
- **Interactions**：当决定为 `ask` 时，向 Coding Agent 外部请求一个回答并等待结果。

Permission 注册为 `tools/pre-execute` listener。它不进入 Tool，也不成为 Registry 的内建策略。
Interactions 是 Permission 使用的外部端口，不表示任何具体 UI。

一次需要询问的调用经过以下路径：

```text
AgentToolRegistry
  -> tools/pre-execute
  -> Permission listener
  -> Interactions.permission(request)
  <- PermissionReply
  -> PreToolDecision
  -> Tool 或错误 Tool Result
```

这里没有第二个 Permission Event。`tools/pre-execute` 是执行控制点；
`Interactions.permission()` 是内部主动取得外部回答的调用。

## 2. Events 与 Interactions 的边界

Events 沿用 core 已有语义：行为拥有者发布事实，或者开放一个可由 listener 包裹的待执行行为。
外部系统通常通过 listener 消费这些 Event，用于显示、日志或扩展逻辑。

Interactions 的方向相反。Coding Agent 内部发起一个领域请求，并等待外部返回回答：

```text
内部 -> PermissionRequest -> 外部 adapter -> 人或其他决策者
内部 <- PermissionReply   <- 外部 adapter <-
```

如果把请求也建模成 `permission/request` Event，系统还需要另一个 reply Event，以及 pending map、
request ID、超时和清理协议。那是远程传输层的实现方式，不是所有 Coding Agent 调用都必须承担的
领域模型。

直接 Interaction 用一次 Promise 关联 request 和 reply。终端、桌面 UI 或进程内测试可以直接实现
它；RPC adapter 如需 request ID，可以在自己的传输层生成。

## 3. Tool Event 契约

### 3.1 为什么需要修改输入

一个 Project 的 Events 可以被多个 Session 和 Run 共用。Permission 和外部 listener 必须知道
当前 Tool Call 属于哪个 Run。`ToolExecutionContext` 已经把这个身份带到 Registry，因此 Registry
只需把身份放入 Tool Event 输入。

整个 `ToolExecutionContext` 不进入 Event：`events` 本身不是 Event 数据，`signal` 也已经由
`intercept()` 单独传给 listener。

### 3.2 输入类型

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

`ToolCallEvent` 表示某个 Run 中的一次 Tool Call；`ToolResultEvent` 在同一组信息上增加执行结果。
它们是 Event 输入，不是新的 Context。

```ts
"tools/pre-execute": InterceptEvent<ToolCallEvent, PreToolDecision>;
"tools/execute": InterceptEvent<ToolCallEvent, AgentToolResult>;
"tools/post-execute": InterceptEvent<ToolResultEvent, AgentToolResult>;
```

`agent/tool-call` 和 `agent/tool-result` 表达相同载荷时也可以复用这两个类型，避免继续使用重复的
匿名交叉类型。

### 3.3 Registry 顺序

本设计调整 core README 当前记录的执行顺序。目标顺序为：

```text
lookup -> validate -> tools/pre-execute -> tools/execute -> tools/post-execute
```

未知 Tool 或无效参数不是可以授权的有效操作，因此直接产生错误结果，不进入 Permission。

`tools/pre-execute` 是只读决策点。listener 调用 `proceed(input)` 时传递同一个 input，或直接返回
`PreToolDecision.deny`。Registry 后续使用已经 lookup、校验过的原始 call；pre listener 不能借此
替换实际执行的 Tool Call。

## 4. Permission 的策略与回答

Permission 在询问外部之前先计算策略：

| 策略 | 含义 | 行为 |
| --- | --- | --- |
| `allow` | 当前操作安全，或已有规则允许 | 继续，不发生 Interaction |
| `ask` | 没有现成规则可以决定 | 请求 PermissionReply |
| `deny` | 命中不可覆盖的规则 | 拒绝，不发生 Interaction |

只有 `ask` 会产生回答：

| 回答 | 当前调用 | 规则状态 |
| --- | --- | --- |
| `once` | 允许 | 不修改 |
| `always` | 允许 | 先记录 allow 规则 |
| `deny` | 拒绝 | 不记录永久 deny |

`allow` 是询问前的策略结论；`once` 和 `always` 是询问后的回答。两组词属于不同阶段。

策略优先级是：

```text
hard deny > remembered allow > ask
```

硬性禁止先于已记录授权判断，避免旧授权覆盖后来命中的硬性安全规则。

## 5. Interactions 契约

Interactions 使用 Coding Agent 的领域语义，不暴露 `confirm()`、`select()`、`input()` 等 UI
操作。建议文件为 `src/coding-agent/interactions.ts`。

```ts
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

### 5.1 Request 提供的信息

- `sessionId`、`runId` 和 `call.id` 关联当前 Tool Call；
- `call` 保存 Tool 名称和完整参数，供外部展示调用本身；
- `kind` 区分危险命令和外部目录两种授权语义；
- `reason` 说明 Permission 为什么没有直接 allow；
- 命令请求额外提供 command 和执行 cwd；
- 目录请求额外提供目标路径和 `always` 将授权的目录。外部 adapter 通过原始 `call` 中的 Tool
  名称与参数展示操作，契约不重复暴露 Permission 内部的 Tool 分类。

这些字段描述逻辑，不规定标题、正文、按钮文字或排版。adapter 根据自己的界面生成展示。
Promise 已经关联本次 request 和 reply，因此领域对象不需要 `requestId`。

### 5.2 Reply 的拒绝原因

`deny.reason` 是外部提供给 Agent/LLM 的反馈。Permission 将非空 reason 原样写入
`PreToolDecision.deny.reason`；没有 reason 时使用 `Permission denied by user`。

例如外部返回：

```ts
{
  kind: "deny",
  reason: "不要删除这个文件，改为移动到回收站",
}
```

最终 Tool Result 中的模型可见内容为：

```text
Error: 不要删除这个文件，改为移动到回收站
```

### 5.3 当前只定义 permission()

本阶段没有其他确定的主动交互需求，因此不增加 `question()`，也不预先增加通用 UI primitives。
以后出现新的领域请求时再扩展 Interactions。单向通知继续使用 Event，不进入 Interactions。

没有外部 adapter 时不能构造完整的 builtin Events：`createBuiltinEvents()` 要求装配方显式提供
`Interactions`，缺失依赖在构造阶段暴露，而不是由 Agent 猜测默认行为。默认实现的 deny 语义在
装配方缺失 adapter 时无从产生，因此本设计不提供 `NO_INTERACTIONS`。

## 6. Permission listener

Permission 是 `tools/pre-execute` 上的 Coding Agent listener。它的分支如下：

```text
ToolCallEvent
  ├─ 与 Permission 无关 -> proceed(input)
  ├─ hard deny          -> deny(rule reason)
  ├─ remembered allow  -> proceed(input)
  └─ ask
       └─ interactions.permission(request, signal)
            ├─ once   -> proceed(input)
            ├─ always -> 记录规则，再 proceed(input)
            └─ deny   -> deny(reply.reason 或默认原因)
```

Permission listener 只返回 `PreToolDecision`，不执行 Tool。Tool 也不会主动发起 Permission。

## 7. `always` 规则

`always` 需要保存下一次能够匹配的授权范围：

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

这是 Permission 的逻辑状态，不是 Interaction reply 或 UI 数据。外部只决定 `always`，具体规则由
Permission 根据当前 request 生成。

### 7.1 危险命令

命令规则使用完整 command 和执行 cwd 精确匹配。第一版不批准整个风险类别，也不推导 Shell
pattern。命令文本不做自定义规范化，因为空格、引号和转义可能改变 Shell 语义。文本或 cwd 任一
不同就重新询问。

### 7.2 外部目录

Project directory 是默认可信范围，不是硬边界。Tool 可以访问外部目录；首次访问需要询问，
`always` 记录规范化后的绝对目录。

目录规则覆盖该目录和所有后代，对 read、write、edit、glob、execute 生效；不覆盖父目录或兄弟
目录。包含关系使用平台路径语义判断，不能使用字符串 `startsWith()`。

路径规范化、符号链接处理、Session cwd 和 Project directory 的来源由 Project/path-policy 阶段
负责。对于不存在的写入目标，后续实现需要解析最近存在的祖先，避免符号链接绕过已批准目录。

Bash 可以动态构造路径，因此静态分析只能提供尽力检查。Permission listener 不是文件系统
sandbox；需要强安全边界时应使用 OS 级执行隔离。

### 7.3 生命周期

`approved` 由 Project 创建并保存在内存中，同一 Project 的 Session 共享。Permission 不拥有该
数组，只在 `always` 时追加当前请求生成的规则。Project 实例释放或进程退出后规则消失；当前阶段
不落盘。可信目录来自 Project 配置，不写入 `approved`。

规则写入完成后才继续 `always` 请求，不增加 RuleStore 抽象。

持久化属于后续 Project 设计。未来接入持久化后，只有规则保存成功才能执行当前调用；保存失败不能
静默退化成 `once`。

## 8. 失败与取消

- hard deny 使用安全规则的 reason；
- 用户 deny 使用用户 reason，没有时使用默认拒绝原因；
- Interaction 不存在、断开、抛错或返回无效 reply 时关闭式失败；
- Run signal 已取消时传播取消，不报告成用户拒绝；
- `always` 必须先更新规则状态，再允许 Tool 执行。

系统规则、用户反馈和交互故障使用不同错误文本，使 LLM 能够正确判断下一步。任何技术故障都不能
使受保护操作绕过 Permission。

## 9. 模块边界

| 模块 | 本设计中的职责 |
| --- | --- |
| Tool | 根据已校验参数执行操作并返回结果 |
| Registry | 按顺序执行 Tool Event，并落实 PreToolDecision |
| Events | 分发 Tool 执行控制点和事实 |
| Permission | 计算策略并更新外部批准数组、调用 Interactions |
| Interactions | 定义内部主动向外部请求回答的端口 |
| 外部 adapter | 展示 PermissionRequest 并返回 PermissionReply |

未来插件可以注册 AgentTool 和配套的 `tools/pre-execute` listener，并使用相同 Interaction 边界。
本次只保证这个扩展方向，不设计插件加载、生命周期或 Extension Context。MCP、subagent 等能力留到
插件需求形成后统一设计。

## 10. Todo 展示

`todo_write` 不需要新的 Event 或 Interaction。完整 Todo 状态位于
`AgentToolResult.details.todos`，`agent/tool-result` 已携带 Session、Run、Call 和 Result。UI
可以根据 Tool 名称和结构化 details 特殊展示。

展示形式特殊不表示逻辑流特殊。只有 Todo 将来成为可被 Tool 之外的 API 修改、查询的独立状态时，
才增加 Todo service/event。

## 11. 当前阶段与 Project 阶段

当前 Event/Interaction 阶段负责：

- 调整三个 Tool Event 的输入；
- 调整 Registry 的 lookup、validate 和三个拦截阶段顺序；
- 定义 UI 无关的 `Interactions.permission()`；
- 让 Permission 的策略判断、外部 `approved` 数组以及 Interaction/`PreToolDecision` 映射脱离
  UI，并能用显式数据独立测试；
- 保持 Tool 不感知 Permission；
- 由 `createBuiltinEvents()` 接收装配数据（`interactions`、`approved`、`trustedDirectories`、
  `getSessionCwd`、`onListenerError`），创建 Events 并注册默认 Permission listener（含
  `proceed()` 落实）；Permission 只返回决定，不接触 Events 链。

后续 Project 阶段负责：

- 创建 Project 级 `approved` 内存数组并传给 `createBuiltinEvents()`；
- 按 sessionId 提供 `getSessionCwd` 的实现（Session cwd）与 Project trusted directories；
- 决定 command/directory rule 的持久化方式（当前不落盘）；
- 用 Permission 替代 Project 当前对外部 cwd 的硬性拒绝。

危险命令 request 和 command rule 需要 Session cwd；外部目录判断还需要 Project trusted
directories。Project 接入不改变 Tool API 或本文的 Interaction 契约。

## 12. 验证要求

### Tool Events

- pre、execute、post 都收到正确的 sessionId、runId 和 call；
- post 额外收到 result；
- unknown Tool 和无效参数不触发 pre/Permission；
- pre deny 跳过 execute/post，并产生一个错误 Tool Result；
- listener 收到当前 Run signal；
- pre listener 不能改变最终执行的 Tool Call。

### Permission 与 Interactions

- ordinary call 直接继续；
- hard deny 不调用 Interaction；
- once 执行但不记录规则；
- always 先记录规则再执行，后续匹配不重复询问；
- hard deny 覆盖 remembered allow；
- deny reason 原样进入 Tool Result，无 reason 时使用默认反馈；
- Interaction 故障和无效 reply 关闭式失败；
- abort 不报告成用户拒绝。

### 规则

- command 只有文本和 cwd 都相同时匹配；
- directory 匹配自身和后代，不匹配相似前缀、父目录或兄弟目录；
- 平台大小写和分隔符行为由统一路径规范化实现决定；
- remembered directory 对五种文件/执行操作使用同一规则。

## 13. 参考产品

Pi 的 `ExtensionContext` 直接提供 `ui`、cwd、Session 等能力；permission-gate 示例在
`tool_call` handler 中调用 `ctx.ui.select()`。这种设计便于 extension 直接完成交互。Kea 的 Tool
和 Permission 不接收 UI 能力，外部交互统一经过领域化 Interactions。

OpenCode 的 Tool Context 提供 `ask()`，Permission service 使用 pending request、asked/replied
事件和 reply API 支持远程调用。Kea 不让 Tool 发起 Permission；当前 Interaction 又使用直接
Promise，因此 pending 协议留给需要它的远程 adapter。

参考源码：

- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts>
- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/permission-gate.ts>
- <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/tool.ts>
- <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/permission/index.ts>
