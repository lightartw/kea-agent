# Kea Agent 协作日志

## 记录说明

本日志按时间记录可由仓库核验的关键节点。2026-08-16 之前未保存完整聊天导出，
因此早期的 prompt/context 字段是对已提交 spec、plan 与 commit 的摘要，不是
逐字 prompt。无法验证的 subagent 身份、对话原句和人工操作不会补写。

Task 编号对应根目录 `PLAN.md`。

## 2026-08-13

### 2026-08-13 01:44-02:12 +08:00｜Task 3/5｜Hook、Harness 与 Tool UI 边界

- **Superpowers 技能证据：** brainstorming 设计文档与 writing-plans 实施计划。
- **Prompt/context 摘要：** 区分控制 Hook、事实 Event、Harness UI 与 Tool
  presentation；拒绝让展示异常改变工具执行结果。
- **Agent 产物：** `docs/superpowers/specs/2026-08-13-hook-harness-tool-ui-design.md`，
  commits `35f511a`、`d59b4f4`、`02b6362`。
- **人工干预：** 对初稿进行边界评审，要求被拒绝、参数无效和未知工具也产生
  完整且可持久化的 Tool Result。
- **教训：** “控制行为”和“观察事实”不能因为都需要回调就共用含混语义。

### 2026-08-13 12:08-12:40 +08:00｜Task 3/5｜第一轮边界实现

- **Superpowers 技能证据：** 计划内的 TDD、两阶段检查与小步 commit。
- **Prompt/context 摘要：** 依次实现 Hook contract、结构化 Tool Result、
  完整生命周期、Session 派生 Todo 和 UI renderer 分离。
- **Agent 产物：** commits `1acbf19`、`a6c2fac`、`7a2884a`、
  `34fcca7`、`86700b7`、`db777fb`。
- **人工干预：** 将工具状态归属改为 Session 历史，避免工具实例持有不可恢复
  的隐式状态。
- **教训：** 可恢复状态应有唯一持久化来源，UI 不应成为第二份状态。

### 2026-08-13 14:08-15:57 +08:00｜Task 3/5｜分层事件与 Coding Agent 组装

- **Superpowers 技能证据：** 三次设计修订后进入 writing-plans。
- **Prompt/context 摘要：** 明确 `agent`、`harness`、`coding-agent`、
  `ui` 的事件所有权和依赖方向。
- **Agent 产物：** design commits `05ebd79`、`bb76cb7`、
  `4802c14`、`5a1ddc1`；plan `bd62fae`；implementation
  `8cb64de` 至 `3e7fff9`。
- **人工干预：** 把 Harness 移出 Coding Agent 子目录，要求通用层不依赖具体
  coding 工具和 UI。
- **教训：** 包目录结构应反映所有权，否则类型正确也会持续诱发反向依赖。

### 2026-08-13 16:40-19:44 +08:00｜Task 5｜README 与 Coding Agent 简化

- **Superpowers 技能证据：** brainstorming、writing-plans、文档与实现复核。
- **Prompt/context 摘要：** 用渐进式说明替换 API 罗列；合并无状态工具，收窄
  interactions 与 presentation seam。
- **Agent 产物：** commits `543b369` 至 `d040c2e`。
- **人工干预：** 反复删减不必要公开类型，保留只读 presentation API。
- **教训：** 文档难以解释通常说明模块边界仍然过宽。

### 2026-08-13 20:20-2026-08-14 00:36 +08:00｜Task 4｜Project 与 Session 生命周期

- **Superpowers 技能证据：** Project/Session 两轮设计、计划和回归测试。
- **Prompt/context 摘要：** 一个 Project 共享 Events，但每个 Session 拥有独立
  Harness、cwd、消息树和模型状态；损坏存储必须显式报错。
- **Agent 产物：** commits `8014869` 至 `7522f16`。
- **人工干预：** 要求切换 primary directory 不改写旧 Session；要求最近 Session
  损坏时不能静默创建新会话掩盖错误。
- **教训：** “恢复最近会话”首先是数据完整性行为，不只是便利功能。

## 2026-08-14

### 2026-08-14 01:40-02:53 +08:00｜Task 3｜统一事件系统

- **Superpowers 技能证据：** brainstorming、writing-plans、TDD。
- **Prompt/context 摘要：** 统一 runtime dispatcher，替换 Agent Hooks，
  明确事实发布和消息持久化顺序。
