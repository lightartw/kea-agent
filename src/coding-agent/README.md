# coding-agent

`coding-agent` 是 Kea 的项目级产品层，分为两类代码：

- **启动层**（`cli/` + `config/`）：无长期状态，只回答"应用怎么启动、怎么配置"。参数解析、
  目录发现、`Config`/`loadConfig`、配置模板。唯一消费者是 `main.ts`。
  详见 [docs/startup.md](./docs/startup.md)；
- **领域层**（`project/`、`tools/`、`events/`、`interaction/`、`factory.ts`、`system-prompt.ts`）：
  把 `core` 的可复用概念（`SessionRepository`、`Events`、`AgentToolRegistry`、`AgentHarness`、
  `ModelRuntime`）封装、管理，并新增 Coding Agent 能力：Project 持久化、内置工具、权限策略、
  system prompt、`Interactions` 端口。详见 [docs/project.md](./docs/project.md)。

两层都不包含 UI。`Agent Loop`、模型 Provider、Session 文件格式和 Events 分发机制仍由 `core`
负责，基础规则见 [ai](../core/ai/README.md) 与 [harness](../core/harness/README.md)。

## 最小用法

调用方先创建显式 Provider 的模型运行时，并提供一个 `Interactions` 实现。随后打开 Project、
创建 Harness，再像使用普通 `AgentHarness` 一样提交 prompt：

```ts
import { createModelRuntime } from "../core/ai/index.js";
import { openOrCreateProject, type Interactions } from "./index.js";

const runtime = createModelRuntime({
  providers: [
    { name: "openai", protocol: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-..." },
  ],
});

const interactions: Interactions = {
  async permission(request) {
    console.log(request);
    return { kind: "deny", reason: "No permission adapter is configured." };
  },
};

const project = await openOrCreateProject({
  keaHome: "/home/alice/.kea",
  projectDirectory: "/path/to/project",
  runtime,
  modelConfig: { provider: "openai", model: "gpt-5" },
  interactions,
  maxTurns: 20,
  toolTimeoutSeconds: 120,
});

const harness = await project.createHarness();
await harness.prompt("Explain this project.");
```

`Interactions` 必须由调用方显式提供。上面的实现只用于展示接口形状；实际应用通常会等待用户
选择允许一次、始终允许或拒绝。

## 公共导出

`src/coding-agent/index.ts` 保持最小公开接口。

### 值

- `openOrCreateProject`：为规范 Project 目录组装 Project 级运行时；
- `ProjectError`：Project 数据、目录和 cwd 错误。

### 类型

- `Project`、`ProjectInfo`；
- `Interactions`、`PermissionRequest`、`PermissionReply`。

`ProjectStorage`、system prompt builder、内置 Tool/Event factory、权限规则和各 Tool 的 details
类型都是内部实现，不从包入口重新导出。`cli/` 与 `config/` 也只服务 `main.ts`，不从包入口导出。
