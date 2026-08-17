# Coding Agent Built-in Tools 设计

## 目标

重建 `coding-agent` 的六个内建 Tool：

- `bash`
- `read_file`
- `write_file`
- `edit_file`
- `glob`
- `todo_write`

每个 Tool 直接实现 Core `AgentTool`，只负责参数、执行和结果，不依赖 UI、Permission、Project
Events 或插件系统。Tool 返回模型可见的 `content`、机器可读且 JSON-safe 的 `details` 和
`isError`；未来 UI 通过 Agent 已有的 Tool Call/Result 事件展示，不在 Tool 内注册 renderer。

本阶段不设计或实现 Permission。六个 Tool 和 Registry 工厂完成后暂不接入 `Project`，避免在
external-directory 和 dangerous-command Permission 尚未完成时把无保护的能力暴露到产品执行路径。

## 参考产品与取舍

Kea 的代码结构以 Pi Agent 为主要参照。Pi 的底层 `AgentTool` 把 schema、执行和结果放在一起，
coding-agent 层按 cwd 创建具体 Tool；Kea采用同样的直接 Tool 结构，但不复制 Pi `ToolDefinition`
中的 TUI renderer，也不复制 ExtensionContext。

Pi 参考：

- [AgentTool 类型](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts)
- [Bash Tool](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/bash.ts)
- [Read Tool](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/read.ts)

OpenCode 的 Tool Context 让 Tool 主动调用 `ask()`。Kea 已决定 Tool 对 Permission 完全无感知，
因此不增加 Tool Context 或 `ask()`。后续 Permission 由 `tools/pre-execute` listener 截断 Tool Call；
插件系统将来可以让插件在注册 Tool 之外注册配套 Permission listener，但不改变本阶段的 Tool 接口。

OpenCode 只作为功能行为参考：

- [Tool Context](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/tool.ts)
- [External directory 检查](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/external-directory.ts)
- [Shell Tool](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/shell.ts)

## 架构边界

删除 coding-agent 自己的 `ToolDefinition -> CodingAgentToolAdapter` 层。它重复 Core `AgentTool`，
并通过可选 `presentation` 把 Tool 定义反向耦合到 UI。

新的边界是：

```text
TypeBox schema + AgentTool subclass
                 │
                 ▼
       AgentToolRegistry
                 │
                 ▼
Core Agent 事实事件 ──► 未来 UI renderer registry
                 │
                 └────► 后续 Permission listener
```

Tool 只依赖：

- Core `AgentTool` 与 `AgentToolResult`；
- Node.js 执行或文件 API；
- 必要的纯函数工具。

Tool 不依赖：

- `coding-agent/ui/`；
- `coding-agent/events/`；
- `Project` 或 `ProjectInfo`；
- `Events`；
- Permission request/decision 类型；
- 尚未设计的插件 Host、loader 或生命周期。

## cwd 与路径

路径型 Tool 在创建时只接收 Session cwd：

```ts
createReadFileTool(cwd: string): AgentTool;
createWriteFileTool(cwd: string): AgentTool;
createEditFileTool(cwd: string): AgentTool;
createGlobTool(cwd: string): AgentTool;
createBashTool(cwd: string): AgentTool;
```

不增加 `CodingToolContext`。`todo_write` 与 cwd 无关，不接收 cwd。

共享路径函数只有一个职责：

```ts
resolveToolPath(cwd: string, input: string): string;
```

它使用 Node `resolve(cwd, input)` 返回规范化绝对路径。它不接收 Project directory，不判断路径是否
位于 Project 内，也不允许或拒绝访问。相对路径、绝对路径和 `..` 都按正常文件系统语义解析；外部
目录的检查与 once/always 记录属于后续 Permission。

不继续使用 `safePath(cwd, directories, path)`。本阶段不删除仓库级 `safePath()`，因为清理其其他
调用者不属于 Tools 边界。

## 结果与展示数据

所有 Tool 返回：

```ts
interface AgentToolResult<TDetails> {
  readonly content: string;
  readonly details?: TDetails;
  readonly isError: boolean;
}
```

