# Project 目录与 Session 格式设计

本文档取代
`2026-08-13-project-session-repository-design.md` 中的 `CodingProject`、Session 当前格式、延迟创建
文件和只返回 Session ID 的列表设计。该文档中关于 Harness 与 Coding Agent 职责的其余决定继续
有效。

## 目标

Kea 需要把项目、目录和会话区分开：

- `Project` 表示一个稳定的逻辑项目；
- 一个 Project 可以包含多个源目录，并指定其中一个主目录；
- 一个 Project 可以拥有多个 Session；
- 一个 Session 选择一个 Project 目录，并在该目录或其子目录中运行。

当前命令行只会为 Project 添加一个目录，但公共数据结构从一开始支持多个目录。当前不增加
`Workspace`，因为它与 Project 目录没有独立的行为差异。

## Project

Project 保存：

```ts
interface Project {
  readonly id: string;
  readonly name: string;
  readonly directories: readonly string[];
  readonly primaryDirectory: string;
}
```

- `id` 是稳定身份，不随名称或主目录改变；
- `name` 是可修改的显示名称；
- `directories` 是 Project 可以访问的源目录，均为规范化绝对路径；
- `primaryDirectory` 是新 Session 默认使用的目录，必须是 `directories` 的成员。

`directories` 不得为空，也不得包含经过路径规范化后重复的目录。目录允许互相包含；启动位置
同时位于多个 Project 目录中时，Session 绑定路径最长、也就是最具体的目录。

当前首次打开 Project 时：

```text
directories = [projectRoot]
primaryDirectory = projectRoot
```

未来增加目录或切换主目录只修改 Project。切换 `primaryDirectory` 只影响之后创建的 Session，
不会重写已有 Session。

### Project 持久化

Project 的可变信息保存在自己的存储目录中：

```text
<keaHome>/projects/<projectId>/project.json
<keaHome>/projects/<projectId>/sessions/*.jsonl
```

`project.json` 的最小格式为：

```json
{
  "version": 1,
  "id": "project_123",
  "name": "research",
  "directories": [
    "D:\\projects\\research",
    "D:\\documents\\research-notes"
  ],
  "primaryDirectory": "D:\\projects\\research",
  "createdAt": "2026-08-13T11:00:00.000Z",
  "updatedAt": "2026-08-13T12:00:00.000Z"
}
```

Project ID 在首次创建时生成，不能从名称或当前主目录动态计算。这样重命名 Project、移动主目录
角色或添加其他目录都不会改变 Session 的归属。修改 Project 时使用临时文件加原子替换写入完整
JSON；Project 配置不采用 JSONL，因为它是一份很小的当前状态，而不是需要保留分支的历史日志。

当前无需增加公开的 `ProjectRepository`。coding-agent 的 Project 工厂负责读取、验证和保存
`project.json`，以后真正出现多种 Project 存储实现时再提取 Repository。

## Project 根目录发现

当前不引入 `kea.json` 或其他 Kea 专属标记文件。启动时按以下规则确定首次加入 Project 的目录：

1. 规范化用户显式传入的路径；未传入时使用进程 `cwd`；
2. 如果起始路径位于某个已登记 Project 目录中，打开该 Project；
3. 尚无匹配 Project 且用户显式传入路径时，使用该路径创建 Project；
4. 尚无匹配 Project 且未显式传入路径时，查找所属 Git 工作树的根目录；
5. 当前目录不属于 Git 工作树时，使用进程 `cwd` 创建 Project。

Git 只参与目录发现。Project、Session、Tool 和 Harness 不区分 Git Project 与非 Git Project，
非 Git 目录也拥有独立的 Project 和 SessionRepository。

当传入路径或 `cwd` 位于一个已登记 Project 目录的子目录中时，优先打开该 Project，并把实际
启动位置作为新 Session 的 `cwd`。根目录发现集中在 coding-agent 的 Project 工厂中；Harness
与 Session 不自行搜索 Git。

为了从任意已登记目录重新找到 Project，工厂扫描 `<keaHome>/projects/*/project.json` 中的目录
归属。当前 Project 数量很小时这种实现足够简单；如果以后扫描成为性能问题，可以增加可重建的
目录索引，而不改变 Project 和 Session 格式。若同一个规范化目录登记在不同 Project 中，工厂
必须报错，不能任意选择；父子目录分别属于不同 Project 时，使用最具体的匹配。

## Session 归属

每个 Session 属于一个 Project，并选择该 Project 的一个目录：

