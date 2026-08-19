# Project：领域组装

`coding-agent` 的领域层。它把 `core` 的可复用概念（`SessionRepository`、`Events`、
`AgentToolRegistry`、`AgentHarness`、`ModelRuntime`）封装、管理，并新增 Coding Agent 能力：
Project 持久化、内置工具、权限策略、coding system prompt、Interactions 端口。

启动层（参数、配置、目录发现）见 [startup.md](./startup.md)。

## 从目录到 Project

目录发现属于启动层：`cli/project-directory.ts` 把启动目录解析为 Git worktree 根（或原目录）并
规范化，再把规范结果作为 `projectDirectory` 交给 `openOrCreateProject()`。本包不再运行 Git。

`openOrCreateProject()` 是本包唯一的组合根。它验证并接受一个绝对、规范化、已存在的规范目录，
然后按下面的顺序建立运行时：

1. 校验 `projectDirectory`：绝对路径、`resolve()` 后不变、`realpath()` 后不变、且是现存目录；
2. 在 `ProjectStorage` 中查找拥有该规范目录的 Project 记录；
3. 找不到记录时生成 UUID、目录名和 UTC 时间，创建新的 Project 记录；
4. 为该 Project 创建 `SessionRepository`、内存权限记录和共享 `Events`；
5. 返回组合完成的 `Project`。

```ts
function openOrCreateProject(options: {
  readonly keaHome: string;
  readonly projectDirectory: string;
  readonly runtime: ModelRuntime;
  readonly modelConfig: ModelConfig;
  readonly interactions: Interactions;
  readonly maxTurns: number;
  readonly toolTimeoutSeconds: number;
}): Promise<Project>;
```

`maxTurns` 和 `toolTimeoutSeconds` 是扁平的项目运行策略，直接传入，不嵌套配置对象。目录不可
访问、路径不规范、非规范路径或 Project 记录损坏时，函数抛出 `ProjectError`。

### Project 持久化

Project 记录位于：

```text
<keaHome>/projects/<projectId>/project.json
```

记录保存 `id`、`name`、规范化后的 `directory`、`createdAt` 和 `updatedAt`。同一目录只能匹配一
条 Project 记录；出现多个匹配项会被视为数据错误。Project 目录同时作为该 Project 的 Session
存储目录，Session 的具体格式由 `core/harness` 管理。

`ProjectStorage` 只处理 Project 记录。它不解析启动目录、不运行 Git、不创建 Session，也不构造
`Project`。这些步骤由 `openOrCreateProject()` 编排。

## Project、Session 与 Harness

`Project` 是一个 Project 的运行时聚合对象。它持有不可变的 `ProjectInfo`、Session Repository、
模型运行时、初始模型和私有 Events，并提供三项行为：

```ts
interface Project {
  readonly info: ProjectInfo;

  listSessions(): Promise<readonly SessionMetadata[]>;
  createHarness(options?: { readonly cwd?: string }): Promise<AgentHarness>;
  createHarnessFromSession(sessionId: string): Promise<AgentHarness>;
}
```

`createHarness()` 创建一份新 Session。相对 `cwd` 从 Project 目录解析；绝对 `cwd` 直接使用。
最终路径必须存在且是目录，规范路径随后写入 Session metadata。

`createHarnessFromSession()` 打开已有 Session，重新验证 metadata 中保存的 `cwd`，再为它创建
Harness。目录已被删除或不再是目录时恢复失败，不会悄悄回退到 Project 目录。

每次构造 Harness 都会：

1. 从 `session.metadata.cwd` 取得唯一的工作目录；
2. 创建一份新的内置 Tool Registry，所有路径型 Tool 都绑定该目录；
3. 用 Project 目录和 Session cwd 填充 system prompt；
4. 把 Project 的同一个私有 `Events` 实例交给 Harness。

### 生命周期

| 对象或状态 | 生命周期 | 说明 |
|---|---|---|
| Project 记录 | 持久化 | 由 `ProjectStorage` 保存，通过规范目录查找 |
| Session | 持久化 | 由 `SessionRepository` 创建和恢复 |
| `Project` 实例 | 一次 `openOrCreateProject()` | 组合运行时依赖，不提供保存、更新或删除 Project 的操作 |
| `Events` | Project 实例 | 同一 Project 实例创建的全部 Harness 共享，不对外公开 |
| `approved` 权限记录 | Project 实例 | 只存在于内存，重新打开 Project 后清空 |
| `AgentHarness` | 一次创建或恢复 | 绑定一份 Session |
| Tool Registry | Harness | 每个 Harness 都有独立的内置 Tool 实例 |
| system prompt | Harness | 构造 Harness 时根据 Project 目录和 Session cwd 生成 |

`Project.events` 是私有的；调用方通过 `harness.subscribe(listener)` 观察每个 Harness 的事件，
按 `sessionId` 过滤、幂等取消订阅。Tool Registry 不共享，因此每个 Harness 的工具始终绑定自己的
Session cwd。

## 一次完整的 Tool 调用

当模型在一次 Run 中请求 Tool 时，调用沿着下面的真实路径执行：

1. `AgentHarness` 从 Session 取得 cwd、历史和模型状态，进入 `core/harness` 的 Agent Loop；
2. Agent Loop 把 Tool Call 交给该 Harness 的 `AgentToolRegistry`；
3. Registry 完成 Tool lookup 和参数校验，然后通过共享 Events 触发 `tools/pre-execute`；
4. Coding Agent 注册的 Permission listener 根据 Tool、目标路径、Session cwd 和内存授权作出决定；
5. 需要用户决定时，listener 调用外部 `Interactions.permission()`；
6. 允许后 Registry 执行 Tool，Tool Result 写回 Session，并由 Agent Loop 交给下一轮模型请求。

