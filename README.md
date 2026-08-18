# Kea Agent

一个最小化的 TypeScript 命令行编程代理。它以 readline 交互循环在项目目录（Git worktree
根）中执行 shell 命令，支持 Anthropic、OpenAI 或 Gemini 作为模型后端。

架构文档：[docs/architecture.md](docs/architecture.md)

## 环境要求

- Node.js 24 LTS（小于 25）
- npm 11 或 Node.js 24 自带的兼容 npm 版本
- Anthropic、OpenAI 或 Gemini 中任意一家可用的 API 凭据

## 初始化

```bash
npm ci
npm run build
npm start
```

Windows PowerShell 使用相同命令。

首次运行 `kea` 会自动检测 `~/.kea/config.json` 与 `auth.json`，缺失的文件按模板补建
（独占创建、只打印 `created`、**绝不覆盖**已有文件），然后继续启动：

- `config.json` — 用户配置模板（provider/model、agent、tools、ui 设置）；
- `auth.json` — 凭据文件（权限 0600），只保存 provider 的 API key。

补建后 `auth.json` 里的 API key 仍是空的，填入后重新运行即可。

## 配置

配置按优先级分层加载：**内建默认值 < `~/.kea/config.json` < `<project>/.kea/config.json`
< `--config <path>` 文件 < CLI 直接覆盖（`--verbose`）**。每个普通配置源独立验证后才合并。

首次运行生成的 `config.json` 模板：

```json
{
  "defaultModel": { "provider": "openai", "model": "gpt-5" },
  "providers": {
    "openai": {
      "protocol": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "models": ["gpt-5"]
    }
  },
  "agent": { "maxTurns": 20 },
  "tools": { "timeoutSeconds": 120 },
  "ui": { "thinking": "hidden", "toolDetails": "compact" }
}
```

`auth.json` 模板：

```json
{
  "providers": {
    "openai": { "apiKey": "" }
  }
}
```

规则：

- **凭据只来自 `~/.kea/auth.json`**，在所有普通配置源之后加载。普通配置源（包括
  `--config`）拒绝 credential 字段（`apiKey`/`token`/`secret`/`password`）。
- `defaultModel` 必填：必须引用已配置 provider，且 model 在该 provider 的 `models` 列表中。
- `providers` 以 provider 名为键，每项含 `protocol`（`anthropic`/`openai`/`gemini` 之一）、
  非空 `models` 数组和可选 `baseUrl`；provider 按配置顺序生效。被启用 provider 的 auth key
  必须非空。
- 内建默认值：`maxTurns` 20、`toolTimeoutSeconds` 120、`thinking` `"hidden"`、
  `toolDetails` `"compact"`。`ui.thinking: "visible"` 显示思考过程，`ui.toolDetails: "full"`
  展开工具事实。
- `kea --config <path>` 指定的文件必须存在，否则启动失败。

生产启动绝不调用 dotenv，也绝不从 `process.env` 读取 provider 凭据。所有诊断输出
（顶层错误、verbose 日志、listener 错误）都会把已加载的 API key 替换为 `[REDACTED]`。

## 使用方法

```text
kea> 帮我修一下测试失败
```

在 `kea> ` 提示符后输入任务并回车。只有字符 0 位置的精确 slash token 才是命令，其余输入
原样作为任务 prompt：

| 命令 | 作用 |
|------|------|
| `/new` | 新建一个 Session |
| `/session` | 列出全部 Session（最新在前），按编号切换 |
| `/model` | 在已配置的 provider/model 之间切换 |
| `/help` | 显示命令帮助 |
| `/exit` | 退出；EOF（Ctrl+D）同样退出 |

`kea -c` 启动时直接恢复最新 Session；没有历史时回退为新 Session。一次只读一个 Prompt，
`prompt()` 运行期间不再读第二个普通 Prompt；SIGINT（Ctrl+C）在运行中时中止当前 Run，
空闲时取消当前输入。切换 Session 或模型失败会保留旧状态。

