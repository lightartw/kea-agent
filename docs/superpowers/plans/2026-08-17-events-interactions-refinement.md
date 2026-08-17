# Events 与 Interactions 收敛实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Permission 改成无内部状态的判断模块，由 Project 级 `approved` 内存数组承载 `always` 授权，同时由 `createBuiltinEvents()` 返回已经注册默认 Permission listener 的 `Events`。

**Architecture:** `interaction/` 只定义 UI 无关的请求与回复；`events/permission/permission.ts` 根据 Tool Call、Session cwd、Project 可信目录和外部 `approved` 数组计算决定；`events/factory.ts` 是组合根，创建总线并注册 `tools/pre-execute`。`approved` 由调用方创建，生命周期等于 Project 实例，Project 内所有 Session 共享，不落盘。

**Tech Stack:** TypeScript 7、Node.js 24、NodeNext ESM、`node:test`、TypeBox、core `Events.intercept()`。

## Global Constraints

- 只修改 `src/coding-agent/events/`、`src/coding-agent/interaction/`、对应测试和 Permission 设计文档；不修复现有 Project 或其他待清理代码。
- 保留 `PermissionRequest.kind: "dangerous-command"`。
- `PermissionRequest` 不携带 `PermissionOperation`；原始 `call` 已经包含 Tool 信息，Interaction 不重复暴露 Permission 内部分类。
- 不提供 `NO_INTERACTIONS`。装配方必须显式提供 `Interactions`，缺失依赖应在构造阶段暴露，而不是由 Agent 猜测默认行为。
- Tool 不感知 Permission，也不负责发起授权请求。
- `createBuiltinEvents()` 必须保留，并返回已经装配默认 Permission listener 的 `Events`。
- `always` 写入调用方提供的 Project 级内存 `approved` 数组；不增加 Store、Repository 或落盘逻辑。
- Permission 不拥有可变状态；它可以更新传入的 `approved`，因为它负责把 `always` 翻译成具体规则。
- 不增加 `PermissionEnvironment` 或 `ResolvePermissionEnvironment`；只使用具体的 `getSessionCwd(sessionId)`。
- `trustedDirectories` 只参与判断，不得复制进 `approved`。
- 命令规则精确匹配 command 与 cwd；目录规则覆盖目录及后代，并对 read/write/edit/glob/execute 共用。
- hard deny 先于 remembered allow；Interaction 失败、Session 缺失、参数非法和 reply 非法均 fail closed；取消继续传播。
- 保持当前 dirty worktree，不创建 commit；每个任务以目标测试通过作为检查点。

## File Map

| 文件 | 单一职责 |
| --- | --- |
| `src/coding-agent/interaction/interactions.ts` | Permission 请求、回复与外部端口；不定义 Tool operation |
| `src/coding-agent/events/permission/permission.ts` | PermissionRule 与无内部状态的单次判断 |
| `src/coding-agent/events/permission/bash-policy.ts` | 纯 Bash 分类 |
| `src/coding-agent/events/factory.ts` | 创建 Events、查询 cwd、注册默认 Permission listener、落实 `proceed()` |
| `tests/coding-agent/interaction/interactions.test.ts` | Interaction 契约 |
| `tests/coding-agent/events/permission/permission.test.ts` | Permission 分支与 Project 共享授权 |
| `tests/coding-agent/events/permission/bash-policy.test.ts` | Bash 分类边界 |
| `tests/coding-agent/events/factory.test.ts` | 默认 listener 的端到端数据流 |

---

### Task 1: 删除 Interaction 中的 Tool 分类和默认 adapter

**Files:**
- Modify: `src/coding-agent/interaction/interactions.ts`
- Modify: `tests/coding-agent/interaction/interactions.test.ts`

**Interfaces:**
- Preserves: `PermissionRequest.kind` 仍为 `"dangerous-command" | "external-directory"`。
- Removes from `interaction/`: `PermissionRequest.operation`、`PermissionOperation`、`NO_INTERACTIONS`。Tool-operation 联合类型只允许作为 Permission 私有实现细节存在。