因此权限不在具体 Tool 内实现。Tool 只负责把已验证的参数转换成文件系统或 shell 操作；Project
边界、已批准目录和用户交互集中在 Permission listener 中。

## Session cwd 与 system prompt

Session cwd 是一份 Session 执行文件操作和命令的基准目录。它可以是 Project 目录，也可以是其他
现存目录。相对 Tool 路径统一从这个 cwd 解析。

`system-prompt.ts` 保存模块级 `SYSTEM_PROMPT_TEMPLATE`。`createSystemPrompt()` 在构造 Harness
时填入：

- `projectDirectory`：Project 的规范根目录；
- `cwd`：当前 Session 的规范工作目录。

生成后的字符串直接传给 `AgentHarness`，不写入 Session 历史。恢复 Session 时会基于已保存的 cwd
重新生成。System prompt 只描述工作空间和通用工作原则；工具 schema 仍由 Tool Registry 提供。

## 内置 Tools

`createBuiltinToolRegistry(cwd)` 每次创建一个新的 `AgentToolRegistry`，并注册以下 Tools：

| Tool | 行为 |
|---|---|
| `bash` | 在 Session cwd 中运行 shell command；非零退出码产生错误结果 |
| `read_file` | 读取文本文件，或按稳定顺序列出目录；支持一基 `offset` 和 `limit` |
| `write_file` | 写入完整 UTF-8 内容，必要时创建父目录 |
| `edit_file` | 精确替换唯一出现的一段文本；缺失或出现多次时拒绝修改 |
| `glob` | 从 Session cwd 匹配、去重并稳定排序路径 |
| `todo_write` | 返回调用方提交的完整任务列表；Tool 本身不跨调用保存状态 |

`bash` 在非 Windows 平台使用 `bash -c`。Windows 优先使用 Git Bash，找不到时使用
`bash.exe -s`。stdout 和 stderr 按收到的顺序合并；结果保留输出尾部，因为命令的最终状态通常位于
末尾。

文件读取保留输出头部。通用文本输出最多保留 2,000 行和 50 KiB UTF-8 内容；截断时 Tool Result
附带原始与展示范围。`glob` 另有 1,000 个结果的上限。结构化指标放在 Tool Result 的 `details`
中，模型可见的说明放在 `content` 中。

路径解析函数只执行 `resolve(cwd, input)`，不检查目标是否位于 Project 内。这项分离使 Tool 不需要
知道 Project 或交互层；外部目录访问由执行前的 Permission listener 判断。

## Permission

`createBuiltinEvents()` 创建一个 `Events`，并在 `tools/pre-execute` 上注册默认 Permission
listener。它使用 Project 目录作为初始 trusted directory，并共享 `openOrCreateProject()` 创建的
`approved` 数组。`emit()` listener 错误由它内建的 `console.error` handler 输出，不被静默吞掉。

### 文件类 Tool

`read_file`、`write_file`、`edit_file` 和 `glob` 的目标位于 trusted directory 中时直接允许。
目标在 Project 外时，Permission 发送 `external-directory` 请求。用户选择 `always` 后，该目录在
当前 Project 实例的后续调用中被视为已批准目录。

`glob` 在第一个通配符之前截取静态路径前缀，用它判断访问目录。其他文件 Tool 使用目标文件的
父目录组织权限请求。

### Bash

Permission 先确认 Bash 的执行 cwd 是否受信任，再对 command 分类：

- hard deny：始终拒绝，例如 `sudo`、关机、格式化文件系统、原始 `dd` 输入、`/dev`
  重定向和强制递归删除根目录；
- ask：需要用户确认，例如文件删除、写入 `/etc` 或 `chmod 777`；
- allow：没有命中上述规则的 command 直接通过。

`always` 对 Bash 记录的是完整 command 与 cwd 的组合。同一 command 换到另一个 cwd 后需要重新
判断。Hard deny 不会被已记住的授权覆盖。

### 回复和失败

```ts
type PermissionReply =
  | { readonly kind: "once" }
  | { readonly kind: "always" }
  | { readonly kind: "deny"; readonly reason?: string };
```

- `once`：仅允许当前 Tool Call；
- `always`：先写入 Project 实例的内存授权，再允许当前 Tool Call；
- `deny`：返回错误 Tool Result，不执行 Tool。

`Interactions.permission()` 抛错时，Permission 默认拒绝并把错误信息作为原因。Run 已被取消时，
取消错误继续传播，不会被转换成普通拒绝。

## Interactions：外部交互端口

`Interactions` 是 Coding Agent 到外部决策者的最小端口：

```ts
interface Interactions {
  permission(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<PermissionReply>;
}
```

`PermissionRequest` 有两种：

- `dangerous-command`：包含 Session/Run 身份、原始 Tool Call、command、cwd 和原因；
- `external-directory`：包含 Session/Run 身份、原始 Tool Call、目标路径、申请目录和原因。

终端、桌面 UI 或其他调用方负责把 request 呈现给用户并返回 reply。请求 ID、窗口状态、队列或
传输协议属于 adapter 自己，不进入 `coding-agent`。本包没有默认 `Interactions`，避免在没有用户
确认渠道时静默放行。

## 错误边界

Project 发现、记录校验、Session cwd 校验中的失败使用 `ProjectError`。底层错误通过 `cause`
保留，消息说明失败发生在哪个目录或记录。

内置 Tool 的普通执行失败通常转换成 `isError: true` 的 Tool Result，让模型能够读取失败原因并决定
下一步。参数 lookup、超时、Tool listener 和 Agent Run 的通用规则由 `core/harness` 负责。

Permission 使用的 `intercept()` 错误遵循 core Events 的传播规则。
