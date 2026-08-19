# 启动层合并与错误处理内化设计

## 目标与阅读前提

本文把散落在 `src/application/` 的启动杂务（参数解析、配置加载、模板补建、目录发现）折进
`src/coding-agent/`，并把事件系统的 listener 错误处理内化，使 `main.ts` 回到最精简的组合根形态。

本文以当前已实现的 `src/core`（ai、events、harness）与 `src/coding-agent`（Project、内置 Tool、
Permission、Interactions）为基础，只调整启动层的归属与少量接口，不改变 Core 的运行时机制。

现有 `src/application/` 的四个文件不作为设计依据；实现时删除该目录，按本文重新放置。

## 1. 文件布局

启动能力全部进入 `coding-agent` 的两个子目录，`application/` 删除：

```text
src/coding-agent/
  cli/
    args.ts              参数解析（parseArgs，返回 diagnostics，不 throw）
    project-directory.ts 启动目录 → Git 根 → 规范目录（原样搬入）
  config/
    defaults.ts          协议名、凭据字段名、内建默认值
    schema.ts            配置文件的读取、解析与校验（含 ConfigurationError）
    config.ts            Config 类、分层合并、跨字段校验、loadConfig 引导入口
    templates.ts         首次运行的 config.json / auth.json 模板补建
  factory.ts             openOrCreateProject（不变，去掉 onListenerError 参数）
  project/ tools/ events/ interaction/ system-prompt.ts index.ts   不变
```

`src/main.ts` 只从 `coding-agent/cli` 与 `coding-agent/config` 导入启动能力，不导入
`coding-agent` 的领域内部组件（project/tools/events 等）。

## 2. `cli/args.ts`：参数解析诊断化

`parseArgs` 不再 throw，把参数错误收集进 `diagnostics`，返回完整的解析结果：

```ts
export type Diagnostic = { readonly type: "warning" | "error"; readonly message: string };

export interface Args {
  readonly continue: boolean;
  readonly config?: string;
  readonly verbose: boolean;
  readonly directory: string;
  readonly diagnostics: readonly Diagnostic[];
}

export function parseArgs(argv: readonly string[]): Args;
```

原来抛错的五种情况改为向 `diagnostics` 追加 `{ type: "error", message }`：

- 重复的 `-c`、`--verbose`、`--config`；
- `--config` 缺少值；
- 未知选项；
- 多个位置目录。

`directory` 缺省仍为 `process.cwd()`。解析不因错误中断；`main.ts` 在拿到 `Args` 后统一判断
`diagnostics` 中的 error 并退出。

## 3. `config/` 拆分

`application/config.ts` 目前把常量、schema 校验、合并、跨字段校验、`Config` 实体全部堆在一个
文件里。按关心点拆成三份（`templates.ts` 由 `application/init.ts` 迁入）：

### 3.1 `defaults.ts`

```ts
const PROTOCOLS: readonly ProtocolId[] = ["anthropic", "openai", "gemini"];
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set(["apiKey", "token", "secret", "password"]);
const BUILTIN_DEFAULTS = {
  agent: { maxTurns: 20 },
  tools: { timeoutSeconds: 120 },
  ui: { thinking: "hidden", toolDetails: "compact" },
};
```

### 3.2 `schema.ts`

"一个普通配置源 / auth 文件长什么样、如何校验"的关心点：

- `ConfigurationError`（来源路径 + 字段路径 + 消息）；
- `ParsedOrdinary`、`ProviderFields` 类型；
- `parseOrdinarySource(path, value)`、`parseAuth(path, value)`；
- 校验 helper：`assertObject`、`rejectCredentials`、`assertOnlyKeys`、`assertEnum`、
  `assertAbsoluteHttpUrl`、`assertModels`。

### 3.3 `config.ts`

"多个来源如何读入、合并、跨字段校验成一个实体"的关心点：

- `readOptionalJson`、`readRequiredJson`、`parseJson`（文件读入）；
- `ResolvedOrdinary`、`mergeOrdinary`（分层合并，provider 深合并、`models` 整体替换）；
- `ResolvedProvider`、`resolveProviders`（跨字段校验：至少一个 provider → 各 provider 合法 →
  `defaultModel` 引用有效 → auth key 非空）；
- `Config` 类（`models`、`defaultModel`、`runtimeProviders`、`redact`）。

## 4. `Config.load` 与 `loadConfig` 分层

模板补建与配置加载是两件独立的事：把它们塞进同一个纯函数会破坏测试对"缺失文件跳过"的
语义。因此拆成两层：

```ts
// config/config.ts —— 纯加载,可测,不建模板、不打印、显式 keaHome。
static load(options: {
  readonly keaHome: string;
  readonly projectDirectory: string;
  readonly configOverride?: string;
  readonly verbose: boolean;
}): Promise<Config>;

// config/config.ts —— 应用引导:算 keaHome、补模板、打印 created、转调 Config.load。
export async function loadConfig(options: {
  readonly projectDirectory: string;
  readonly configOverride?: string;
  readonly verbose: boolean;
  readonly keaHome?: string;   // 默认 ~/.kea,测试注入
}): Promise<{ config: Config; keaHome: string }>;
```

`loadConfig` 内部顺序：

1. `keaHome = options.keaHome ?? resolve(homedir(), ".kea")`；
2. `await initializeUserConfiguration(keaHome)`（来自 `templates.ts`）；
3. 对 `created === "created"` 的文件打印 `<path>: created`；
4. 转调 `Config.load({ keaHome, projectDirectory, configOverride?, verbose })`；
5. 返回 `{ config, keaHome }`。