- `content` 必须独立向模型说明结果、错误和截断；模型不能依赖 UI 才理解执行结果。
- `details` 只保存执行事实，不保存 renderer、颜色、展开状态或用户交互。
- `details` 必须能通过 Session 现有 JSON-safe 校验。
- Tool Call 已经保存 name 和 arguments，details 不重复 command、pattern、原始 content 等调用输入。
- UI 将来可以只根据 `agent/tool-call` 与 `agent/tool-result` 完成默认展示；专用 renderer 属于 UI。

## 共享输出限制

第一版不允许无界输出：

- Bash、Read 和 Glob 文本最大展示 2,000 行及 50 KiB UTF-8；
- Bash 从尾部保留，因为命令结尾通常包含最终状态和错误；
- Read 从请求 offset 开始向后保留；
- Glob 最多返回排序后的前 1,000 个匹配；
- 截断时 `content` 明确说明显示范围，details 保存 total/shown/truncated 事实。

共享截断实现保持为内部纯函数，不增加公开的通用 Result、service 或 class。

## Bash

参数：

```ts
{ command: string }
```

不增加每次调用的 `workdir` 或 timeout 参数。Bash 进程固定使用构造时的 Session cwd；Core
`AgentToolRegistry` 已提供 120 秒默认 timeout，并把合并后的 AbortSignal 传给 Tool，因此 Tool 不
重复建立第二套 timeout 机制。

Bash Tool 自身不包含危险命令分类。`sudo`、删除、chmod 等 allow/ask/deny 规则全部属于后续
Permission。当前 `bash-policy.ts` 和旧 Permission listener 的清理由 Permission 计划处理。

关键分支：

```text
启动进程
├─ cwd 不存在 / shell 无法启动
│  └─ 失败结果
├─ signal 中止
│  └─ 杀死进程树并产生失败结果
└─ 进程结束
   ├─ exit code = 0
   │  └─ 成功结果
   └─ exit code != 0 或 null
      └─ 保留 stdout/stderr，失败结果

合并输出
├─ 空输出
│  └─ "(no output)"
├─ 未超限
│  └─ 完整输出
└─ 超限
   └─ 保留尾部并报告截断事实
```

stdout 和 stderr 进入同一按到达顺序追加的缓冲区，不采用“全部 stdout 后再全部 stderr”的错误顺序。

details 保存 exit code、是否截断、总行数/字节数和展示行数/字节数。

本地 Bash 执行后端用一个函数类型注入，以便单元测试稳定模拟 exit code、输出和 abort，也保留未来
SSH/container adapter 的可能性；不为单一函数增加 operations class 或 backend interface。

## read_file

参数：

```ts
{
  path: string;
  offset?: number; // 1-based，默认 1
  limit?: number;  // 默认 2000，最小 1，最大 2000
}
```

关键分支：

```text
目标类型
├─ 普通文件
│  ├─ offset 超过末行 → 成功返回空范围说明
│  ├─ 范围或字节超限 → 返回选中内容和截断说明
│  └─ 未超限 → 返回选中内容
├─ 目录
│  ├─ 无条目 → 返回空目录说明
│  ├─ offset 超过末项 → 成功返回空范围说明
│  └─ 排序、分页并标记是否还有条目
└─ 其他文件类型或读取失败
   └─ 失败结果
```

目录只列直接子项；目录名称以 `/` 结尾，先按名称确定性排序，不递归，并同时遵守 50 KiB 输出上限。
details 保存规范绝对路径、`file | directory`、offset、返回数量、总数量和 truncated。

## write_file

参数：

```ts
{ path: string; content: string }
```

Tool 写入完整内容，缺失的父目录递归创建。已有文件被完整覆盖，新文件被创建。details 保存规范绝对
路径、UTF-8 字节数和 `created`；模型可见 content 明确区分 created/overwritten。

整个流程没有业务分支需要额外描述；文件系统失败由 Tool 形成失败结果或由 Registry 归一化。

## edit_file

参数：

```ts
{ path: string; old_text: string; new_text: string }
```

关键分支：

```text
old_text 匹配次数
├─ 0
│  └─ 不写文件，失败结果
├─ 1
│  └─ 精确替换并成功
└─ > 1
   └─ 不写文件，失败结果；要求调用者提供更长上下文
```