- [ ] **Step 1: 精简契约测试**

删除 `NO_INTERACTIONS` 测试和只把所有 reply 放进数组再读取 `kind` 的浅层测试。保留真实 adapter 测试，并用一个完整目录请求确认 Interaction 只携带外部决策需要的数据：

```ts
test("external-directory requests retain structured permission context", () => {
  const request: PermissionRequest = {
    kind: "external-directory",
    sessionId: "session-1",
    runId: "run-1",
    call: {
      type: "toolCall",
      id: "c1",
      name: "read_file",
      arguments: { path: "/tmp/x" },
    },
    targetPath: "/tmp/x",
    directory: "/tmp",
    reason: "outside the project",
  };
  assert.equal(request.kind, "external-directory");
  assert.equal(request.call.name, "read_file");
});
```

- [ ] **Step 2: 删除 operation 与默认实现**

从 `PermissionRequest` 的 `external-directory` 分支删除 `operation`，并从文件末尾删除 `NO_INTERACTIONS`。`Interactions.permission()` 仍然是必须实现的端口；没有 adapter 时，调用方不能构造完整的 builtin Events。

- [ ] **Step 3: 验证 Interaction**

```powershell
npx tsc --ignoreConfig --outDir .tmp/events-plan --rootDir . --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --verbatimModuleSyntax --skipLibCheck --types node src/coding-agent/interaction/interactions.ts tests/coding-agent/interaction/interactions.test.ts
node --test .tmp/events-plan/tests/coding-agent/interaction/interactions.test.js
```

Expected: 编译成功，Interaction 测试全部通过。

---

### Task 2: 用外部 approved 数组替换 Permission 内部状态

**Files:**
- Rewrite: `src/coding-agent/events/permission/permission.ts`
- Rewrite: `tests/coding-agent/events/permission/permission.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Interactions`、`ToolCallEvent`、`PreToolDecision`。
- Produces:

```ts
export type PermissionRule =
  | { readonly kind: "command"; readonly command: string; readonly cwd: string }
  | { readonly kind: "directory"; readonly directory: string };

export async function decidePermission(
  input: ToolCallEvent,
  options: {
    readonly cwd: string;
    readonly trustedDirectories: readonly string[];
    readonly approved: PermissionRule[];
    readonly interactions: Interactions;
  },
  signal?: AbortSignal,
): Promise<PreToolDecision>;
```

`options` 使用匿名结构，不创造 `PermissionEnvironment`。`approved` 属性不可替换，但数组可以追加。

- [ ] **Step 1: 先把测试改成观察外部状态**

删除 `new Permission(...)`、`PermissionRules`、`permission.rules` 和注入 `PermissionPolicy` 的测试写法。加入统一辅助函数：

```ts
function decide(
  input: ToolCallEvent,
  interactions: Interactions,
  approved: PermissionRule[] = [],
  cwd = CWD,
  signal?: AbortSignal,
) {
  return decidePermission(
    input,
    { cwd, trustedDirectories: [PROJECT], approved, interactions },
    signal,
  );
}
```

增加 `always` 外部状态测试：

```ts
test("always appends a command rule to the supplied approved array", async () => {
  const approved: PermissionRule[] = [];
  const interactions = new RecordingInteractions([{ kind: "always" }]);

  assert.deepEqual(await decide(bashEvent("rm file.txt"), interactions, approved), {
    kind: "allow",
  });
  assert.deepEqual(approved, [
    { kind: "command", command: "rm file.txt", cwd: CWD },
  ]);

  await decide(bashEvent("rm file.txt"), interactions, approved);
  assert.equal(interactions.requests.length, 1);
});
```

增加 Project 共享测试；两个不同 `sessionId` 的事件复用同一个 `approved`，第二次不得询问：

