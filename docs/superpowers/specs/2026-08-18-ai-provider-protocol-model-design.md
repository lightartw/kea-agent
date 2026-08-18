# Provider 与协议分离：Provider 模型配置设计

## 1. 目标与背景

当前代码把 "provider" 同时用作两件事：实际服务提供商（Anthropic、OpenAI、Gemini）和请求
协议格式。`ModelConfig.provider`、`RuntimeProviderConfig.id` 与三个 adapter 都以
`"anthropic" | "openai" | "gemini"` 标识。这无法表达 DeepSeek、本地 Ollama 等使用
OpenAI 兼容协议的第三方提供商，也不支持一个提供商下配置多个模型。

本设计把两者分离：

- **Provider** 是用户配置的连接实例，例如 `deepseek`；它拥有 name、base URL、API key，
  并选择一种协议格式。
- **协议格式（Protocol）** 固定为 `anthropic`、`openai`、`gemini` 三者之一，决定用哪个
  SDK adapter 发起请求。
- **Model** 是 provider 提供的一个模型字符串；一个 provider 可以配置多个 model。

同时把默认选择从 `defaultProvider` 改为显式的 `defaultModel`，因为一个 provider 有多个
model 时，"defaultProvider + 第一个 model" 的隐式规则不可预期。

### 范围

- `src/core/ai`：`ProtocolId`、`RuntimeProviderConfig`、provider 路由；
- `src/application/config.ts` 与 `src/application/init.ts`：配置文件结构、合并与校验、模板；
- `src/ui/cli/cli-ui.ts`：`/model` 按 provider 分组的两步选择；
- `src/main.ts`：verbose 日志中的 provider 名；
- 相关 README、`docs/architecture.md` 与测试。

### 不在范围

- 从 provider API 自动拉取模型列表（模型由用户在配置里显式列出）；
- 把 API key 放进普通配置文件（继续只在 `~/.kea/auth.json`）；
- 修改 `ModelConfig` 形状或 Session 持久化的 `model_selection` 格式；
- 修改 Agent Loop、Harness、Session 的消息与工具逻辑。

## 2. 概念模型

```text
Provider(连接实例)                    Protocol(协议格式)          Model
┌───────────────┐   protocol  ┌──────────────────────┐   models   ┌──────────────┐
│ name          │────────────▶│ anthropic | openai   │◀───────────│ string       │
│ baseUrl       │             │ | gemini             │            │ (一个或多个) │
│ apiKey        │             └──────────────────────┘            └──────────────┘
└───────────────┘
```

请求路由：`ModelConfig.provider`（= 配置的 provider 名）→ 查找该 provider 的 adapter →
把 `ModelConfig.model` 传给 adapter。adapter 由 provider 的 `protocol` 决定。

一个 provider 名只对应一个协议，但同一协议可以有多个 provider（例如 `deepseek` 与
`ollama` 都用 `openai` 协议）。

## 3. `src/core/ai` 接口

### 3.1 ProtocolId 与 RuntimeProviderConfig

```ts
type ProtocolId = "anthropic" | "openai" | "gemini";

interface RuntimeProviderConfig {
  readonly name: string;       // 配置的 provider 名，例如 "deepseek"
  readonly protocol: ProtocolId;
  readonly apiKey: string;
  readonly baseUrl?: string;   // 缺省时使用该协议的内建默认 base URL
}
```

- 原 `ProviderId` 重命名为 `ProtocolId`，语义从 "provider 标识" 变为 "协议格式"。
- `RuntimeProviderConfig.id` 改名为 `name`。
- 协议的内建默认 base URL 保留：anthropic → `https://api.anthropic.com`、openai →
  `https://api.openai.com/v1`、gemini → 无默认（使用 SDK 默认）。

### 3.2 工厂

```ts
function createModelRuntime(options: {
  readonly providers: readonly RuntimeProviderConfig[];
}): ModelRuntime;
```

校验：

- provider 列表非空；
- `name` 非空且不重复；
- `protocol` 是三者之一；
- 每个 provider 按其 `protocol` 构造 lazy adapter，adapter map 以 `name` 为键。

`ModelRuntime.stream(modelConfig, ...)` 的按 `modelConfig.provider` 路由逻辑不变；
请求未配置的 provider 名仍抛 `Unknown provider`。

