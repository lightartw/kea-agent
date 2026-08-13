# Coding Agent 精简与 README 重写设计

## 目标

`coding-agent` 是建立在 Harness 之上的项目级装配层。它不重新管理运行或 Session，
而是为一个代码项目选择 system prompt、内置工具、权限 Hook 和 UI 接口，再返回可供前端
使用的 Harness。

本次修改删除没有产生实际扩展能力的中间定义，并按读者已经理解 Harness 的前提重写
README。精简不得改变 Agent Loop、Harness、Session、工具行为或权限规则。

## 判断标准

一个定义只有满足下列至少一项才保留：

- 隐藏了调用者不应重复处理的实现；
- 存在两个真实实现，需要稳定接口；
- 隔开执行与 UI，维持包依赖方向；
- 是外部扩展 Coding Agent 所需的最小公共契约。

只换名字的类型、没有调用者的汇总文件、只有一个实现的预留接口，以及只转发一次的
工厂均应删除或合并。

## Coding Agent 的核心模型

Coding Agent 接收 Project、模型请求能力、Session 和可选 UI interactions，输出：

- 一个已经装好 coding 能力的 `AgentHarness`；
- 一个只读的 `renderToolEvent(event)`，供前端展示工具事件。

Harness 仍是上层运行入口。Coding Agent 只在创建期间直接接触 Agent Tool 和 Hook，
因为把具体能力装入 Harness 正是组合根的职责。

## Tool Definition

保留 `CodingToolDefinition`。它是必要的翻译层：一个 coding 工具需要同时声明执行信息和
可选展示规则，但 Agent 层只能接收执行能力。Coding Agent 创建时将一个 definition 分成：

- 向下转换为 `AgentTool`，交给 Agent 执行；
- 将可选 presentation 注册在 Coding Agent 内，交给 UI 使用。

definition 与转换函数属于同一概念，合并在一个文件中。转换函数不再作为根公共 API。

默认工具列表直接出现在 `factory.ts`。这样打开组合根即可看到产品安装了 Bash、文件、Glob
和 Todo，不需要追踪一个只返回数组的额外工厂。

## Bash

Bash 只保留两个模块：

- `bash.ts`：schema、本地进程执行和工具 definition；
- `bash-policy.ts`：allow、ask、deny 分类。

policy 必须独立，因为 Permission Hook 和 Bash 执行的最后安全防线都会使用它。
`BashOperations` 与 `LocalBashOperations` 删除：当前只有本地进程这一种后端，接口与类没有
降低调用复杂度。以后真正增加 SSH 或容器执行时，再依据两个真实实现抽取接口。

## Todo

Todo 合并为一个 `todo.ts`，就近放置参数、`TodoItem`、`TodoDetails`、模型可见文本和工具
presentation。

`todo_write` 不持有隐藏状态。每次调用接收完整列表，并将同一列表写入：

- `content`：模型下一轮能够看到；
- `details.todos`：Session 和 UI 能够读取。

因此 Todo 状态属于 Session，而不是一次 run 或某个工具实例。当前没有常驻 Todo UI，
`findLatestTodoDetails()` 没有生产调用者，先删除。未来出现真实消费者时，应在 Todo 领域模块
增加从当前 Session 分支读取状态的函数，而不是在 UI 中复制扫描逻辑。

## Hook 与 Interactions

Permission 是当前唯一 Coding Hook。它直接创建并返回带有 Coding context 的
`HookRegistry`；删除只换名的 `CodingHookRegistry` 和独立的 context 文件。

`CodingAgentInteractions` 只保留：

- `confirm(request, signal)`：需要用户决定时等待结果；
- `notify(notification)`：向前端发送非阻塞通知。

删除 `available`。无 UI 的默认 Adapter 通过 `confirm() => false` 表达 fail-closed，无须再用
一个布尔值描述同一事实。

## UI 输出

工具 presentation 仍与执行分离。Coding Agent 内部可使用 registry，但 `CodingAgentRuntime`
不暴露注册能力，只暴露：

```ts
renderToolEvent(event: HarnessToolEvent): string
```

前端因此只能消费工具事实，不能在 Runtime 创建后修改 Coding Agent 的工具展示定义。
删除 `ToolPresentationOutput = string`，直接使用 `string`。

## 文件与公共 API

目标结构：

```text
src/coding-agent/
  factory.ts
  types.ts
  coding-system-prompt.ts
  README.md
  hooks/
    permission.ts
  tools/
    definition.ts
    builtin/
      bash.ts
      bash-policy.ts
      files.ts
      todo.ts
  ui/
    interactions.ts
    presentation.ts
```

具体文件可以在实现时因测试 locality 做小幅调整，但不得恢复无调用者的 barrel、单实现
interface 或只返回默认数组的工厂。

根入口保留普通使用和真实扩展需要的最小能力：

- `createCodingAgent`
- `CODING_SYSTEM_PROMPT`
- `NO_INTERACTIONS`
- `CodingAgentRuntime`、`CreateCodingAgentConfig`
- `CodingAgentInteractions` 及其请求类型
- `CodingToolDefinition`、`CodingToolContext`
- `CodingToolPresentation` 及其事件输入类型
- `TodoItem`、`TodoDetails`

默认工具工厂、Tool 转换函数、默认 Hook 工厂、Hook context 和 presentation registry 不再从根
入口导出。

## README 顺序

README 假设读者已理解 Harness，并依次解释：

1. Coding Agent 在 Harness 之上增加什么；
2. Project 及 `createCodingAgent()`；
3. 一次运行怎样经过 Harness、Hook、Tool 和 UI；
4. Coding Tool Definition 为什么存在；
5. Bash 的权限判断和进程执行；
6. Todo 的无状态执行与 Session 状态；
7. interactions、Harness Event 和 presentation；
8. 文件结构、依赖方向和完整公共 API。

内部组装步骤只在解释对应概念时出现，不让 registry、adapter、projection 等实现词汇先于
核心模型出现。

## 验收

- 普通调用者只通过 `createCodingAgent()` 获得 Harness 和工具事件渲染函数；
- 根入口不再导出仅供内部组装使用的函数、registry 或 Hook context；
- 不再存在未使用的 `tools/index.ts`、`hooks/index.ts`；
- Bash 没有单实现 backend interface；
- Todo 的输入、输出、presentation 和类型集中，且工具仍不持有跨调用状态；
- Permission 行为和无 UI 时的 fail-closed 行为不变；
- README 能让理解 Harness 的读者逐步预测 Bash、Todo 和 UI 的完整数据流；
- 测试、类型检查、import smoke test 和文档一致性检查通过。