模型产生的工具调用显示为 `[tool]`，执行状态使用 `[exec]`、`[done]`、`[error]` 或
`[rejected]`。被 Bash 安全策略归为 `ask` 的操作会请求确认：

```text
Allow once [o/N] (a = always)?
```

`o` 或 `once` 允许一次；`a` 或 `always` 允许并记住（仅当前进程）；其他输入（含空回车）
拒绝。硬拒绝命令不会询问。

请只在可信目录中运行本程序，并检查模型生成的命令。权限确认只是防误操作机制，不是完整
沙箱，也不能替代系统权限隔离。

在 Windows 上，BashTool 优先使用 Git Bash；未安装时使用 `bash.exe`（例如 WSL）。因此模型
生成的命令统一采用 Bash 语法，例如 Windows 目录在 WSL 中写为 `/mnt/d/project`，不要使用
`cd D:\project`。

## 启动路径

```text
parseArguments → resolveProjectDirectory → 补建用户配置模板 → Config.load →
createModelRuntime({ providers }) → new CliUi(...) → openOrCreateProject →
selectInitialHarness（-c 取最新 Session，否则新建）→ ui.run → finally ui.close()
```

`main.ts` 是连接具体 UI、Coding Agent 和 AI provider 的唯一组合根：它解析 argv（`-c`、
`--config <path>`、`--verbose`、可选目录），把启动目录解析为 Git worktree 根并规范化，
`Config.load()` 按上文分层加载配置，用 `config.runtimeProviders()` 构造显式
`ModelRuntime`，然后组装 `CliUi` 和 `Project`，最后进入交互循环；`finally` 中幂等关闭
UI。

## 包结构

Harness 核心代码统一位于 `src/core/`；产品适配与界面代码位于核心层之外。

| 包 | README | 职责 |
|----|--------|------|
| `ai` | [ai/README.md](src/core/ai/README.md) | 显式 Provider 的 `ModelRuntime`、消息与流协议 |
| `agent` | [agent/README.md](src/core/agent/README.md) | `runAgentLoop`、`AgentTool` 注册与三阶段拦截、事件契约 |
| `events` | [events/README.md](src/core/events/README.md) | 核心事件契约与统一分发器 |
| `harness` | [harness/README.md](src/core/harness/README.md) | `AgentHarness`（`subscribe`）、Session/Repository、`HarnessEvent` |
| `coding-agent` | [coding-agent/README.md](src/coding-agent/README.md) | `Project`、`openOrCreateProject`、内置 Tools、Bash 策略、Interactions port |
| `application` | — | `Config`（唯一设置实体）、argv、用户配置模板、目录发现 |
| `ui` | — | 命令语言（`parseInput`/`UiAction`）；`ui/cli` 提供命令行实现（`CliUi`、`CliInteractions`、`Renderer`） |

源码依赖方向始终向下：`main -> ui -> coding-agent -> core/harness -> core/agent ->
core/ai`；`core/events` 是 Agent 与 Harness 共享的核心运行时。

## 工具系统

`openOrCreateProject()` 为每份 Session 创建独立的 Tool Registry。默认内置工具为：

| Tool | 行为 |
|---|---|
| `bash` | 在 Session cwd 中运行 shell command；非零退出码产生错误结果 |
| `read_file` | 读取文本文件，或按稳定顺序列出目录；支持一基 `offset` 和 `limit` |
| `write_file` | 写入完整 UTF-8 内容，必要时创建父目录 |
| `edit_file` | 精确替换唯一出现的一段文本；缺失或出现多次时拒绝修改 |
| `glob` | 从 Session cwd 匹配、去重并稳定排序路径 |
| `todo_write` | 返回调用方提交的完整任务列表；Tool 本身不跨调用保存状态 |

输出有界：通用文本输出最多保留 2,000 行和 50 KiB，`glob` 最多 1,000 个结果，`bash`
保留输出尾部。结构化指标放在 Tool Result 的 `details` 中，模型可见的说明放在 `content` 中。