`keaHome` 只在 `loadConfig` 里计算一次，通过返回值交给 `main.ts`，再由 `main.ts` 显式传给
`openOrCreateProject`。`openOrCreateProject` 不知道配置、不默认 `keaHome`，该参数保持显式。

## 5. `onListenerError` 内化

listener 错误处理是事件系统的内部策略，不应从 main 逐层传入。参照 Pi 的 `event-bus.ts`，
`createBuiltinEvents` 直接提供一个 `console.error` 默认 handler：

```ts
// coding-agent/events/factory.ts
const events = new Events((error) => {
  console.error(error instanceof Error ? error.message : String(error));
});
```

改动：

- `createBuiltinEvents` 去掉 `onListenerError` 参数；
- `openOrCreateProject` 去掉 `onListenerError` 参数；
- `main.ts` 不再注入 `onListenerError`；
- `core/events` 的 `Events` 保持库默认（无 handler = 吞掉），内化只发生在 coding-agent 层。

## 6. 错误处理边界

两类错误走两条通道，互不混用：

| 错误类别 | 通道 | 说明 |
|---|---|---|
| 管道错误（listener 抛错） | `createBuiltinEvents` 内化的 `console.error` | 不 redact、不进 UI、不进 TUI |
| 产品错误（交互循环中 catch 到的运行错误） | `CliUi` 的 `reportError` 回调 | 由 main 从 `config.redact` 构造，是未来 TUI `showError` 的接缝 |

`reportError` 保持外部注入：`CliUi` 不应知道 Config/凭据，脱敏只能由持 key 的 main 完成。

## 7. `main.ts` 形态

```ts
import { parseArgs } from "./coding-agent/cli/args.js";
import { resolveProjectDirectory } from "./coding-agent/cli/project-directory.js";
import { loadConfig } from "./coding-agent/config/config.js";
import { openOrCreateProject } from "./coding-agent/factory.js";

export async function main(argv: readonly string[] = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.diagnostics.some((d) => d.type === "error")) {
    for (const d of args.diagnostics) console.error(`${d.type}: ${d.message}`);
    process.exitCode = 1;
    return;
  }

  const projectDirectory = await resolveProjectDirectory(args.directory);
  const { config, keaHome } = await loadConfig({
    projectDirectory,
    configOverride: args.config,
    verbose: args.verbose,
  });

  const reportError = (error: unknown) =>
    console.error(config.redact(error instanceof Error ? error.message : String(error)));

  const runtime = createModelRuntime({ providers: config.runtimeProviders() });
  const ui = new CliUi({
    models: config.models,
    thinking: config.thinking,
    toolDetails: config.toolDetails,
    reportError,
  });
  const project = await openOrCreateProject({
    keaHome,
    projectDirectory,
    runtime,
    modelConfig: config.defaultModel,
    interactions: ui.interactions,
    maxTurns: config.maxTurns,
    toolTimeoutSeconds: config.toolTimeoutSeconds,
  });
  const initial = await selectInitialHarness(project, args.continue);
  try { await ui.run(project, initial); } finally { ui.close(); }
}
```

`selectInitialHarness` 保留在 `main.ts`（它被 `tests/main.test.ts` 直接导入）；`--verbose` 的诊断
输出保留，放在 `loadConfig` 之后、经 `config.redact` 输出。

## 8. 依赖方向

```text
main -> coding-agent/cli, coding-agent/config, coding-agent/factory
coding-agent/cli, coding-agent/config -> core/ai, core/harness
coding-agent/factory -> core/harness, core/ai, coding-agent/events, coding-agent/project
```

`coding-agent/cli` 与 `coding-agent/config` 是纯启动能力：不 import UI、不 import
project/tools/events/interaction，只向下依赖 `core`。`coding-agent/index.ts` 不 re-export
cli/config（它们只服务 `main.ts`）。

## 9. 验证要求

### 9.1 参数解析

- 五种参数错误进 `diagnostics`，不 throw；`parseArgs` 返回部分结果；
- `--config` 的相对路径仍从 `process.cwd()` 解析为绝对路径；
- `directory` 缺省为 `process.cwd()`。

### 9.2 配置拆分与 loadConfig

- `Config.load` 行为与拆分前完全一致（现有 config 测试不改语义）；
- `loadConfig` 在缺省 `keaHome` 下补建模板、对 created 文件打印 `<path>: created`；
- `loadConfig` 注入 `keaHome` 时跳过 `homedir()` 计算，测试不触真实主目录；
- 返回的 `{ config, keaHome }` 中 `keaHome` 与 `Config.load` 使用的一致。

### 9.3 onListenerError 内化

- `openOrCreateProject`、`createBuiltinEvents` 不再接收 `onListenerError`；
- listener 抛错时错误经 `console.error` 输出，不被静默吞掉；
- `reportError` 仍由 main 注入 `CliUi`，并经 `config.redact` 脱敏。

### 9.4 回归

- `npm run typecheck`、`npm test` 全绿；
- `tests/application/*` 迁移到 `tests/coding-agent/cli/`、`tests/coding-agent/config/` 后通过；
- `tests/main.test.ts`（spawn 真实二进制 + HOME 注入）通过；
- 无残留 `src/application` 引用。

## 10. 不在范围

- 不改 Core 的运行时机制（ai/events/harness 的事件、Session、AgentHarness 不变）；
- 不改 `coding-agent` 的 Project/工具/权限/Interactions 逻辑（只去掉 `onListenerError` 参数）；
- 不引入 TUI、不实现 `showError` 通道（只保证 `reportError` 是那个缝）；
- 不把 `keaHome` 默认值下沉进 `openOrCreateProject`（它不知道配置）。