`createModelRuntimeFromEnvironment(env)` 保留为开发/测试入口：每个协议存在对应
`*_API_KEY` 环境变量时，生成 `{ name: 协议名, protocol: 协议名, apiKey, baseUrl? }`。
生产 `main.ts` 不调用它。

`Adapter`、`ResolvedOptions` 与三个具体 adapter 不变。

## 4. 配置文件结构

### 4.1 `~/.kea/config.json`（与 `<project>/.kea/config.json`、`--config` 同结构）

```json
{
  "defaultModel": { "provider": "deepseek", "model": "deepseek-reasoner" },
  "providers": {
    "deepseek": {
      "protocol": "openai",
      "baseUrl": "https://api.deepseek.com/v1",
      "models": ["deepseek-chat", "deepseek-reasoner"]
    },
    "anthropic": {
      "protocol": "anthropic",
      "models": ["claude-sonnet-4"]
    }
  },
  "agent": { "maxTurns": 20 },
  "tools": { "timeoutSeconds": 120 },
  "ui": { "thinking": "hidden", "toolDetails": "compact" }
}
```

字段规则：

- `providers` 是一个以 provider 名为键的对象。provider 名是任意字符串，要求非空且 trim
  后非空，不限制为协议名集合。每个 provider 值必须是对象，只允许 `protocol`、`baseUrl`、
  `models` 三个字段；
- `protocol` 必须是 `anthropic`、`openai`、`gemini` 之一；
- `baseUrl`（可选）必须是绝对 http(s) URL；
- `models` 必须是非空字符串数组，且数组内不能有重复值；
- `defaultModel` **必填**，必须是恰好含 `provider` 与 `model` 两个字段的对象，两者都是
  非空字符串；
- `agent`、`tools`、`ui` 的规则与当前实现一致，不做改变。

### 4.2 `~/.kea/auth.json`

```json
{
  "providers": {
    "deepseek": { "apiKey": "sk-..." }
  }
}
```

- `providers` 同样以 provider 名为键，每个值只允许 `apiKey` 字符串字段；
- 可保存当前普通配置未启用的 provider 凭据，加载时忽略；
- 凭据仍然只来自 auth 文件，普通配置源继续拒绝 `apiKey`/`token`/`secret`/`password`。

## 5. Config 解析、合并与校验

`Config.load()` 的读取顺序、可选/必填来源语义与现在一致。改动集中在 provider 结构与
跨字段校验。

### 5.1 每来源解析

- provider 名不再限制为三个协议名，接受任意非空字符串；
- `protocol`、`baseUrl`、`models` 按 4.1 的规则独立校验；
- `defaultModel` 每来源独立校验；
- 每个来源仍在自己合法后才参与合并。

### 5.2 合并语义

- `providers` 按 provider 名深合并：同一 provider 名的 `protocol`、`baseUrl` 由高优先级
  值替换；`models` 数组由高优先级值整体替换（不做数组拼接）；
- `defaultModel` 由高优先级值整体替换；
- `agent`、`tools`、`ui` 合并规则不变；
- 标量替换、缺失继承、`null` 是类型错误、未知字段报错等规则不变。

### 5.3 跨字段校验（构造 Config 前）

按顺序：

1. 至少配置一个 provider；
2. 每个已配置 provider 合法（protocol、baseUrl、models 非空且不重复）；
3. `defaultModel` 必须引用已配置 provider 名，且 `model` 必须在该 provider 的 `models`
   列表中；
4. 每个已配置 provider 在 auth 文件中必须有非空 `apiKey`。

校验失败产生 `ConfigurationError`，带来源路径与字段路径。

### 5.4 Config 公共接口

```ts
class Config {
  readonly maxTurns: number;
  readonly toolTimeoutSeconds: number;
  readonly thinking: "hidden" | "visible";
  readonly toolDetails: "compact" | "full";
  readonly verbose: boolean;

  static load(options: {
    readonly keaHome: string;
    readonly projectDirectory: string;
    readonly configOverride?: string;
    readonly verbose: boolean;
  }): Promise<Config>;

  get models(): readonly ModelConfig[];          // 扁平，按 providers 插入顺序
  get defaultModel(): ModelConfig;
  runtimeProviders(): readonly RuntimeProviderConfig[];
  redact(message: string): string;
}
```

- 删除 `defaultProvider` 字段与 `ProviderId` 导入；
- `models` 遍历 `providers` 对象的所有 provider，对每个 provider 的每个 model 生成
  `{ provider: 名, model }`，保持配置中的插入顺序；