```ts
test("approved rules are reusable by another session in one project", async () => {
  const approved: PermissionRule[] = [];
  const interactions = new RecordingInteractions([{ kind: "always" }]);

  await decide(bashEvent("rm file.txt", "session-a"), interactions, approved);
  await decide(bashEvent("rm file.txt", "session-b"), interactions, approved);

  assert.equal(interactions.requests.length, 1);
});
```

增加可信目录不污染用户批准的测试：

```ts
test("trusted directories do not become approved rules", async () => {
  const approved: PermissionRule[] = [];
  const result = await decidePermission(
    fileEvent("read_file", { path: join(PROJECT, "src", "main.ts") }),
    {
      cwd: CWD,
      trustedDirectories: [PROJECT],
      approved,
      interactions: new RecordingInteractions([]),
    },
  );
  assert.deepEqual(result, { kind: "allow" });
  assert.deepEqual(approved, []);
});
```

保留并迁移 ordinary allow、hard deny、once、deny reason、Interaction 异常/非法 reply、abort、目录后代与相似前缀、glob 静态前缀和无关 Tool 的行为测试。

- [ ] **Step 2: 运行编译，确认新 API 尚不存在**

```powershell
npx tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax --skipLibCheck --types node src/core/events/types.ts src/core/agent/tools/events.ts src/coding-agent/interaction/interactions.ts src/coding-agent/events/permission/bash-policy.ts src/coding-agent/events/permission/permission.ts tests/coding-agent/events/permission/permission.test.ts
```

Expected: FAIL，`decidePermission` 和 `PermissionRule` 尚未导出。

- [ ] **Step 3: 删除内部状态实体并建立私有规则函数**

删除 `PermissionRules`、`PermissionPolicy`、`Permission`。实现：

```ts
type PermissionOperation = "read" | "write" | "edit" | "glob";

const FILE_TOOL_OPERATIONS: Readonly<Record<string, PermissionOperation>> = {
  read_file: "read",
  write_file: "write",
  edit_file: "edit",
  glob: "glob",
};

function matchesCommand(
  approved: readonly PermissionRule[],
  command: string,
  cwd: string,
): boolean {
  return approved.some((rule) =>
    rule.kind === "command" && rule.command === command && rule.cwd === cwd
  );
}

function contains(directory: string, targetPath: string): boolean {
  const rest = relative(resolve(directory), resolve(targetPath));
  return rest === "" ||
    (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`));
}

function remember(approved: PermissionRule[], rule: PermissionRule): void {
  const duplicate = rule.kind === "command"
    ? matchesCommand(approved, rule.command, rule.cwd)
    : approved.some((item) =>
        item.kind === "directory" && resolve(item.directory) === resolve(rule.directory)
      );
  if (!duplicate) approved.push(rule);
}
```

`trustedDirectories` 与 `approved` directory rules 分开检查，不能把可信目录预写入数组。

- [ ] **Step 4: 实现 decidePermission 的完整分支**

按以下顺序实现：

1. Bash 先检查执行 cwd 是否落在 trusted/approved directory；未授权时发起 `external-directory`。Request 通过原始 `call` 表明这是 Bash 调用，不增加 operation 字段。
2. cwd 当前调用获准后，再计算 hard deny > approved command > policy allow/ask。
3. read/write/edit/glob 解析目标路径并检查 trusted/approved directory。
4. 无关 Tool 返回 allow。

将目录与命令分支拆成两个私有函数，不要把它们再做成 class：

```ts
async function authorizeDirectory(
  input: ToolCallEvent,
  targetPath: string,
  directory: string,
  options: {
    readonly cwd: string;
    readonly trustedDirectories: readonly string[];
    readonly approved: PermissionRule[];
    readonly interactions: Interactions;
  },
  signal?: AbortSignal,
): Promise<PreToolDecision>;