- **Agent 产物：** commits `f77cbf7`、`7b96b7a`、`9fd832c`、
  `a3890e6` 至 `536ec34`。
- **人工干预：** 要求同一个 Project 的多个 Session 共用一个事件源，但 UI
  必须按 sessionId 过滤。
- **教训：** 事件总线是否“全局”必须带上生命周期范围；Project 级共享不等于
  进程级单例。

### 2026-08-14 12:29-16:03 +08:00｜Task 3｜Events hardening

- **Superpowers 技能证据：** systematic review、TDD、verification-before-completion。
- **Prompt/context 摘要：** 压测 listener 快照、重复注册、异常隔离、流终止块、
  readonly 消息和 abort/error 竞态。
- **Agent 产物：** commits `9c765f7` 至 `43001e8`。
- **人工干预：** 删除语义重叠的 `ask/transform`，最终只保留
  `emit/intercept`。
- **教训：** API 数量减少只有在错误、取消和所有权规则更清楚时才是真正简化。

### 2026-08-14 21:14-21:26 +08:00｜Task 1-7｜课程 release 设计与计划

- **Superpowers 技能证据：** brainstorming 产出
  `2026-08-14-course-release-design.md`；writing-plans 拆成四份实施计划。
- **Prompt/context 摘要：** 将库产品化为 `kea` CLI，选择本地优先、JSON 配置、
  compact UI、确定性机制演示和宿主平台 SEA 构建。
- **Agent 产物：** commits `4a70a2c`、`b8d390e`。
- **人工干预：** 明确非目标为 WebUI、部署、GitHub Release、MCP、向量记忆和
  全屏 TUI。
- **教训：** 截止期设计需要先确定最有评分证据的工程闭环，再限制产品表面积。

### 2026-08-14 21:35-21:56 +08:00｜Task 1/2｜配置、provider 与 CLI

- **Superpowers 技能证据：** 实施计划中的 RED-GREEN-REFACTOR 步骤。
- **Prompt/context 摘要：** 分层 JSON 配置，凭据只从用户级 auth 读取，
  CLI 初始化不得覆盖文件，provider 工厂不依赖 dotenv。
- **Agent 产物：** commits `9133928`、`1a499b3`、`533e6f0`、
  `ed25705`、`c837312`、`3b6a3a6`。
- **人工干预：** 收窄 provider credential 类型，避免错误信息回显 key。
- **教训：** 凭据隔离既是存储问题，也是类型、配置优先级与诊断问题。

### 2026-08-14 22:01-22:15 +08:00｜Task 3/4/6｜治理、反馈、记忆与演示

- **Superpowers 技能证据：** TDD；mock LLM 确定性验收。
- **Prompt/context 摘要：** 增加 maxTurns/maxToolCalls、verify、项目记忆，并
  组合为四个离线演示场景。
- **Agent 产物：** commits `027a310`、`523db67`、`5ff1c47`、
  `63c673f`、`b29dfeb`。
- **人工干预：** 要求超限工具调用仍得到错误 Tool Result，使模型能够观察到
  拒绝；记忆只按需检索，不全量注入。
- **教训：** 客观反馈必须通过正常消息路径回灌，不能靠隐藏 side channel。

### 2026-08-14 22:20-22:32 +08:00｜Task 5｜终端交互

- **Superpowers 技能证据：** TDD、presentation 层质量复核。
- **Prompt/context 摘要：** compact 模式、语义工具摘要、Todo 进度、权限卡片、
  停止摘要和 ESC 取消。
- **Agent 产物：** commits `5393915`、`5ff8a3a`、`40c299b`、
  `77e8f62`、`8aa96c4`。
- **人工干预：** 权限确认保持 fail-closed；展示失败只能 notify，不能改变工具
  结果。
- **教训：** UI 的责任是降低认知负担，不是重新解释或覆盖核心状态。

### 2026-08-14 22:38-23:30 +08:00｜Task 7｜打包、卫生与验收

- **Superpowers 技能证据：** TDD、verification-before-completion。
- **Prompt/context 摘要：** Node SEA 打包、入口 smoke test、提交说明、ignore
  规则和最终验证记录。
