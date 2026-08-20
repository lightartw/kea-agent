# Kea

Kea 是一个用 TypeScript 编写的终端编码智能体。通过 `kea` 命令启动，能调用 Bash 与文件工具完成编码任务，并在本地保存会话。支持 OpenAI、Anthropic 与 Gemini 三种协议。

课程功能要求见 [SPEC.md](SPEC.md)，架构说明见 [docs/architecture.md](docs/architecture.md)。

## 功能概览

- 支持 OpenAI、Anthropic、Gemini 三种协议，可通过 `baseUrl` 接入兼容服务。
- 用 JSON 文件管理模型配置与密钥（`~/.kea/config.json`、`~/.kea/auth.json`）；密钥独立存放，项目配置禁止包含凭据。
- 内置工具：`bash`、`read_file`、`write_file`、`edit_file`、`glob`、`todo_write`。
- 自动保存会话；可用 `-c` 恢复最近会话，或 `/session` 切换会话。
- Bash 命令按风险分类：自动允许、需要确认、直接拒绝。
- 默认显示思考过程，工具详情紧凑显示；两者均可在配置中调整。
- 可在 Windows、Linux、macOS 上从源码运行，也可通过 npm 全局安装运行。

## 环境要求

- Node.js 24.x
- npm
- 至少一个模型服务商的 API Key
- Windows 用户需安装 Git for Windows（Kea 的 Bash 工具依赖 Git Bash）；Linux / macOS 需可用 `bash`

## 快速开始

### 方式一：从源码直接运行

```bash
cd kea_agent
npm ci
npm run build
npm start
```

- `npm ci` 安装依赖；
- `npm run build` 编译 TypeScript 到 `dist/`；
- `npm start` 运行（等价于 `node dist/src/main.js`）。

首次运行会自动创建 `~/.kea/config.json` 与 `~/.kea/auth.json` 并打印路径。修改源码后需重新 `npm run build` 再 `npm start`。

### 方式二：构建后全局安装运行

```bash
cd kea_agent
npm ci
npm run build
npm install -g .
```

这会注册一个全局 `kea` 命令。之后在任意代码项目目录直接运行：

```bash
kea
```

卸载：

```bash
npm uninstall -g kea-agent
```

`npm install -g .` 安装的是本地构建产物，`kea` 命令指向 `dist/src/main.js`，因此安装前必须先 `npm run build`。

### 首次配置

首次运行会自动创建 `~/.kea/config.json` 与 `~/.kea/auth.json`。把 `config.json` 中服务商的 `models` 改为真实模型名，并把 API Key 写入 `auth.json`。

`config.json` 示例：

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
  "ui": { "thinking": "visible", "toolDetails": "compact" }
}
```

`auth.json` 示例：

```json
{
  "providers": { "openai": { "apiKey": "your-api-key" } }
}
```

进入需要处理的代码项目目录，运行 `kea`，看到 `kea>` 提示符后输入任务并按 Enter。

## 命令行用法

```
kea [directory] [-c] [--verbose] [--config <path>]
```

- `directory`：启动目录，默认当前目录；若在 Git 仓库内，自动解析到仓库根目录。
- `-c`：恢复该项目最近一次会话。
- `--verbose`：打印项目目录、模型与凭据配置诊断信息。
- `--config <path>`：使用指定配置文件覆盖默认配置。

交互命令（在 `kea>` 提示符输入）：

- `/new`：新建会话
- `/session`：切换会话
- `/model`：切换模型
- `/help`：查看帮助
- `/exit`：退出
- `Ctrl+C`：中止当前运行（SIGINT）；`Ctrl+D`：退出

## 配置说明

配置优先级从高到低：

1. `--config <path>` 指定的配置文件
2. 当前项目 `<project>/.kea/config.json`
3. 用户目录 `~/.kea/config.json`
4. 程序默认值（`maxTurns` 20、`toolTimeoutSeconds` 120、`thinking` visible、`toolDetails` compact）

API Key 只从 `~/.kea/auth.json` 读取。项目配置可以覆盖模型、工具限制与 UI 选项，但禁止包含 `apiKey` 等凭据字段。

会话与项目记录保存在 `~/.kea/projects/<projectId>/`。

## 权限与安全

Bash 命令会被分类处理：

- **直接拒绝**：`sudo`、`shutdown`/`reboot`、`mkfs`、`dd` 原始写入、重定向到 `/dev`、递归强制删除根目录（`rm -rf /` 等）。
- **需要确认**：`rm`、写入 `/etc/`、`chmod 777`。
- **其余自动允许**。

文件工具（`read_file`/`write_file`/`edit_file`/`glob`）不能访问项目目录之外的路径。

这些检查用于减少误操作，不是完整的系统沙箱。请只在可信目录中运行 Kea，并在授权前检查命令内容。

## 开发与验证

```bash
npm run typecheck
npm test
```

`npm test` 会重新编译并运行全部测试。

## 项目结构

- `src/main.ts`：程序入口
- `src/coding-agent/`：项目、配置加载、CLI 参数、事件与权限、内置工具
- `src/core/ai/`：模型接口、消息类型与 OpenAI / Anthropic / Gemini 适配器
- `src/core/events/`：统一事件定义与分发
- `src/core/harness/`：会话存储、运行循环与工具注册
- `src/core/util/`：通用工具
- `src/ui/`：终端界面与命令解析

主要依赖方向为 `ui -> coding-agent -> harness -> ai`，事件系统由各层共享。

## 课程作业提交

课程交付文档：

- [SPEC.md](SPEC.md)
- [PLAN.md](PLAN.md)
- [SPEC_PROCESS.md](SPEC_PROCESS.md)
- [AGENT_LOG.md](AGENT_LOG.md)
- [REFLECTION.md](REFLECTION.md)
