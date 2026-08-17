# Coding Agent Project 基础设计

## 目标

重新设计 `coding-agent` 的 Project 基础，使整个包拥有一个清晰的核心概念，并建立后续设计
内建 Tools、coding Events 和 Permission 的稳定落点。

本设计只处理 Project、Session 入口与 Harness 组装。UI、Tool 展示和 Permission 交互不在本次
范围内；不能用临时 UI 接口反向塑造 Project。

## 核心概念

`Project` 是 `coding-agent` 的核心概念，也是当前进程中一个已打开代码项目的聚合根：

- 它对应磁盘上一份具有稳定 ID 的 Project 数据；
- 它拥有这个 Project 的 SessionRepository；
- 它为新建或显式选择的 Session 组装 AgentHarness；
- 它拥有该 Project 内所有 Harness 共用的 Events；
- 它不保存当前 Session 或当前 Harness。

`coding-agent` 是包和领域名称，不增加同名的 `CodingAgent` 类。当前没有独立行为能够证明
`CodingAgent` 与 `Project` 两个运行实体同时存在的必要性。

## Project 数据

第一版 Project 只管理一个根目录：

```ts
interface ProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly directory: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

- `id` 在首次创建时随机生成，之后保持稳定；
- `name` 首次取根目录名称；
- `directory` 是规范化绝对路径，也是内建文件能力的 Project 边界；
- 所有时间使用 UTC ISO 8601 字符串。

删除 `directories` 和 `primaryDirectory`。当前没有一个 Project 同时管理多个不相关源目录的真实
需求；worktree、sandbox 或多根目录以后应作为各自经过证明的概念设计，而不是预先扩张 Project。

Project 数据保存在：

```text
<keaHome>/projects/<projectId>/project.json
<keaHome>/projects/<projectId>/sessions/*.jsonl
```

`project.json` 是一份小型当前状态，使用完整 JSON，而不是 JSONL。Project 数据写入采用同目录临时
文件和原子替换。Project 存储是 `coding-agent` 的内部实现，不导出 `persistProject()`、
`applyProjectUpdate()`、目录所有权检查或 ProjectRepository 接口。

## Project 发现与创建

公开入口为：

```ts
interface OpenOrCreateProjectConfig {
  readonly keaHome: string;
  readonly cwd?: string;
  readonly runtime: ModelRuntime;
  readonly modelConfig: ModelConfig;
}

function openOrCreateProject(config: OpenOrCreateProjectConfig): Promise<Project>;
```

`cwd` 是应用的启动位置，省略时使用 `process.cwd()`。配置中不接受 `directory`：Project directory
不是调用者提供的第二个位置，而是根据 `cwd` 解析出的结果。这样不存在 `cwd` 与 `directory` 冲突、
优先级或包含关系等额外规则。

首先把 `cwd` 解析为 Project directory：

1. 将 `cwd` 解析为绝对路径，验证路径存在且是目录，并取得其规范路径；
2. 以该目录执行等价于 `git rev-parse --show-toplevel` 的 Git 根目录发现；
3. 如果位于 Git work-tree 中，Project directory 是规范化后的 work-tree 根；
4. 如果不位于 Git work-tree 中，Project directory 就是规范化后的 `cwd`。

不要通过手工寻找 `.git` 目录实现第 2 步，因为 Git worktree 的 `.git` 可以是文件。明确的“不是 Git
仓库”结果进入第 4 步；Git 进程无法启动或目录解析发生其他错误时明确失败，避免同一个仓库因环境
异常被错误登记成另一个非 Git Project。

得到 Project directory 后，再选择或创建 Project：

1. 扫描 `<keaHome>/projects/*/project.json`；
2. 按规范化后的 `ProjectInfo.directory` 与 Project directory 精确相等查找；
3. 恰好一个匹配时，读取并返回该 Project；
4. 没有匹配时，为该 Project directory 创建 Project，生成并立即持久化稳定 ID；
5. 多个匹配时说明持久化数据违反唯一性约束，明确失败。

因此，在一个 `keaHome` 中，规范化后的 Project directory 唯一确定一个 Project。这里没有“启动位置
位于某个已登记目录下就复用”的包含匹配，也没有最长路径选择：Git 子目录通过解析到同一 work-tree
根而复用 Project；非 Git 目录则只有从同一个 `cwd` 启动才会复用 Project。

Git 只参与 Project directory 解析。Project、Session、Harness 和 Tools 不区分 Git 与非 Git
Project。

不存在 Projects 目录是正常的首次启动。其他读取错误、损坏的 Project 文件和重复目录归属必须明确
失败，不能被当作“没有 Project”后再创建重复记录。

## Project 运行对象

`Project` 是类，而不是由对象字面量和闭包拼出的接口实现。类保存 ProjectInfo、SessionRepository、
ModelRuntime、默认模型和 Events；`info` getter 返回 ProjectInfo 快照，不把持久字段复制为另一份
公开状态。

第一版公开行为为：

```ts
class Project {
  readonly events: Events;