- **Agent 产物：** commits `56e15e5`、`5b11dfe`、`b3cc6a4`、
  `b4ab4e4`、`3d84ee8`、`5de14c5`。
- **人工干预：** 限定只声称 Windows 本机验证；Linux/macOS 只提供同路径构建
  说明。
- **教训：** “能构建”与“已在该平台验证”必须明确区分。

## 2026-08-16

### 2026-08-16｜课程清单补正

- **Task：** 课程交付物补正。
- **触发技能：** using-superpowers、brainstorming、writing-plans、
  executing-plans、verification-before-completion。
- **关键 prompt/context：** 助教未检查 `docs/`；根目录缺少标准交付文件；
  用户明确不要求 PR 和 WebUI，REFLECTION 正文由本人之后完成。
- **Agent 产物：** 根目录 `PLAN.md`、`SPEC_PROCESS.md`、
  `AGENT_LOG.md`、`REFLECTION.md`，完善 `SPEC.md`，并新增 GitHub 与
  GitLab CI 配置。
- **人工干预：** 用户缩小范围，排除 #2 PR 工作流和 #9 WebUI 部署；要求
  Reflection 只建立文件。
- **验证：** `npm test` 为 262/262 通过；两个 CI YAML 均成功解析且包含
  `unit-test`；`npm run build:executable` 成功生成 `artifacts/kea.exe`；
  smoke test 输出 `0.1.0`；`git diff --check` 退出 0。
- **commit hash：** 本日志与课程材料位于同一提交，hash 通过 `git log` 查询；
  提交范围排除用户已有的 `.env.example` 删除。
- **教训：** 内部过程文档必须同时提供标准根目录入口，不能假设评审会递归查找。

## 2026-08-18 — 2026-08-19

### 2026-08-18｜课程发布后的架构收敛

- **触发技能：** brainstorming（coding-agent cleanup 设计 `94bbb1b`、`a81cd68`）、
  writing-plans、TDD。
- **关键 prompt/context：** 把 course-release 早期方案中的 verify/项目记忆/SEA
  单文件等收敛为更稳定、可完整测试的 6 工具 CLI；统一 `agent` 与 `harness` 边界，
  应用启动合入 `coding-agent`。
- **Agent 产物：** 合并 `agent` 包进 `harness`（`fdf5890`）；删除环境运行时辅助
  与 `.env.example`（`afa1882`）；应用启动合入 `coding-agent`（`a9b66b2`）；
  移除 `init` 命令、改为首次运行自动创建模板（`49b7e8e`、`9fa9376`）；
  provider 与协议分离、支持多模型并按 provider 分组（`6a9d6ff`、`c3b1f77`、
  `c3b1f77`）；重建 readline UI 与命令（`8856b70`、`2460106`、`4baa78a`）。
- **人工干预：** 正式运行不再依赖 `.env`，配置一律走 JSON；去掉不再需要的
  `verify`/`remember`/`search_memory` 工具与宿主平台 SEA 单文件构建，分发改为
  `npm install -g .` 全局安装（`bin` 指向 `dist/src/main.js`）。
- **验证：** `npm test` 331/333 通过（2 跳过）。

### 2026-08-19｜事件与标题展示修正

- **触发技能：** systematic debugging、TDD、verification-before-completion。
- **关键 prompt/context：** 统一工具渲染并让 thinking 默认可见；补齐 text/thinking
  块的 start/end 事件贯通整个流；修复"session title 一直 unknown"。
- **Agent 产物：** commits `2a625ba`（thinking 默认可见）、`78f4d6f`/`72ca6d0`
  （thinking 指示器与工具摘要）、`7e285f3`（text/thinking start-end 事件）、
  `ed43a12`（session title 修复）。
- **人工干预：** title 从追加 `session_title` 记录改为持久化到 header 字段并原地
  重写 header（避免编辑器打开文件时 rename 因缺少 delete 共享而失败）；标题生成
  失败回退到截取首条非空 prompt 文本，保证标题不会停留在默认值；恢复 `append`
  对非法记录的内存校验（回归修复）。
- **验证：** `npm test` 331/333 通过；`git diff --check` 通过。
- **教训：** "能展示"与"能被实时观察且能持久化"是两回事；标题这类元数据应当作为
  header 字段而非追加记录，否则加载时仍需折叠推导。