```text
Project
  directories:
    D:\projects\research
    D:\documents\research-notes
  primaryDirectory:
    D:\projects\research

Session
  directory:
    D:\projects\research
  cwd:
    src
```

`directory` 是 Session 选择的 Project 目录。`cwd` 是相对于 `directory` 的路径；空字符串或
`.` 表示目录本身。恢复 Session 时，实际工作目录由二者组合得到：

```text
resolvedCwd = resolve(directory, cwd)
```

创建 Session 时：

- 从 Project 主目录打开时，`directory` 使用 `primaryDirectory`，`cwd` 为 `.`；
- 从某个 Project 目录的子目录打开时，`directory` 使用包含它的目录，`cwd` 保存相对路径；
- 显式选择其他 Project 目录时，Session 绑定该目录；
- `cwd` 解析后必须位于 `directory` 内。

Project 的全部 `directories` 构成 Project 内部目录范围，工具默认从 Session 的实际工作目录
执行。Session 的 `directory` 用于确定默认目录归属，不会因为 Project 后来切换主目录而改变。

如果 Session 绑定的目录已从 Project 删除，或者磁盘目录已经不存在，打开 Session 必须返回明确
错误。Kea 不得静默改用新的主目录。未来可以由 UI 引导用户重新绑定，但本次不设计该交互。

## Session 文件

Session 继续使用一份追加写入的 JSONL 文件。新版文件由三类记录组成：

1. 第一行且仅第一行是 Session 头；
2. 对话树记录保存消息和模型变化；
3. Session 级记录保存标题等不属于对话分支的变化。

### Session 头

```json
{
  "type": "session",
  "version": 1,
  "id": "session_123",
  "projectId": "project_123",
  "title": "unknown",
  "directory": "D:\\projects\\research",
  "cwd": "src",
  "createdAt": "2026-08-13T12:00:00.000Z"
}
```

Session 头是不可变记录，不包含 `parentId`，也不参与对话树。`Session.create()` 立即写入 Session
头，使尚未产生 assistant 消息的 Session 也能被列举和恢复。

创建与打开接口相应调整为：

```ts
interface CreateSessionInput {
  readonly projectId: string;
  readonly directory: string;
  readonly cwd: string;
}

class SessionRepository {
  create(input: CreateSessionInput): Promise<Session>;
  open(sessionId: string): Promise<Session>;
  list(): Promise<readonly SessionInfo[]>;
}
```

Repository 的存储目录已经由当前 Project 提供，因此无需在每次 `open()` 中重复传入
`projectId`。coding-agent 在使用打开的 Session 前校验 Session 头与当前 Project 是否一致。

### 对话树记录

现有 `message` 和 `model_change` 继续使用 `id`、`parentId` 表示分支，并增加 `createdAt`：

```json
{"type":"message","id":"entry_1","parentId":null,"createdAt":"2026-08-13T12:01:00.000Z","message":{}}
{"type":"model_change","id":"entry_2","parentId":"entry_1","createdAt":"2026-08-13T12:02:00.000Z","provider":"openai","modelId":"gpt-5"}
```

只有对话树记录参与 `buildContext()`。Session 头和 Session 级记录不能成为 `parentId` 的目标。
尚未追加对话树记录的 Session 是合法空 Session；一旦出现树记录，它们必须组成一棵且仅一棵
有根树。

### 标题生成与标题记录

Session 创建时标题固定为 `"unknown"`。第一条真实用户消息成功写入 Session 后，Harness 在正式
Agent Run 开始前触发标题生成；标题生成与正式回答并行执行，不阻塞 Agent Run，也不等待首轮
assistant 回答完成。

标题生成只接收第一条真实用户消息，使用无 Tool 的独立模型请求。它不读取首轮 assistant 回答、
工具日志或完整 Session 历史。标题输出必须是非空单行文本，清理首尾空白后最长 100 个字符；
超过限制时截断为 97 个字符并追加 `...`。

生成成功后使用追加记录修改标题：

```json
{"type":"session_title","createdAt":"2026-08-13T12:01:05.000Z","title":"重构 Agent 事件机制"}
```

标题记录属于整个 Session，不包含树节点的 `id` 和 `parentId`。当前标题取文件中最后一条
`session_title`；不存在标题记录时使用 Session 头中的 `"unknown"`。