## 权限

Permission listener 注册在 `tools/pre-execute` 上，使用 Project 目录作为初始 trusted
directory：

1. **文件类 Tool**：目标位于 trusted directory 内直接允许；在 Project 外时发送
   `external-directory` 请求，选择 `always` 后该目录在本进程内视为已批准。
2. **Bash**：先确认执行 cwd 受信任，再对命令分类——
   - **硬拒绝**（`sudo`、关机、格式化文件系统、原始 `dd` 输入、`/dev` 重定向、强制递归
     删除根目录等）：直接拒绝，不询问 UI，也不被已记住的授权覆盖；
   - **询问**（文件删除、写入 `/etc`、`chmod 777` 等）：通过 Interactions port 确认；
   - **允许**：直接放行。

`always` 对 Bash 记录的是完整 command 与 cwd 的组合；同一命令换到另一个 cwd 后需要重新
判断。文件工具始终拒绝逃出已批准目录的路径。`Interactions` 端口由调用方显式提供，本包
没有默认实现，避免在没有用户确认渠道时静默放行。

## CLI 与核心边界

`main.ts` 只负责组合：Config → `createModelRuntime({ providers })` → `CliUi` →
`openOrCreateProject()` → 交互循环。`application` 层不依赖 UI 内部组件，main 从 Config
取出 UI 需要的值传给 UI；`src/ui` 也不导入 `src/core/agent`。

UI 观察运行事实的唯一入口是 `harness.subscribe()`：Project 的原始 `Events` 是私有的，
`AgentHarness` 把属于本 Session 的 emit 事实投影成 `HarnessEvent` 转发给 listener。
控制事件（`user-prompt`、`context`、工具三阶段拦截）在状态提交前执行；被动的展示不是
控制事件，而是 UI 层针对订阅事件的 renderer 行为。

## AI 层

`createModelRuntime({ providers })` 只接收显式 Provider 列表：

```ts
createModelRuntime({
  providers: [{ name: "openai", protocol: "openai", apiKey: "sk-..." }],
});
```

`ModelRuntime` 拥有 provider 路由和 lazy adapter；`ModelConfig` 是“这次请求选择哪个模型”
的值。请求未配置的 provider 会抛出 `Unknown provider`。应用组合根负责从 `auth.json`
读取凭据并构造 `runtimeProviders()`；`ai` 本身不读环境变量、不保存 Session 或模型选择。

## 开发与验证

```bash
npm run typecheck
npm test
npm run build
```

测试使用 Node.js 内置 test runner。`npm test` 会先编译到 `dist/`，再运行编译后的测试。

## 更新依赖

依赖使用精确版本并由 `package-lock.json` 锁定。例如：

```bash
npm install --save-exact openai@6.48.0
npm install --save-dev --save-exact typescript@7.0.2
```

更新后运行 `npm test`、`npm run typecheck`，并提交 `package.json` 与 `package-lock.json`。

## 常见问题

- 启动报 `must be non-empty`：`~/.kea/auth.json` 中的 API key 还是空的。首次运行会自动
  补建缺失的 `config.json`/`auth.json`；填入所选 provider 的 key 后重新运行即可。
- 提示没有配置 provider：在 `~/.kea/config.json` 的 `providers` 中至少配置一家 provider。
- 提示 `defaultModel` 必填或引用错误：在 `~/.kea/config.json` 设置 `defaultModel`，
  `{ "provider": "...", "model": "..." }` 必须引用已配置 provider，且 model 在其
  `models` 列表中。
- 在普通配置源里写 `apiKey` 报错：凭据只能放在 `~/.kea/auth.json`。
- 提示 `Directory does not exist`：确认启动目录存在；`--config` 指定的文件必须存在。
- `kea -c` 没有历史：会自动创建新 Session。
- 自定义接口无法连接：检查对应 provider 的 `baseUrl`、网络以及服务端支持的模型标识。
- 安装成功但调用失败：本地依赖安装成功不代表凭据、网络或 provider 服务可用。