  get info(): ProjectInfo;

  listSessions(): Promise<readonly SessionMetadata[]>;

  createHarness(options?: {
    readonly cwd?: string;
  }): Promise<AgentHarness>;

  createHarnessFromSession(
    sessionId: string,
  ): Promise<AgentHarness>;
}
```

不增加 `createSession()` 或 `openSession()`：这些名称会让调用者误以为返回 Session，而公开结果实际
是 AgentHarness。也不增加 `continueRecent()`，因为每次应用启动必须创建新 Session，不能隐式恢复
最近历史。

`listSessions()` 只读取元数据。历史 Session 必须由调用者明确选择，再交给
`createHarnessFromSession(sessionId)`。`fork`、`delete` 和 Project 更新等行为等到出现真实调用者时
再加入 Project。

## Session 与 cwd

Core Session 保持当前格式，不增加 `projectId`、Project directory 或相对 cwd。Project 对 Session
的归属由该 Project 专属的 SessionRepository 存储目录表达；Session metadata 继续保存解析后的
绝对 `cwd`。

启动 `cwd` 与 Project directory 是两个不同结果，而不是两个入口参数：前者是用户实际启动和首个
Session 工作的位置，后者是由前者解析出的 Project 身份和文件边界。例如从
`/repo/packages/app` 启动且 `/repo` 是 Git work-tree 根时，`ProjectInfo.directory` 为 `/repo`，
新 Session 的 `cwd` 仍为 `/repo/packages/app`。

`createHarness({ cwd })` 的 cwd：

- 省略时使用 `project.info.directory`；
- 相对路径从 Project directory 解析；
- 绝对路径直接规范化；
- 最终路径必须存在、是目录，并位于 Project directory 内。

`createHarnessFromSession(id)` 打开已有 Session 后，同样验证 Session cwd 仍存在且没有逃出 Project
directory。无效 Session 明确失败，不能自动改到 Project 根目录，也不能创建替代 Session。

## Harness 组装

Project 使用一个内部函数完成两条公开路径共同的 Harness 组装：

```text
createHarness()
→ SessionRepository.create({ cwd })
→ buildHarness(session)
→ AgentHarness