自动标题只允许在当前标题仍为 `"unknown"` 时写入一次。标题生成期间如果用户手动设置标题，
后台生成结果必须丢弃，不能覆盖用户标题。标题请求失败、超时或返回空内容时，保留
`"unknown"`；这些错误可以记入诊断日志，但不能让正式 Agent Run 失败，也不能追加失败记录污染
对话树。后续用户消息不会自动重新生成标题。

## Session 信息与排序

Repository 列举 Session 时返回元数据，而不是只有 ID：

```ts
interface SessionInfo {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly directory: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

- `createdAt` 来自 Session 头；
- `updatedAt` 是文件中最后一条有效记录的 `createdAt`；
- 只有 Session 头时，`updatedAt` 等于 `createdAt`；
- `SessionRepository.list()` 按 `updatedAt` 降序返回 `SessionInfo[]`；
- `continueRecent()` 使用第一项的 `id`，不再依赖文件系统 mtime。

所有时间使用 UTC ISO 8601 字符串。每次成功追加记录后，该记录的 `createdAt` 自然成为新的
`updatedAt`，不需要回写 Session 头。

## 包边界

Project 属于 coding-agent 层，因为只有 coding-agent 理解源目录、项目发现和代码工具边界。
Session 与 SessionRepository 仍属于 Harness 层，它们只持久化调用者提供的 Project ID、目录和
cwd，不负责发现或修改 Project。

数据流为：

1. coding-agent 根据启动位置打开或创建 Project；
2. coding-agent 选择 Project 目录和相对 cwd；
3. SessionRepository 使用这些值创建 Session；
4. coding-agent 根据 Session 的实际 cwd 组装 Harness、Tools 和 Hooks；
5. Harness 驱动 Session，并将新记录追加到 JSONL。

标题生成是 Harness 管理的 Session 辅助任务，不属于 Agent Hook、Tool 或 Agent Run。Harness 只
依赖一个可选的标题生成函数，并负责触发时序、并发和不覆盖现有标题；coding-agent 负责选择模型、
构造标题提示和组装该函数。没有配置标题生成函数时，Session 保持 `"unknown"`，Harness 的其他
行为不受影响。

## 错误规则

- Session 头缺失、不是第一行、重复出现或版本不支持时，返回 `invalid_session`；
- Session 头中的 ID 必须与文件名 ID 一致；
- `projectId` 不匹配当前 Project 时拒绝打开；
- `directory` 不属于 Project 时拒绝打开；
- `cwd` 是绝对路径、逃出 `directory` 或解析后不存在时拒绝打开；
- 任意记录缺少合法 `createdAt` 时返回 `invalid_entry`；
- Session 头标题必须是非空字符串；自动标题写入前必须再次确认当前标题仍为 `"unknown"`；
- 追加失败时，内存状态和 `updatedAt` 一并回滚。

## 破坏性升级

本次采用破坏性升级。旧 JSONL 没有 Session 头、Project 归属、目录和记录时间，新版代码不读取
旧格式，也不保留兼容分支或自动推断。现有开发期 Session 可以删除；如果以后需要保留真实用户
数据，应在发布前另行提供一次性迁移工具。

## 验收条件

1. Project 数据结构支持多个目录，并保证目录不重复、主目录唯一。
2. Project 使用稳定 ID 和独立 `project.json`，重命名或切换主目录不改变 ID。
3. 当前 CLI 创建的 Project 只有发现到的根目录，且该目录为主目录。
4. 从任意已登记目录的子目录启动都能找到原 Project。
5. Git 只影响根目录发现；非 Git 目录拥有独立 Project。
6. 从 Project 子目录创建 Session 时，Session 保存对应目录和相对 cwd。
7. 切换 Project 主目录不会改变已有 Session 的工作位置。
8. Session 文件第一行是合法且不可变的 Session 头。
9. 新 Session 创建后立即出现在 Repository 列表中。
10. `SessionInfo` 提供非空 title、createdAt 和 updatedAt，列表按 updatedAt 排序。
11. 新 Session 的 title 是 `"unknown"`，修改标题使用追加记录，不回写 Session 头。
12. 第一条真实用户消息写入后，标题生成与首轮 Agent Run 并行且互不阻塞。
13. 自动标题只使用第一条用户消息；失败时保留 `"unknown"`，不得影响 Agent Run。
14. 自动标题不得覆盖用户标题，也不得在后续轮次重复生成。
15. 打开目录失效或归属不匹配的 Session 时明确失败，不自动改绑。
16. 旧 Session 文件被明确拒绝。
17. Harness、Tools 和 Hooks 不感知 Git，也不负责 Project 发现。
