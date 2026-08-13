# Harness README 渐进式重写设计

## 目标读者

读者已经知道 Agent 会接收消息、调用模型和执行工具，但不了解 Harness、Session、Event Bus、Hook，也没有参与过项目设计讨论。

读完 README 后，读者应当能够：

- 说明 Harness 相比 Agent 多负责什么；
- 使用 `AgentHarness.prompt()` 和 `subscribe()`；
- 解释 Event、Event Bus、listener 和 unsubscribe；
- 根据一个事件判断它是运行事实还是控制入口；
- 解释 `runId` 和当前固定为 `main` 的 `lane`；
- 找到 Harness 的完整公共接口及其来源包。

## 内容顺序

README 采用渐进式结构：

1. 用最小概念模型说明 Harness 的职责及其不负责的内容。
2. 给出最小使用示例，让读者先看到入口和结果。
3. 跟踪一次 `prompt()`，建立运行、持久化和事件通知之间的联系。
4. 解释 Event Bus 的四个组成：Event、publish、subscribe/listener、unsubscribe。
5. 对比 Event 与 Hook，明确观察和控制的差异。
6. 在已有运行流程上增加 `runId`、`lane`、Session、模型切换、工具注册和 system prompt。
7. 最后提供完整公共导出和当前能力边界，作为查询手册。

## 写作规则

- 首次使用英文术语时立即给出中文含义和实际作用。
- 类型定义只在读者已经知道它解决什么问题后出现。
- 只使用当前代码已经实现的行为，不用未来设计解释当前 API。
- Event Bus 使用一条不超过六步的完整运行记录解释。
- Session 的磁盘校验和 JSONL 实现只保留一句概括；详细实现不属于 README 主线。
- 保留完整公共导出清单，避免可读性提高后丢失包接口全貌。
- 不使用架构图。

## 正确性依据

README 必须与 `src/harness/index.ts`、`agent-harness.ts`、`events/`、`session/`、`system-prompt.ts` 的当前代码一致。重写只修改文档，不修改代码、类型或运行行为。