`old_text` schema 要求至少一个字符，避免空字符串在每个位置匹配。Tool 不做模糊匹配、不自动修复
缩进、不静默选择第一次匹配。details 保存规范绝对路径和 replacement count `1`。

## glob

参数：

```ts
{ pattern: string }
```

使用 Node.js 24 `fs.promises.glob()`，cwd 固定为构造时的 Session cwd。匹配结果转换为 `/` 分隔的
cwd-relative 路径，按代码点顺序确定性排序并去重，同时受 1,000 项和 50 KiB 两个上限约束。

关键分支：

```text
匹配结果
├─ 0 → "(no matches)"
├─ 1..1000 → 返回全部排序结果
└─ >1000 → 返回前 1000 个并说明截断
```

details 保存总匹配数、返回数和 truncated，不复制完整 matches。

## todo_write

参数是完整列表：

```ts
{
  todos: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
  }>;
}
```

每次调用完整替换上一份逻辑列表；Tool 实例不保存状态。Tool 把输入映射为新的 plain objects，返回
完整模型可见列表，并在 details 保存 `{ todos }`。Session 已持久化整个 Tool Result，因此恢复
Session 时不需要 Tool 内部状态。

空列表是合法的，表示清空任务。列表最多 50 项，每项 content 为 1 至 200 个字符；该格式上限保证
完整 Todo 列表无需截断即可同时进入模型 content 和 Session details。Tool 不擅自 trim 或改写用户
文本；不强制最多一个 `in_progress`，因为该约束属于 agent guideline，不是数据格式不变量。

## Registry 工厂

唯一工厂入口：

```ts
createBuiltinToolRegistry(cwd: string): AgentToolRegistry;
```

它创建新的 Registry，并按固定顺序注册六个新的 Tool 实例：

```text
bash, read_file, write_file, edit_file, glob, todo_write
```

每次调用返回独立 Registry 和独立 Tool 实例。工厂不接收 Project、Events、Permission、UI 或
presentation registry，也不提供 `createBuiltinToolDefinitions()` 与 `createAgentToolRegistry()` 两级
API。

插件系统以后可以在返回的标准 `AgentToolRegistry` 上继续注册 Tool，不需要适配 coding-agent 私有
Tool 类型。

## 代码组织

```text
src/coding-agent/tools/
├── factory.ts
├── resolve-path.ts
├── output.ts
└── builtin/
    ├── bash/
    │   ├── bash.ts
    │   └── bash-policy.ts  # 暂由旧 Permission 使用；后续 Permission 计划迁移/删除
    ├── read-file.ts
    ├── write-file.ts
    ├── edit-file.ts
    ├── glob.ts
    └── todo.ts
```

删除：

- `src/coding-agent/tools/definition.ts`；
- `src/coding-agent/tools/builtin/files.ts`；
- adapter 与 presentation 字段；
- 对应旧测试。

本阶段不修改：

- `src/coding-agent/events/`；
- `src/coding-agent/project/`；
- `src/coding-agent/ui/`；
- 旧 outer coding-agent factory、入口导出和 README；
- Core Agent、Events、Harness 或 Session。

这些外围调用者会在后续分阶段设计中迁移。Tools 通过隔离 TypeScript 编译和 `node:test` 验证，不能
为了让旧外围代码继续编译而保留兼容 adapter。

## 验收标准

1. 六个 built-in 都是标准 Core `AgentTool`。
2. `tools/` 不导入 UI、Events、Permission 或 Project。
3. 不存在 coding-agent 私有 ToolDefinition/adapter。
4. Tool 只接收真正需要的数据；没有 ToolExecutionContext 或 Permission request 实体。
5. 文件 Tool 不执行 Project 边界判断。
6. Bash Tool 不执行危险命令策略。
7. 所有输出有确定上限和明确截断说明。
8. 所有 details JSON-safe，并包含未来默认 UI 展示需要的事实。
9. Edit 对 0、1、多个匹配分别有明确行为。
10. Glob 输出确定排序并限制结果数量。
11. Todo 无状态，完整结果同时进入 content 和 details。
12. Registry 工厂每次返回独立、顺序稳定的六 Tool Registry。
13. 不把 built-ins 接入 Project；Permission 完成前产品路径仍不暴露这些 Tool。
14. 不增加依赖。
