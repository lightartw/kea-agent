# Coding Agent 目录与 README 重构设计

## 目标

让读者从目录和 README 就能区分：

- Coding Agent 提供的通用 Tool、Hook、UI 契约；
- Kea 默认安装的具体 Tool 和 Hook；
- Tool 运行时数据、Session 状态和项目外部状态的生命周期；
- UI 交互请求与工具展示的不同职责。

本次重构只整理已有模块、统一命名并重写文档，不增加 ExtensionHost、状态容器、UI 插件系统或新的运行行为。

## Tool state 的定义

Coding Agent 不提供统一的 `ToolState`。不同数据属于不同所有者和生命周期：

| 数据 | 所有者 | 生命周期 |
|------|--------|----------|
| Tool Call 参数、AbortSignal、执行结果 | Agent 的一次工具调用 | 调用结束即结束 |
| Tool Definition、执行后端、`CodingToolContext` | `CodingAgentRuntime` | 从 `createCodingAgent()` 到该 Runtime 被丢弃 |
| 可恢复的领域状态 | Session 中的消息和 tool result details | 跨 run；恢复同一 Session 后仍存在 |
| 文件内容和命令产生的外部变化 | `cwd` 指向的项目环境 | 可跨 run、Session 和 Runtime |

Tool 实例不应暗中保存需要恢复的领域状态。需要跨 run 恢复的数据必须进入 Session，或明确属于项目外部环境。

TodoWrite 是这一规则的示例。每次调用接收完整列表并返回 `content + details.todos`；Harness 将结果写入 Session。当前 Todo 列表由消息历史投影得到，不保存在 TodoWrite 实例中。因此原 `todo-state.ts` 改名为 `todo/projection.ts`。

## 目标目录

```text
src/coding-agent/
  factory.ts
  types.ts                    # factory input and output types
  coding-system-prompt.ts
  README.md

  tools/
    definition.ts
    wrapper.ts
    index.ts
    builtin/
      factory.ts
      bash/
        definition.ts
        operations.ts
        policy.ts
      files.ts
      glob.ts
      todo/
        definition.ts
        projection.ts

  hooks/
    types.ts
    index.ts
    builtin/
      factory.ts
      permission.ts

  ui/
    interactions/
      types.ts
      unavailable.ts
    presentation/
      types.ts
      registry.ts
```

测试目录同步镜像 `src/coding-agent/` 的职责结构。测试只为移动修改 import；测试语义不改变。

## Tools

`tools/` 根部只放所有 Coding Tool 共用的机制：

- `definition.ts` 定义 `CodingToolDefinition` 和 `CodingToolContext`；
- `wrapper.ts` 将 Coding Tool 投影成不包含展示信息的 `AgentTool`；
- `index.ts` 汇总公开 Tool API。

`tools/builtin/` 只放 Kea 默认提供的工具。`createDefaultToolDefinitions()` 位于 `builtin/factory.ts`，清楚表达它组装的是内置集合。

同一个具体 Tool 的参数 schema、执行代码、details 类型和可选 presentation 保持就近。只有 Bash 因为执行后端和安全策略各自具有独立职责，拆为 `definition.ts`、`operations.ts` 和 `policy.ts`。

## Hooks

`hooks/types.ts` 保留所有 Coding Hook 共用的 `CodingHookContext` 和 `CodingHookRegistry`。

`hooks/builtin/` 放默认 Permission Hook 及默认组合工厂。工厂重命名为：

```ts
createDefaultCodingHookRegistry(context): CodingHookRegistry
```

旧名称 `createCodingHookRegistry` 删除，不保留别名。新名称明确该函数会安装 Kea 的默认 Hook，而不是创建任意空 Registry。

## UI 契约

Coding Agent 只定义 UI seam，不实现 CLI：

- `ui/interactions/`：Hook 主动请求 UI 执行 `confirm` 或 `notify`；
- `ui/presentation/`：将工具运行事件转换为展示文本。

`interactions/types.ts` 放请求与 port 类型；`interactions/unavailable.ts` 放默认 fail-closed Adapter `NO_INTERACTIONS`。

`presentation/types.ts` 放工具展示契约；`presentation/registry.ts` 按工具名选择 presentation 并提供 fallback。

具体工具的 presentation 继续和该 Tool Definition 放在一起。presentation 是工具语义的一部分，而 Registry 是通用展示机制。CLI 仍位于顶层 `src/ui/`，作为这些 seam 的具体 Adapter。

本次不预先增加 Web/TUI 目录、基类、插件注册协议或前端中立渲染树。现有两条 seam 已足够支持以后增加不同 Adapter；出现第二种输出格式后再扩展 presentation 输出模型。

## Coding Agent README

README 改为渐进式结构：

1. Coding Agent 相比 Harness 增加什么；
2. `createCodingAgent()` 最小用法；
3. `CodingAgentRuntime` 中的 Harness 与 presentations；
4. 工厂的一次完整组装过程；
5. Tool Definition、投影和四种数据生命周期；
6. Todo 状态如何通过 Session 恢复；
7. Hook、Interactions、Event 和 Presentation 的关系；
8. 目录结构和包依赖；
9. 完整公共 API 和内部实现。

README 首次使用术语时解释其输入、输出和所属层，不预设读者知道过去的设计讨论。它必须明确 `CodingAgentRuntime` 是上层 UI 的入口，同时解释 Coding Agent 在构造期直接使用 Agent Tool/Hook 契约是合法的组合根行为。

## 公共 API

重构后根入口继续公开当前能力，唯一破坏性命名变化为：

```text
createCodingHookRegistry
→ createDefaultCodingHookRegistry
```

移动文件不会要求普通消费者改用深层路径。公开入口仍由 `src/coding-agent/index.ts` 提供。内部测试和项目源码改用新路径；不为旧深层路径增加转发文件。

## 验收

- `src/coding-agent/` 目录能直接区分通用机制与 `builtin` 实现；
- 不再存在 `tools/todo-state.ts`、平铺的具体 Tool 文件或平铺的 Permission Hook；
- 不再存在 `createCodingHookRegistry`；
- README 能回答 Todo 状态属于哪个范围，以及文件状态为何不属于 Session；
- README 能区分 interactions、presentation、Harness Event 和 Agent Hook；
- 根入口仍完整导出 Coding Agent 的公共接口；
- 全部测试、类型检查和 import smoke test 通过。