async function authorizeCommand(
  input: ToolCallEvent,
  command: string,
  options: {
    readonly cwd: string;
    readonly trustedDirectories: readonly string[];
    readonly approved: PermissionRule[];
    readonly interactions: Interactions;
  },
  signal?: AbortSignal,
): Promise<PreToolDecision>;
```

`always` 先记录再 allow：

```ts
remember(options.approved, {
  kind: "directory",
  directory: resolve(directory),
});
```

非法 recognized Tool 参数不能回退到 cwd：

```ts
return {
  kind: "deny",
  reason: `Permission request failed: invalid arguments for ${input.call.name}`,
};
```

hard deny 必须直接使用 `classifyBashCommand()`，不保留可替换 policy 的测试注入口。

删除旧的 `file operations map to their Permission operation` 测试，替换为遍历 `read_file`、`write_file`、`edit_file`、`glob`，断言它们对外部目标都产生 `external-directory` request；测试不得读取 request 上不存在的 operation。

- [ ] **Step 5: 验证 Bash 外部 cwd 与危险命令是两个连续分支**

```ts
test("bash authorizes external cwd before asking for a dangerous command", async () => {
  const approved: PermissionRule[] = [];
  const interactions = new RecordingInteractions([
    { kind: "always" },
    { kind: "once" },
  ]);

  const result = await decidePermission(bashEvent("rm file.txt"), {
    cwd: OUTSIDE,
    trustedDirectories: [PROJECT],
    approved,
    interactions,
  });

  assert.deepEqual(result, { kind: "allow" });
  assert.deepEqual(
    interactions.requests.map((request) => request.kind),
    ["external-directory", "dangerous-command"],
  );
  assert.deepEqual(approved, [
    { kind: "directory", directory: OUTSIDE },
  ]);
});
```

- [ ] **Step 6: 验证 Permission**

```powershell
npx tsc --ignoreConfig --outDir .tmp/events-plan --rootDir . --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax --skipLibCheck --types node src/core/events/types.ts src/core/agent/tools/events.ts src/coding-agent/interaction/interactions.ts src/coding-agent/events/permission/bash-policy.ts src/coding-agent/events/permission/permission.ts tests/coding-agent/events/permission/permission.test.ts
node --test .tmp/events-plan/tests/coding-agent/events/permission/permission.test.js
```

Expected: Permission 测试全部通过，测试不访问任何内部规则对象。

---

### Task 3: 由 createBuiltinEvents 装配默认 Permission listener

**Files:**
- Rewrite: `src/coding-agent/events/factory.ts`
- Rewrite: `tests/coding-agent/events/factory.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `decidePermission()` 与 `PermissionRule`。
- Produces:

```ts
export function createBuiltinEvents(options: {
  readonly interactions: Interactions;
  readonly approved: PermissionRule[];
  readonly trustedDirectories: readonly string[];
  readonly getSessionCwd: (sessionId: string) => string | undefined;
  readonly onListenerError?: (
    error: unknown,
    name: string,
    input: unknown,
  ) => void;
}): Events;
```

这个 options 是有意保留的组合根参数：它直接暴露 Project 状态、Project 配置、Session 查询和 Interaction，不再把它们藏进 Environment。

- [ ] **Step 1: 把 factory 测试从 deny-all 改成真实数据流**

新的 harness 必须显式接收 `interactions: Interactions`，不得通过 `NO_INTERACTIONS` 或其他默认 adapter 补全。使用：

```ts
const approved: PermissionRule[] = [];
const cwdBySession = new Map([
  ["session-a", "/project"],
  ["session-b", "/project"],
]);
const events = createBuiltinEvents({
  interactions,
  approved,
  trustedDirectories: ["/project"],
  getSessionCwd: (sessionId) => cwdBySession.get(sessionId),
  ...(onListenerError === undefined ? {} : { onListenerError }),
});
```

删除证明 TODO 占位行为的两个旧测试。添加：safe Bash 到达 Tool；hard deny 截断后续 listener 与 Tool；缺失 session cwd 返回 `Permission request failed: session not registered`；session-a 的 always 被 session-b 复用；`onListenerError` 仍透传。

