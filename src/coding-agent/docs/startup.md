# Startup：启动与配置

`coding-agent` 的启动层。它无长期状态、不接触 core 的 Session/Events/Tool，只回答"应用怎么
启动、怎么配置"，唯一消费者是 `main.ts`。它向下只依赖 `core/ai` 与 `core/harness`，不 import UI，
也不 import 本包的领域组件（`project/`、`tools/`、`events/`、`interaction/`）。

本包领域组装（Project、内置工具、权限、Interactions）见 [project.md](./project.md)。

## 源码位置

```text
cli/
  args.ts              参数解析
  project-directory.ts 启动目录 → Git 根 → 规范目录
config/
  defaults.ts          协议名、凭据字段名、内建默认值
  schema.ts            配置文件的读取、解析与校验
  config.ts            Config、Config.load、loadConfig
  templates.ts         首次运行的 config.json / auth.json 模板
```

## 参数解析

`cli/args.ts` 的 `parseArgs(argv)` 把参数错误收集进 `diagnostics`，不抛异常：

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

重复的 `-c`/`--verbose`/`--config`、`--config` 缺值、未知选项、多个位置目录，都变成
`diagnostics` 里的 `{ type: "error", message }`。`directory` 缺省为 `process.cwd()`，`--config`
的值从 `process.cwd()` 解析为绝对路径。

## 目录发现

`cli/project-directory.ts` 的 `resolveProjectDirectory(startupDirectory)`：

1. 把启动目录解析为绝对路径并 `realpath` 规范化；
2. 确认它是现存目录；
3. 执行 `git rev-parse --show-toplevel` 找 Git work-tree 根；
4. 位于 work-tree 内时返回规范化的根，否则返回规范化的启动目录；
5. Git 无法启动、返回空根、目录访问失败时明确报错。

不能靠查找 `.git` 目录代替 Git 命令，因为 worktree 的 `.git` 可以是文件。这是纯启动能力：
`openOrCreateProject()` 不运行 Git，只在边界处再次校验传入的目录。

## 配置分层

`config/config.ts` 的 `Config` 是唯一的应用设置实体，按优先级分层加载：

```text
内建默认值 < ~/.kea/config.json < <project>/.kea/config.json < --config 文件 < CLI 覆盖（--verbose）
```

- 每个普通配置源独立校验后才参与合并；
- 普通源拒绝 credential 字段（`apiKey`/`token`/`secret`/`password`）；
- 凭据只来自 `~/.kea/auth.json`，在所有普通源之后加载，按 provider 名取 apiKey；
- provider 的 `protocol` 必须是 `anthropic`/`openai`/`gemini` 之一，`models` 是非空且不重复的
  字符串数组；
- 跨字段校验顺序：至少一个 provider → 各 provider 合法 → `defaultModel` 必填且引用已配置
  provider 的已列 model → 启用 provider 的 auth key 非空。

`Config` 保持 Provider 凭据私有，公开 `models`、`defaultModel`、`runtimeProviders()`、
`maxTurns`、`toolTimeoutSeconds`、`thinking`、`toolDetails`、`verbose` 和 `redact()`。`redact()`
把已加载的非空 API key 替换为 `[REDACTED]`。

### Config.load 与 loadConfig

```ts
// 纯加载：显式 keaHome、不建模板、不打印，可单测。
static load(options: {
  readonly keaHome: string;
  readonly projectDirectory: string;
  readonly configOverride?: string;
  readonly verbose: boolean;
}): Promise<Config>;

// 应用引导：算 keaHome、补建模板、打印 created，再转调 Config.load。
export async function loadConfig(options: {
  readonly projectDirectory: string;
  readonly configOverride?: string;
  readonly verbose: boolean;
  readonly keaHome?: string;   // 默认 ~/.kea，测试注入
}): Promise<{ config: Config; keaHome: string }>;
```

模板补建是副作用，不能进纯加载器（否则"缺失配置跳过"的语义被破坏），所以拆成两层。
`loadConfig` 计算 `keaHome`（默认 `~/.kea`）、补建缺失模板、对 created 文件打印
`<path>: created`，返回 `{ config, keaHome }` 供 `openOrCreateProject` 使用。

### 模板

`config/templates.ts` 的 `initializeUserConfiguration(keaHome)` 用独占创建（`wx`）补建缺失的
`~/.kea/config.json` 与 `~/.kea/auth.json`，绝不覆盖已有文件；`auth.json` 在支持平台按 `0600`
创建。auth 模板的 apiKey 为空，用户填入后重新运行即可。
