# Interaction Port 与事件控制重构笔记

**日期：** 2026-08-20
**状态：** 设计草案，未实现
**背景：** 稳固 coding-agent 设计。参考 pi 的新 harness，但不与 UI 捆绑。以下两个方向相互独立，**分开重构、分开测试、分开提交**。

---

## 方向 A：Interaction Port（编码层，留在 coding-agent）

### 问题

现状 `src/coding-agent/interaction/interactions.ts` 只有 `permission()`，被权限专属。任何工具想向用户要输入（选项 / 确认 / 文本）都没有通道。

### 目标

通用、**UI 独立**的交互端口：

```ts
export interface UserInteraction {
  select(title: string, options: readonly string[]): Promise<number | undefined>;
  confirm(message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
}
```

### 放置：coding-agent，不进 core

- 所有当前 / 近期消费者都在 coding-agent：权限 listener、builtin 工具。没有通用 `core/harness` 组件需要向用户提问。
- 放进 coding-agent 保持 `core/harness` 应用无关、不依赖 UI。pi 的 `ctx.ui` 也在 app 层，不放通用 agent harness。
- 若将来出现通用 core 组件确实需要提问，再把抽象接口上移，届时再做。
- 实现由 `main.ts` 注入（readline CLI / 未来 TUI / 测试 stub 各一份），`core` 与 `coding-agent` 都不 import UI。

### 消费方式

- **权限**是它的一种用法：危险命令 / 外部目录 → `confirm` 或 `select`，不再是专属 `permission()`。
- **工具**要交互：coding-agent 工具工厂创建工具时**闭包绑定**该端口（不进 core 的 `ToolExecutionContext`，core 不变）。

---

## 方向 B：事件系统（核心层）

### 问题

`intercept` 用**私有决策返回类型**（如 `tools/pre-execute` 的 `allow|deny`），导致"任意 listener"假抽象——返回类型被某一个具体 listener 的诉求绑死，一个事件下只能有那一种 listener。

### 目标：观察与控制分开

- **观察 `Events`**：`on/emit`，listener 返回 `void`，任意 listener，独立注册表。这是诚实的多 listener。
- **控制 `Hooks`**：**显式命名的封闭枚举**（`before_tool` / `transform_context` / `before_request` / …），每个是单一契约，不再伪装成"任意 listener"。

### 控制结果的统一原语（关键）

控制点不用 per-listener 私有决策类型，而用**统一可组合结果**：

- **变换**：handler 返回 `{ value? }`，值链式传递（多 handler 真组合）。
- **否决**：handler 返回 `{ block?: boolean; reason?: string; terminate?: boolean }`，首个 `block` 短路。
- **改参**：原地修改 `event.input`（可变对象），不进返回类型。

具体语义（deny / allow / retry）由 core 解释，**不进入 listener 的返回类型**——由此多 listener 真实成立，且不倒退到"一个点一个私有类型"。

---

## 两层关系

- 方向 A（coding-agent）只复用 core 的事件 / hook，不依赖 B 的实现细节。
- 方向 B 不关心交互端口放哪。
- 可独立实施：A 先通用化 `Interactions`；B 再重构事件为 观察 + 显式 hook。