- [ ] **Step 2: 运行编译，确认旧 positional API 失败**

```powershell
npx tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax --skipLibCheck --types node src/core/events/events.ts src/core/events/types.ts src/core/agent/tools/types.ts src/core/agent/tools/events.ts src/core/agent/tools/registry.ts src/coding-agent/interaction/interactions.ts src/coding-agent/events/permission/bash-policy.ts src/coding-agent/events/permission/permission.ts src/coding-agent/events/factory.ts tests/coding-agent/events/factory.test.ts
```

Expected: FAIL，factory 仍使用旧 positional 参数并永久 deny。

- [ ] **Step 3: 实现组合根**

```ts
export function createBuiltinEvents(options: {
  readonly interactions: Interactions;
  readonly approved: PermissionRule[];
  readonly trustedDirectories: readonly string[];
  readonly getSessionCwd: (sessionId: string) => string | undefined;
  readonly onListenerError?: (
    error: unknown,
    name: string,
    input: unknown,
  ) => void;
}): Events {
  const events = new Events(options.onListenerError);

  events.on("tools/pre-execute", async (input, proceed, signal) => {
    const cwd = options.getSessionCwd(input.sessionId);
    if (cwd === undefined) {
      return {
        kind: "deny",
        reason: "Permission request failed: session not registered",
      };
    }

    const decision = await decidePermission(
      input,
      {
        cwd,
        trustedDirectories: options.trustedDirectories,
        approved: options.approved,
        interactions: options.interactions,
      },
      signal,
    );
    return decision.kind === "allow" ? proceed(input) : decision;
  });

  return events;
}
```

`createBuiltinEvents()` 负责 listener 装配和 `proceed()`；Permission 只返回决定，不接触 Events 链。

- [ ] **Step 4: 验证 factory**

```powershell
npx tsc --ignoreConfig --outDir .tmp/events-plan --rootDir . --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax --skipLibCheck --types node src/core/events/events.ts src/core/events/types.ts src/core/agent/tools/types.ts src/core/agent/tools/events.ts src/core/agent/tools/registry.ts src/core/harness/events.ts src/coding-agent/interaction/interactions.ts src/coding-agent/events/permission/bash-policy.ts src/coding-agent/events/permission/permission.ts src/coding-agent/events/factory.ts tests/coding-agent/events/factory.test.ts
node --test .tmp/events-plan/tests/coding-agent/events/factory.test.js
```

Expected: factory 测试全部通过。

---

### Task 4: 修复 Bash policy 两个已知误判

**Files:**
- Modify: `src/coding-agent/events/permission/bash-policy.ts`
- Modify: `tests/coding-agent/events/permission/bash-policy.test.ts`

**Interfaces:**
- Preserves: `classifyBashCommand()` 与 `hardDeniedBashReason()`。
- Changes: `rm --recursive --force /` hard deny；`echo sudo` 不再因包含单词而 deny。

- [ ] **Step 1: 增加失败回归测试**

hard-deny commands 增加 `rm --recursive --force /` 和 `rm --force --recursive /*`；ordinary commands 增加 `echo sudo` 和 `printf 'sudo is disabled'`。

- [ ] **Step 2: 运行测试确认失败**

```powershell
npx tsc --ignoreConfig --outDir .tmp/events-plan --rootDir . --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --verbatimModuleSyntax --skipLibCheck --types node src/coding-agent/events/permission/bash-policy.ts tests/coding-agent/events/permission/bash-policy.test.ts
node --test .tmp/events-plan/tests/coding-agent/events/permission/bash-policy.test.js
```

- [ ] **Step 3: 收紧当前启发式规则**

把 sudo 限制到命令起点或 shell 控制运算符之后：

```ts
{ pattern: /(?:^|[;&|]\s*)sudo(?:\s|$)/i, reason: "sudo is not allowed" }
```