- `defaultModel` 返回经过跨字段校验的 `ModelConfig`；
- `runtimeProviders()` 返回 `{ name, protocol, apiKey, baseUrl? }` 数组；
- Provider 明细继续私有（`#providers`），`redact()` 行为不变。

## 6. `src/ui/cli/cli-ui.ts`：`/model`

`/model` 从单列表改为两步选择：

```text
Models:
  1. deepseek
  2. anthropic
Model number? 1
Models for deepseek:
  1. deepseek-chat
  2. deepseek-reasoner
Model number? 2
```

- 第一步按 `Config.models` 中出现的 provider 名去重、保持顺序列出 provider；
- 选中 provider 后列出该 provider 的模型并选择；
- 任一步空输入或 EOF 取消，不改变当前模型；
- 选择当前已生效的模型是 no-op；
- `ensureConfiguredModel` 继续用扁平 `models` 判断候选 Harness 的模型是否仍被配置，
  交互逻辑不变；恢复的 Session 模型不在配置列表时仍要求重新选择。

## 7. Session / Harness / Agent Loop

`model_selection` 持久化格式 `{ provider, model }` 不变，`provider` 现在记录的是配置的
provider 名。旧 Session 中 `provider` 为协议名（如 `"openai"`）的记录在升级后大概率不再
匹配任何已配置 provider 名，由现有 `ensureConfiguredModel` 流程要求用户重新选择——这是
可接受的迁移行为，不需要额外数据迁移。

`AgentHarness`、`runAgentLoop`、`AgentToolRegistry` 不修改。

## 8. `src/main.ts` 与 verbose

- `config.defaultModel` 传入 `openOrCreateProject`，不再引用 `defaultProvider`；
- verbose 日志中 `provider.id` 改为 `provider.name`；
- 凭据脱敏路径不变。

## 9. 模板（`src/application/init.ts`）

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

auth 模板：

```json
{
  "providers": {
    "openai": { "apiKey": "" }
  }
}
```

## 10. 文档

更新以下文档中 provider/协议相关的表述：

- `src/core/ai/README.md`；
- `src/coding-agent/README.md`（如有涉及）；
- `docs/architecture.md` 的 AI 层章节；
- 根 `README.md` 的配置示例与常见问题。

## 11. 错误示例

```text
C:\Users\alice\.kea\config.json: providers.deepseek.protocol: expected "anthropic", "openai" or "gemini"
C:\Users\alice\.kea\config.json: providers.deepseek.models: must be a non-empty array of strings
C:\Users\alice\.kea\config.json: defaultModel: defaultModel must reference a configured provider
C:\Users\alice\.kea\config.json: defaultModel.model: model must be listed in provider "deepseek" models
C:\Users\alice\.kea\auth.json: providers.deepseek.apiKey: must be non-empty
```

## 12. 验证要求

### 12.1 ai 包

- `createModelRuntime` 拒绝空列表、重复 provider 名、未知协议；
- 两个不同 name 的 provider 可以共用同一协议，各自独立路由；
- 请求未配置的 provider 名抛 `Unknown provider`；
- `ModelConfig.model` 原样传给 adapter；
- env 辅助入口为每个可用协议的 env key 生成 `name = 协议名` 的 provider。

### 12.2 配置

- provider 名接受任意非空字符串（如 `deepseek`），不再限制为三个协议名；
- `protocol` 必须是三者之一；
- `models` 非空、字符串、无重复；
- `baseUrl` 合法 http(s) URL；缺省时运行时使用协议默认值；
- `defaultModel` 必填且必须引用已配置 provider 的已列 model；
- 普通源仍拒绝 credential 字段；auth 按 provider 名取 key；
- `providers` 深合并、`models` 数组整体替换、`defaultModel` 整体替换；
- `models` 与 `defaultModel` 按配置顺序稳定生成。

### 12.3 UI

- `/model` 两步列出 provider 与其模型，空输入/EOF 取消且不改变模型；
- 选择当前模型是 no-op；
- `ensureConfiguredModel` 对新旧 Session 模型按新配置列表校验。

### 12.4 回归

- 现有 `npm run typecheck`、`npm test`、`npm run build` 全绿；
- 所有测试继续使用 fake ModelRuntime 与临时目录，不发起真实 provider 网络请求。