createHarnessFromSession(id)
→ SessionRepository.open(id)
→ validate session cwd
→ buildHarness(session)
→ AgentHarness
```

`buildHarness(session)`：

1. 根据 Project directory 和 Session cwd 创建新的 AgentToolRegistry；
2. 安装后续 Coding Tools 设计确定的内建 Tools；
3. 使用 Project 共享的 Events；
4. 根据 Session cwd 生成 coding system prompt；
5. 将 Session、ModelRuntime、默认模型、Tool Registry、system prompt 和 Events 交给 AgentHarness。

每个 Harness 拥有独立的 Session、Tool Registry、模型选择和运行状态。Project 不缓存 Harness，
也不定义“当前 Harness”。

具体 Tool 集合、Tool 结构和 coding event listener 属于后续设计。本设计只确定它们在 Project 创建
Harness 时组装，不能因此预先增加 ToolDefinition、Adapter 或 Registry 的第二套抽象。

## Events 边界

一个 Project 创建一个 Events，并把同一个实例交给该 Project 创建的全部 Harness。Events 是 Agent、
Harness、Tools 和 coding 行为共用的运行机制，不是 UI 接口。

Project 不增加自己的事件分发器。后续 Coding Events 继续通过现有 EventMap 扩充和 Events listener
表达；是否存在 UI listener 不改变 Project 或 Harness 的行为边界。

## UI 与 Permission

本设计不定义 UI：

- Project 不导入 `src/ui`；
- Project 不渲染 Tool Call 或 Tool Result；
- 不存在 `Project.renderTool()`；
- 不存在 CodingToolPresentationRegistry；
- 不定义 CLI、TUI、WebUI 或 GUI 类型；
- 不向 Project 注入 `confirmPermission`、Interactions、Notification 或 NO_INTERACTIONS。

Bash permission 中的 `allow / ask / deny` 分类可以作为纯领域规则继续存在，但 `ask` 如何取得决定是
独立的待设计问题。本设计不保留权宜 UI 回调，也不假设其长期替代方案。

## 启动数据流

应用启动固定执行：

```text
启动 cwd
→ 解析 Git work-tree 根；非 Git 则保留 cwd
→ 按 Project directory 精确打开或创建 Project
→ Project
→ project.createHarness({ cwd: startupCwd })
→ 新 Session
→ 新 AgentHarness
```

无论 Project 下是否存在历史 Session，启动都创建新 Session。列举和恢复历史只通过显式调用完成。

## 错误规则

- 启动 cwd 不存在或不是目录时失败；
- Git 根目录发现无法执行或发生“不是 Git 仓库”之外的错误时失败；
- Project 文件损坏、版本不支持或字段非法时失败；
- 同一规范化目录被多个 Project 登记时失败；
- Project 读取错误不能被解释为不存在；
- 新 Session cwd 逃出 Project directory 时失败；
- 已有 Session cwd 不存在或逃出 Project directory 时失败；
- SessionRepository 和 Harness 组装错误原样传播，不缓存半成品；
- 不通过隐式恢复、目录替换或创建新 Session 掩盖错误。

## 验收条件

1. 从未登记目录启动会创建只有一个 directory 的 Project，并立即持久化稳定 ID。
2. 同一 Git work-tree 内的不同启动 cwd 都解析到 work-tree 根并读取同一 Project ID。
3. 同一非 Git cwd 再次启动会读取同一 Project ID；不同非 Git cwd 不做父子目录包含匹配。
4. 每个规范化 Project directory 最多对应一个 Project；重复登记明确失败。
5. `OpenOrCreateProjectConfig` 只有 `cwd`，没有调用者指定 Project 根的 `directory`。
6. Git 与非 Git Project 的后续运行行为相同，Git 只影响 Project directory 解析。
7. 损坏的 Project 数据不会导致静默创建重复 Project。
8. 每次启动调用 `createHarness()` 都创建新的 Session ID，不恢复最近 Session。
9. 启动 Session 保留原始启动 cwd，而不是被改成 Git work-tree 根。
10. `listSessions()` 返回 Project SessionRepository 的 SessionMetadata。
11. `createHarnessFromSession(id)` 显式恢复所选 Session 并返回绑定它的 AgentHarness。
12. Project 没有 `continueRecent()`、`createSession()` 或 `openSession()`。
13. 每个 Harness 获得独立 Tool Registry 和运行状态，但共享 Project Events。
14. Project、Tools 和 Events 不依赖任何具体 UI，也不公开 Tool 渲染入口。
15. Project 配置中没有临时 Permission/UI callback。
16. Core Session、AgentHarness、Agent Loop 和 ModelRuntime 的现有边界保持不变。