扩展 root delete flags：

```ts
const recursive = shortFlags.includes("r") || tokens.includes("--recursive");
const forced = shortFlags.includes("f") || tokens.includes("--force");
```

这只修复可验证的启发式错误，不宣称完整解析 Bash；强边界仍需要 OS sandbox。

- [ ] **Step 4: 重新运行 Step 2，预期全部通过**

---

### Task 5: 同步设计文档并执行目标范围回归

**Files:**
- Modify: `docs/superpowers/specs/2026-08-17-permission-events-interactions-design.md`
- Verify: Task 1-4 的源码与测试

- [ ] **Step 1: 更新状态生命周期与装配职责**

把 §7.3 改为：

```markdown
`approved` 由 Project 创建并保存在内存中，同一 Project 的 Session 共享。Permission 不拥有该
数组，只在 `always` 时追加当前请求生成的规则。Project 实例释放或进程退出后规则消失；当前阶段
不落盘。可信目录来自 Project 配置，不写入 `approved`。
```

同步修改 §5：删除公共 `PermissionOperation`、`external-directory.operation` 和 `NO_INTERACTIONS` 默认实现；说明外部 adapter 通过原始 `call`、目标路径、授权目录与 reason 展示请求，装配方必须显式提供 `Interactions`。

把 §9 的 Permission 职责改为“计算策略并更新外部批准数组”；把 §11 改为当前阶段由 `createBuiltinEvents()` 接收装配数据并注册完整 listener，不再保留“Project 阶段再接线”的 TODO。

- [ ] **Step 2: 扫描废弃概念**

```powershell
rg -n "PermissionEnvironment|ResolvePermissionEnvironment|PermissionRules|NO_INTERACTIONS|TODO\(project\)|unused until" src/coding-agent/events src/coding-agent/interaction tests/coding-agent/events tests/coding-agent/interaction docs/superpowers/specs/2026-08-17-permission-events-interactions-design.md
```

Expected: 无残留环境抽象、公开规则容器、默认 Interaction adapter 或 deny-all TODO。另行检查 `interaction/interactions.ts` 的 `external-directory` 分支不含 `operation`；Permission 内部的私有 `PermissionOperation` 可以存在。

- [ ] **Step 3: 隔离编译完整目标范围**

```powershell
npx tsc --ignoreConfig --outDir .tmp/events-plan --rootDir . --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node src/core/events/events.ts src/core/events/types.ts src/core/agent/types.ts src/core/agent/tools/types.ts src/core/agent/tools/events.ts src/core/agent/tools/registry.ts src/core/agent/events.ts src/core/harness/events.ts src/coding-agent/interaction/interactions.ts src/coding-agent/events/permission/bash-policy.ts src/coding-agent/events/permission/permission.ts src/coding-agent/events/factory.ts tests/coding-agent/interaction/interactions.test.ts tests/coding-agent/events/permission/bash-policy.test.ts tests/coding-agent/events/permission/permission.test.ts tests/coding-agent/events/factory.test.ts
```

Expected: 无 TypeScript 错误。全仓其他待清理模块不作为本计划完成条件。

- [ ] **Step 4: 运行目标范围全部测试**

```powershell
node --test .tmp/events-plan/tests/coding-agent/interaction/interactions.test.js .tmp/events-plan/tests/coding-agent/events/permission/bash-policy.test.js .tmp/events-plan/tests/coding-agent/events/permission/permission.test.js .tmp/events-plan/tests/coding-agent/events/factory.test.js
```

Expected: 四个测试文件全部通过，无失败、跳过或取消。

- [ ] **Step 5: 检查范围**

```powershell
git status --short
git diff -- src/coding-agent/events src/coding-agent/interaction tests/coding-agent/events tests/coding-agent/interaction docs/superpowers/specs/2026-08-17-permission-events-interactions-design.md
```

Expected: 实现改动仅位于本计划 File Map，不修改 Project、Tool、core 或 UI。
