# Coding Agent Built-in Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the UI-coupled coding-agent ToolDefinition layer with six bounded, UI-independent Core AgentTool implementations and a fresh built-in registry factory.

**Architecture:** Each built-in is a direct `AgentTool` whose constructor captures only the Session cwd it needs. Shared code is limited to pure path resolution and bounded text output; Permission remains an external `tools/pre-execute` concern and Project wiring is deliberately deferred until Permission exists.

**Tech Stack:** Node.js 24, TypeScript 7 with NodeNext ESM, TypeBox 1.3.6, `node:test`, `node:fs/promises.glob`, and the existing Core `AgentTool`, `AgentToolResult`, and `AgentToolRegistry`.

## Global Constraints

- Approved specification: `docs/superpowers/specs/2026-08-17-built-in-tools-design.md`.
- Implement exactly six tools named `bash`, `read_file`, `write_file`, `edit_file`, `glob`, and `todo_write`.
- Tool code must not import UI, Events, Permission, Project, Session, Harness, or a future plugin API.
- Keep `AgentTool.execute(arguments_, signal)` unchanged; do not add an execution Context or `ask()` capability.
- Resolve paths from the captured Session cwd, but do not enforce a Project-directory boundary inside Tool code.
- Do not implement external-directory or dangerous-command Permission in this plan.
- Do not connect the registry factory to `Project`; the Project must keep its empty registry until the Permission plan safely integrates both.
- Do not modify `src/coding-agent/events/`, `src/coding-agent/project/`, `src/coding-agent/ui/`, Core Agent, Harness, Session, the outer legacy coding-agent factory, public entry points, or README files.
- Leave `src/coding-agent/tools/builtin/bash/bash-policy.ts` in place because the untouched legacy Permission listener still imports it; the Permission plan will relocate or delete it.
- Do not retain `ToolDefinition`, `CodingToolContext`, `CodingAgentToolAdapter`, `toAgentTool()`, or Tool-owned presentation callbacks.
- Bash, Read, and Glob text output is at most 2,000 lines and 50 KiB UTF-8. Bash retains the tail; Read retains content from its requested offset.
- Glob returns at most 1,000 sorted unique paths and also obeys the 50 KiB limit.
- Todo accepts at most 50 items and 200 characters per item so its complete content and details never require truncation.
- Every `details` value must be JSON-safe and contain execution facts rather than display state.
- Use TDD for every task and commit only the exact files named by that task.
- Add no dependencies.
- The untouched outer coding-agent is already in migration and may remain uncompilable. Use only the isolated verification commands in this plan.

## File Map

**Create:**

- `src/coding-agent/tools/resolve-path.ts` — resolve a Tool path from Session cwd without policy.
- `src/coding-agent/tools/output.ts` — bounded head/tail text selection and metrics.
- `src/coding-agent/tools/builtin/read-file.ts` — file and directory reads with offset/limit.
- `src/coding-agent/tools/builtin/write-file.ts` — complete create/overwrite writes.
- `src/coding-agent/tools/builtin/edit-file.ts` — unique exact replacement.
- `src/coding-agent/tools/builtin/glob.ts` — deterministic bounded globbing.
- `tests/coding-agent/tools/output.test.ts`
- `tests/coding-agent/tools/resolve-path.test.ts`
- `tests/coding-agent/tools/builtin/read-file.test.ts`
- `tests/coding-agent/tools/builtin/write-file.test.ts`
- `tests/coding-agent/tools/builtin/edit-file.test.ts`
- `tests/coding-agent/tools/builtin/glob.test.ts`
- `tests/coding-agent/tools/factory.test.ts`

**Rewrite:**

- `src/coding-agent/tools/builtin/bash/bash.ts` — direct AgentTool and bounded merged output.
- `src/coding-agent/tools/builtin/todo.ts` — direct stateless AgentTool without presentation.
- `src/coding-agent/tools/factory.ts` — one `createBuiltinToolRegistry(cwd)` entry point.
- `tests/coding-agent/tools/builtin/bash.test.ts`
- `tests/coding-agent/tools/builtin/todo.test.ts`

**Delete:**

- `src/coding-agent/tools/definition.ts`
- `src/coding-agent/tools/builtin/files.ts`
- `tests/coding-agent/tools/definition.test.ts`
- `tests/coding-agent/tools/builtin/files.test.ts`

---

## Isolated Verification

After all tasks, compile only the new Tools dependency graph and its tests:

```powershell
npm run clean
npx tsc --ignoreConfig --outDir dist --rootDir . --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node src/coding-agent/tools/factory.ts tests/coding-agent/tools/resolve-path.test.ts tests/coding-agent/tools/output.test.ts tests/coding-agent/tools/builtin/bash.test.ts tests/coding-agent/tools/builtin/read-file.test.ts tests/coding-agent/tools/builtin/write-file.test.ts tests/coding-agent/tools/builtin/edit-file.test.ts tests/coding-agent/tools/builtin/glob.test.ts tests/coding-agent/tools/builtin/todo.test.ts tests/coding-agent/tools/factory.test.ts
node --test "dist/tests/coding-agent/tools/**/*.test.js"
```

Expected final result: TypeScript exits `0`; Node reports all isolated Tool tests passing.

### Task 1: Pure path and bounded-output helpers

**Files:**

- Create: `src/coding-agent/tools/resolve-path.ts`
- Create: `src/coding-agent/tools/output.ts`
- Create: `tests/coding-agent/tools/resolve-path.test.ts`
- Create: `tests/coding-agent/tools/output.test.ts`

**Interfaces:**

- Produces: `resolveToolPath(cwd: string, input: string): string`.
- Produces: `truncateHead(text: string)` and `truncateTail(text: string)` returning `content`, `truncated`, `totalLines`, `shownLines`, `totalBytes`, and `shownBytes`.
- Produces: `MAX_OUTPUT_LINES = 2000` and `MAX_OUTPUT_BYTES = 50 * 1024`.

- [ ] **Step 1: Write failing path tests**

Create `resolve-path.test.ts` with these assertions:

```ts
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveToolPath } from "../../../src/coding-agent/tools/resolve-path.js";

test("resolveToolPath resolves relative, parent, and absolute input without policy", () => {
  const cwd = resolve("C:/work/project/src");
  assert.equal(resolveToolPath(cwd, "index.ts"), join(cwd, "index.ts"));
  assert.equal(resolveToolPath(cwd, "../README.md"), resolve(cwd, "../README.md"));
  const outside = resolve("C:/outside/file.txt");
  assert.equal(resolveToolPath(cwd, outside), outside);
});
```

- [ ] **Step 2: Write failing bounded-output tests**

Create `output.test.ts`. Cover exact-limit output, 2,001 lines, more than 50 KiB of multibyte UTF-8, empty text, head retention, and tail retention:

```ts
test("head and tail retain opposite ends and report metrics", () => {
  const text = Array.from({ length: 2001 }, (_, index) => `line-${index + 1}`).join("\n");
  const head = truncateHead(text);
  const tail = truncateTail(text);
  assert.equal(head.truncated, true);
  assert.equal(head.totalLines, 2001);
  assert.equal(head.shownLines, 2000);
  assert.match(head.content, /^line-1\n/);
  assert.doesNotMatch(head.content, /line-2001$/);
  assert.match(tail.content, /^line-2\n/);
  assert.match(tail.content, /line-2001$/);
  assert.ok(head.shownBytes <= MAX_OUTPUT_BYTES);
  assert.ok(tail.shownBytes <= MAX_OUTPUT_BYTES);
});

test("byte truncation never emits invalid UTF-8", () => {
  const result = truncateHead("目录".repeat(20_000));
  assert.equal(result.truncated, true);
  assert.ok(result.shownBytes <= MAX_OUTPUT_BYTES);
  assert.equal(Buffer.from(result.content, "utf8").toString("utf8"), result.content);
});
```

- [ ] **Step 3: Compile to verify the tests fail**

Run:

```powershell
npx tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node tests/coding-agent/tools/resolve-path.test.ts tests/coding-agent/tools/output.test.ts
```

Expected: FAIL because both source modules are missing.

- [ ] **Step 4: Implement the path helper**

Create exactly this policy-free implementation:

```ts
import { resolve } from "node:path";

export function resolveToolPath(cwd: string, input: string): string {
  return resolve(cwd, input);
}
```

- [ ] **Step 5: Implement bounded head/tail selection**

In `output.ts`, export the two constants and two functions. Use `Buffer.from(text, "utf8")` for byte accounting. First limit by line direction, then trim the UTF-8 buffer from the same direction, moving the byte boundary past continuation bytes before decoding. Compute metrics from the final decoded content:

```ts
export const MAX_OUTPUT_LINES = 2_000;
export const MAX_OUTPUT_BYTES = 50 * 1024;

export function truncateHead(text: string) {
  return truncate(text, "head");
}

export function truncateTail(text: string) {
  return truncate(text, "tail");
}
```

The private `truncate()` must treat empty text as zero lines, preserve at most 2,000 selected lines, preserve at most 50 KiB, and set `truncated` when either the line or byte boundary removed content. Do not export a named result interface.

- [ ] **Step 6: Run helper tests**

Run:

```powershell
npx tsc --ignoreConfig --outDir dist --rootDir . --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node src/coding-agent/tools/resolve-path.ts src/coding-agent/tools/output.ts tests/coding-agent/tools/resolve-path.test.ts tests/coding-agent/tools/output.test.ts
node --test "dist/tests/coding-agent/tools/resolve-path.test.js" "dist/tests/coding-agent/tools/output.test.js"
```

Expected: all helper tests PASS.

- [ ] **Step 7: Commit the helpers**

```powershell
git add -- src/coding-agent/tools/resolve-path.ts src/coding-agent/tools/output.ts tests/coding-agent/tools/resolve-path.test.ts tests/coding-agent/tools/output.test.ts
git commit -m "feat: add built-in tool execution helpers"
```

### Task 2: Direct Bash AgentTool

**Files:**

- Rewrite: `src/coding-agent/tools/builtin/bash/bash.ts`
- Rewrite: `tests/coding-agent/tools/builtin/bash.test.ts`

**Interfaces:**

- Consumes: `truncateTail(text)` from Task 1.
- Produces: `createBashTool(cwd: string, executeBash?: (command: string, cwd: string, signal: AbortSignal) => Promise<{ output: string; exitCode: number | null }>): AgentTool`.
- Produces: `BashToolDetails` with `exitCode`, `truncated`, `totalLines`, `shownLines`, `totalBytes`, and `shownBytes`.

- [ ] **Step 1: Replace legacy tests with direct-AgentTool tests**

Use a recording injected backend returning `{ output, exitCode }`. Test metadata/schema, configured cwd, merged result formatting, empty output, nonzero exit, null exit, truncation, UTF-8, backend rejection, and an already-aborted signal. Include these core assertions:

```ts
const calls: Array<{ command: string; cwd: string }> = [];
const tool = createBashTool("C:/work", async (command, cwd) => {
  calls.push({ command, cwd });
  return { output: "executed", exitCode: 0 };
});
assert.equal(tool.name, "bash");
assert.deepEqual(await tool.execute({ command: "pwd" }, signal()), {
  content: "executed",
  details: {
    exitCode: 0,
    truncated: false,
    totalLines: 1,
    shownLines: 1,
    totalBytes: 8,
    shownBytes: 8,
  },
  isError: false,
});
assert.deepEqual(calls, [{ command: "pwd", cwd: resolve("C:/work") }]);

const failure = createBashTool("C:/work", async () => ({
  output: "bad output",
  exitCode: 7,
}));
const failed = await failure.execute({ command: "exit 7" }, signal());
assert.equal(failed.isError, true);
assert.match(failed.content, /bad output/);
assert.match(failed.content, /code 7/);
```

Delete every assertion that Bash blocks sudo, rm, chmod, device access, or any other command. Those are Permission tests, not Tool tests.

- [ ] **Step 2: Compile to verify legacy Bash fails the new contract**

Run:

```powershell
npx tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node src/coding-agent/tools/output.ts src/coding-agent/tools/builtin/bash/bash.ts tests/coding-agent/tools/builtin/bash.test.ts
```

Expected: FAIL because `createBashTool` and `BashToolDetails` do not exist.

- [ ] **Step 3: Implement the direct Bash Tool**

Define TypeBox parameters with exactly `command: Type.String({ minLength: 1 })`. Add an internal `BashTool extends AgentTool<typeof parameters, BashToolDetails>` whose constructor captures `resolve(cwd)` and the injected backend.

The execution method must:

```ts
const executed = await this.executeBash(arguments_.command, this.cwd, signal);
const selected = truncateTail(executed.output);
const output = selected.content === "" ? "(no output)" : selected.content;
const status = executed.exitCode === 0
  ? output
  : `${output}\n\nCommand exited with code ${String(executed.exitCode)}`;
return {
  content: selected.truncated
    ? `${status}\n\n[Output truncated: showing ${selected.shownLines} of ${selected.totalLines} lines and ${selected.shownBytes} of ${selected.totalBytes} bytes]`
    : status,
  details: {
    exitCode: executed.exitCode,
    truncated: selected.truncated,
    totalLines: selected.totalLines,
    shownLines: selected.shownLines,
    totalBytes: selected.totalBytes,
    shownBytes: selected.shownBytes,
  },
  isError: executed.exitCode !== 0,
};
```

Implement the default backend with the existing Git-Bash discovery behavior. Push stdout and stderr chunks into one array from both `data` listeners so arrival order is retained. Spawn with the captured cwd, `windowsHide: true`, and the supplied signal. Resolve on `close` with output and exit code; reject on `error`. Do not import `bash-policy.ts`.

- [ ] **Step 4: Run Bash tests**

Compile `bash.ts`, `output.ts`, and `bash.test.ts` to `dist`, then run:

```powershell
node --test "dist/tests/coding-agent/tools/builtin/bash.test.js"
```

Expected: all Bash tests PASS.

- [ ] **Step 5: Verify Bash has no policy or UI dependency**

Run:

```powershell
rg -n "bash-policy|Permission|Events|presentation|ui/|interactions" src/coding-agent/tools/builtin/bash/bash.ts
```

Expected: no matches.

- [ ] **Step 6: Commit Bash**

```powershell
git add -- src/coding-agent/tools/builtin/bash/bash.ts tests/coding-agent/tools/builtin/bash.test.ts
git commit -m "feat: rebuild bash as a direct agent tool"
```

### Task 3: Read file and directory Tool

**Files:**

- Create: `src/coding-agent/tools/builtin/read-file.ts`
- Create: `tests/coding-agent/tools/builtin/read-file.test.ts`

**Interfaces:**

- Consumes: `resolveToolPath()` and `truncateHead()` from Task 1.
- Produces: `createReadFileTool(cwd: string): AgentTool`.
- Produces: `ReadFileDetails` with absolute `path`, `kind`, `offset`, `total`, `returned`, and `truncated`.

- [ ] **Step 1: Write failing read tests**

Use one `mkdtemp()` cwd and clean it in `finally`. Cover:

1. a relative text file with default offset/limit;
2. one-based offset and limit;
3. offset after EOF;
4. a file exceeding 50 KiB;
5. an empty file;
6. an empty directory;
7. a directory with deterministic sorted direct entries and `/` on directories;
8. directory pagination;
9. an absolute path outside cwd, proving Tool does not enforce Project policy;
10. a missing path returning `isError: true`.

The external-path assertion must be explicit:

```ts
const outside = await mkdtemp(join(tmpdir(), "kea-read-outside-"));
await writeFile(join(outside, "note.txt"), "outside", "utf8");
const result = await createReadFileTool(cwd).execute(
  { path: join(outside, "note.txt") },
  signal(),
);
assert.equal(result.content, "outside");
assert.equal(result.isError, false);
```

- [ ] **Step 2: Compile to verify the read module is missing**

Run:

```powershell
npx tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node src/coding-agent/tools/resolve-path.ts src/coding-agent/tools/output.ts tests/coding-agent/tools/builtin/read-file.test.ts
```

Expected: FAIL because `read-file.ts` does not exist.

- [ ] **Step 3: Implement ReadFileTool**

Use this exact schema:

```ts
const parameters = Type.Object({
  path: Type.String({ minLength: 1 }),
  offset: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_OUTPUT_LINES })),
}, { additionalProperties: false });
```

Resolve once with `resolveToolPath(this.cwd, arguments_.path)`, then `stat()` it. For a file, read UTF-8, split CRLF/LF consistently, slice from `offset - 1` for `limit ?? 2000`, and apply `truncateHead()` for the byte limit. For a directory, call `readdir(path, { withFileTypes: true })`, append `/` to directory names, sort with a locale-independent comparator, apply the same offset/limit, then apply `truncateHead()` to the joined entries. Set details `truncated` when pagination or byte limiting removed content. Catch filesystem errors and return `Error: Unable to read <absolute path>: <message>` with `isError: true`.

Do not recurse, detect Project containment, ask Permission, or import UI.

- [ ] **Step 4: Run read tests**

Compile the helper modules, `read-file.ts`, and its test, then run:

```powershell
node --test "dist/tests/coding-agent/tools/builtin/read-file.test.js"
```

Expected: all read tests PASS.

- [ ] **Step 5: Commit ReadFileTool**

```powershell
git add -- src/coding-agent/tools/builtin/read-file.ts tests/coding-agent/tools/builtin/read-file.test.ts
git commit -m "feat: add bounded read file tool"
```

### Task 4: Write file Tool

**Files:**

- Create: `src/coding-agent/tools/builtin/write-file.ts`
- Create: `tests/coding-agent/tools/builtin/write-file.test.ts`

**Interfaces:**

- Consumes: `resolveToolPath()` from Task 1.
- Produces: `createWriteFileTool(cwd: string): AgentTool`.
- Produces: `WriteFileDetails` with absolute `path`, `bytes`, and `created`.

- [ ] **Step 1: Write failing write tests**

Cover recursive parent creation, UTF-8 byte count, overwrite versus create, empty content, an absolute outside-cwd target, and a filesystem failure. Assert both content and details:

```ts
const created = await tool.execute(
  { path: "nested/example.txt", content: "目录" },
  signal(),
);
assert.equal(created.content, "Created nested/example.txt (6 bytes)");
assert.deepEqual(created.details, {
  path: join(cwd, "nested", "example.txt"),
  bytes: 6,
  created: true,
});

const overwritten = await tool.execute(
  { path: "nested/example.txt", content: "next" },
  signal(),
);
assert.equal(overwritten.content, "Overwrote nested/example.txt (4 bytes)");
assert.equal(overwritten.details?.created, false);
```

- [ ] **Step 2: Compile to verify the write module is missing**

Run:

```powershell
npx tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node src/coding-agent/tools/resolve-path.ts tests/coding-agent/tools/builtin/write-file.test.ts
```

Expected: FAIL because `write-file.ts` does not exist.

- [ ] **Step 3: Implement WriteFileTool**

Use an exact `{ path, content }` TypeBox object. Resolve the target, determine `created` with `stat()` while treating only `ENOENT` as absent, create `dirname(target)` recursively, and call `writeFile(target, content, "utf8")`. Return the exact content and details tested above. Convert filesystem failure into an `isError: true` result naming the absolute target.

The concrete Tool boundary must have this shape:

```ts
const parameters = Type.Object({
  path: Type.String({ minLength: 1 }),
  content: Type.String(),
}, { additionalProperties: false });

class WriteFileTool extends AgentTool<typeof parameters, WriteFileDetails> {
  constructor(private readonly cwd: string) {
    super("write_file", "Write complete content to a file.", parameters);
  }
}

export function createWriteFileTool(cwd: string): AgentTool<typeof parameters, WriteFileDetails> {
  return new WriteFileTool(resolve(cwd));
}
```

Do not perform a Project boundary check and do not call `safePath()`.

- [ ] **Step 4: Run write tests and commit**

Run:

```powershell
npx tsc --ignoreConfig --outDir dist --rootDir . --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node src/coding-agent/tools/resolve-path.ts src/coding-agent/tools/builtin/write-file.ts tests/coding-agent/tools/builtin/write-file.test.ts
node --test "dist/tests/coding-agent/tools/builtin/write-file.test.js"
```

Expected: all write tests PASS.

```powershell
git add -- src/coding-agent/tools/builtin/write-file.ts tests/coding-agent/tools/builtin/write-file.test.ts
git commit -m "feat: add complete write file tool"
```

### Task 5: Unique exact edit Tool

**Files:**

- Create: `src/coding-agent/tools/builtin/edit-file.ts`
- Create: `tests/coding-agent/tools/builtin/edit-file.test.ts`

**Interfaces:**

- Consumes: `resolveToolPath()` from Task 1.
- Produces: `createEditFileTool(cwd: string): AgentTool`.
- Produces: `EditFileDetails` with absolute `path` and `replacements: 1`.

- [ ] **Step 1: Write failing edit tests**

Cover exactly one match, zero matches, multiple matches, overlapping matches such as old text `aa` in `aaa`, empty `old_text` schema rejection through `tool.validate()`, an absolute outside-cwd target, and a missing file. Verify every zero/multiple failure leaves the original file unchanged.

```ts
const tool = createEditFileTool(cwd);
assert.ok(tool.validate({ path: "a.txt", old_text: "", new_text: "x" }));

await writeFile(join(cwd, "a.txt"), "before unique after", "utf8");
const result = await tool.execute(
  { path: "a.txt", old_text: "unique", new_text: "changed" },
  signal(),
);
assert.equal(result.content, "Edited a.txt (1 replacement)");
assert.deepEqual(result.details, {
  path: join(cwd, "a.txt"),
  replacements: 1,
});
```

- [ ] **Step 2: Compile to verify the edit module is missing**

Run:

```powershell
npx tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node src/coding-agent/tools/resolve-path.ts tests/coding-agent/tools/builtin/edit-file.test.ts
```

Expected: FAIL because `edit-file.ts` does not exist.

- [ ] **Step 3: Implement EditFileTool**

Use `old_text: Type.String({ minLength: 1 })`. Find the first match with `indexOf(old_text)` and search for a second starting at `first + 1` so overlapping matches are considered ambiguous. Return an error without writing for zero or multiple matches. For one match, assemble prefix + `new_text` + suffix and write UTF-8 once. Catch filesystem errors into an error result naming the absolute path.

Use this concrete schema and factory boundary:

```ts
const parameters = Type.Object({
  path: Type.String({ minLength: 1 }),
  old_text: Type.String({ minLength: 1 }),
  new_text: Type.String(),
}, { additionalProperties: false });

export function createEditFileTool(cwd: string): AgentTool<typeof parameters, EditFileDetails> {
  return new EditFileTool(resolve(cwd));
}
```

Do not silently replace the first of several matches and do not implement fuzzy matching.

- [ ] **Step 4: Run edit tests and commit**

Run:

```powershell
npx tsc --ignoreConfig --outDir dist --rootDir . --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node src/coding-agent/tools/resolve-path.ts src/coding-agent/tools/builtin/edit-file.ts tests/coding-agent/tools/builtin/edit-file.test.ts
node --test "dist/tests/coding-agent/tools/builtin/edit-file.test.js"
```

Expected: all edit tests PASS.

```powershell
git add -- src/coding-agent/tools/builtin/edit-file.ts tests/coding-agent/tools/builtin/edit-file.test.ts
git commit -m "feat: add unique exact edit tool"
```

### Task 6: Deterministic bounded Glob Tool

**Files:**

- Create: `src/coding-agent/tools/builtin/glob.ts`
- Create: `tests/coding-agent/tools/builtin/glob.test.ts`

**Interfaces:**

- Produces: `createGlobTool(cwd: string): AgentTool`.
- Produces: `GlobDetails` with `total`, `returned`, `bytes`, and `truncated`.

- [ ] **Step 1: Write failing glob tests**

Cover no matches, slash normalization, deterministic sorting independent of creation order, duplicate elimination, more than 1,000 matches, a `../` pattern that reaches outside cwd, and an invalid glob/filesystem failure.

```ts
const result = await createGlobTool(cwd).execute(
  { pattern: "**/*.txt" },
  signal(),
);
assert.equal(result.content, ["a.txt", "nested/b.txt"].join("\n"));
assert.deepEqual(result.details, {
  total: 2,
  returned: 2,
  bytes: Buffer.byteLength("a.txt\nnested/b.txt", "utf8"),
  truncated: false,
});
```

For the limit case, create files `item-0000.txt` through `item-1000.txt`, assert 1,000 output lines, `total: 1001`, `returned: 1000`, `truncated: true`, and a model-visible truncation footer.

- [ ] **Step 2: Compile to verify the glob module is missing**

Run:

```powershell
npx tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node tests/coding-agent/tools/builtin/glob.test.ts
```

Expected: FAIL because `glob.ts` does not exist.

- [ ] **Step 3: Implement GlobTool**

Use an exact `{ pattern: Type.String({ minLength: 1 }) }` schema. Iterate `glob(pattern, { cwd: this.cwd })`, convert every match to an absolute path with `resolve(this.cwd, match)`, then back to `relative(this.cwd, absolute)` and replace `sep` with `/`. Add paths to a Set and sort with `(left, right) => left < right ? -1 : left > right ? 1 : 0`. Starting from the first sorted path, append entries while both the 1,000-entry limit and 50 KiB UTF-8 limit remain satisfied. Append `[Showing M of N matches]` when either limit truncates output. Return `(no matches)` for zero results. Catch failures into `isError: true`.

Use this concrete Tool boundary:

```ts
const parameters = Type.Object({
  pattern: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

class GlobTool extends AgentTool<typeof parameters, GlobDetails> {
  constructor(private readonly cwd: string) {
    super("glob", "Find paths matching a glob pattern.", parameters);
  }
}

export function createGlobTool(cwd: string): AgentTool<typeof parameters, GlobDetails> {
  return new GlobTool(resolve(cwd));
}
```

Do not call `safePath()` and do not add Project awareness.

- [ ] **Step 4: Run glob tests and commit**

Run:

```powershell
npx tsc --ignoreConfig --outDir dist --rootDir . --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node src/coding-agent/tools/builtin/glob.ts tests/coding-agent/tools/builtin/glob.test.ts
node --test "dist/tests/coding-agent/tools/builtin/glob.test.js"
```

Expected: all glob tests PASS.

```powershell
git add -- src/coding-agent/tools/builtin/glob.ts tests/coding-agent/tools/builtin/glob.test.ts
git commit -m "feat: add deterministic glob tool"
```

### Task 7: Stateless TodoWrite AgentTool

**Files:**

- Rewrite: `src/coding-agent/tools/builtin/todo.ts`
- Rewrite: `tests/coding-agent/tools/builtin/todo.test.ts`

**Interfaces:**

- Produces: `createTodoWriteTool(): AgentTool`.
- Preserves: exported `TodoItem` and `TodoDetails` result data types.

- [ ] **Step 1: Rewrite tests for the direct Tool**

Update tests to call `createTodoWriteTool()` with only arguments and signal. Cover full content/details, a second call replacing rather than merging state, an empty list, defensive copying, valid statuses, extra-property rejection, empty content rejection, more than 50 items, and content longer than 200 characters through `validate()`.

```ts
const tool = createTodoWriteTool();
const input = {
  todos: [
    { content: "Read code", status: "completed" as const },
    { content: "Add tests", status: "pending" as const },
  ],
};
const result = await tool.execute(input, signal());
input.todos[0] = { content: "mutated", status: "pending" };
assert.deepEqual(result.details, {
  todos: [
    { content: "Read code", status: "completed" },
    { content: "Add tests", status: "pending" },
  ],
});
```

- [ ] **Step 2: Compile to verify the old ToolDefinition API fails**

Run:

```powershell
npx tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node src/coding-agent/tools/builtin/todo.ts tests/coding-agent/tools/builtin/todo.test.ts
```

Expected: FAIL because `createTodoWriteTool()` does not exist and the old module imports `ToolDefinition` plus UI presentation behavior.

- [ ] **Step 3: Implement TodoWriteTool directly**

Keep the existing status literals. Change item content to `Type.String({ minLength: 1, maxLength: 200 })`, set `maxItems: 50` on the todos array, and set `additionalProperties: false` on both item and outer object. Implement an internal direct `AgentTool` subclass. Map every input item to a fresh `{ content, status }` object, return the complete numbered content and `{ todos }`, and keep no mutable Tool state.

Use this concrete array constraint and factory boundary:

```ts
const todoItemParameters = Type.Object({
  content: Type.String({ minLength: 1, maxLength: 200 }),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
  ]),
}, { additionalProperties: false });

const parameters = Type.Object({
  todos: Type.Array(todoItemParameters, { maxItems: 50 }),
}, { additionalProperties: false });

class TodoWriteTool extends AgentTool<typeof parameters, TodoDetails> {
  constructor() {
    super("todo_write", "Replace the current complete task list.", parameters);
  }
}

export function createTodoWriteTool(): AgentTool<typeof parameters, TodoDetails> {
  return new TodoWriteTool();
}
```

Delete `isTodoDetails()` and the entire `presentation` property. Empty arrays return:

```text
Current tasks:
Updated 0 tasks
```

- [ ] **Step 4: Run todo tests and verify UI independence**

Run:

```powershell
npx tsc --ignoreConfig --outDir dist --rootDir . --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node src/coding-agent/tools/builtin/todo.ts tests/coding-agent/tools/builtin/todo.test.ts
node --test "dist/tests/coding-agent/tools/builtin/todo.test.js"
```

Then run:

```powershell
rg -n "presentation|ui/|Events|Permission" src/coding-agent/tools/builtin/todo.ts
```

Expected: tests PASS and rg has no matches.

- [ ] **Step 5: Commit TodoWriteTool**

```powershell
git add -- src/coding-agent/tools/builtin/todo.ts tests/coding-agent/tools/builtin/todo.test.ts
git commit -m "feat: rebuild todo write as a direct agent tool"
```

### Task 8: Registry factory and legacy adapter removal

**Files:**

- Rewrite: `src/coding-agent/tools/factory.ts`
- Create: `tests/coding-agent/tools/factory.test.ts`
- Delete: `src/coding-agent/tools/definition.ts`
- Delete: `src/coding-agent/tools/builtin/files.ts`
- Delete: `tests/coding-agent/tools/definition.test.ts`
- Delete: `tests/coding-agent/tools/builtin/files.test.ts`

**Interfaces:**

- Consumes: all six `create*Tool` functions from Tasks 2–7.
- Produces: `createBuiltinToolRegistry(cwd: string): AgentToolRegistry`.

- [ ] **Step 1: Write failing factory tests**

Assert exact order, standard AgentTool instances, independent registries, independent Tool instances, and executable schemas:

```ts
const first = createBuiltinToolRegistry(process.cwd());
const second = createBuiltinToolRegistry(process.cwd());
assert.deepEqual(
  first.all().map((tool) => tool.name),
  ["bash", "read_file", "write_file", "edit_file", "glob", "todo_write"],
);
assert.notEqual(first, second);
for (let index = 0; index < first.all().length; index += 1) {
  assert.notEqual(first.all()[index], second.all()[index]);
  assert.ok(first.all()[index] instanceof AgentTool);
}
assert.equal(first.all().find((tool) => tool.name === "bash")?.validate({ command: "pwd" }), undefined);
assert.ok(first.all().find((tool) => tool.name === "read_file")?.validate({ path: 1 }));
```

- [ ] **Step 2: Compile to verify the old two-stage factory fails**

Run:

```powershell
npx tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node src/coding-agent/tools/factory.ts tests/coding-agent/tools/resolve-path.test.ts tests/coding-agent/tools/output.test.ts tests/coding-agent/tools/builtin/bash.test.ts tests/coding-agent/tools/builtin/read-file.test.ts tests/coding-agent/tools/builtin/write-file.test.ts tests/coding-agent/tools/builtin/edit-file.test.ts tests/coding-agent/tools/builtin/glob.test.ts tests/coding-agent/tools/builtin/todo.test.ts tests/coding-agent/tools/factory.test.ts
```

Expected: FAIL because the old factory exports definitions/adapters and the split source modules are not registered.

- [ ] **Step 3: Replace the factory with one direct registry constructor**

Implement exactly:

```ts
export function createBuiltinToolRegistry(cwd: string): AgentToolRegistry {
  const registry = new AgentToolRegistry();
  registry.register(createBashTool(cwd));
  registry.register(createReadFileTool(cwd));
  registry.register(createWriteFileTool(cwd));
  registry.register(createEditFileTool(cwd));
  registry.register(createGlobTool(cwd));
  registry.register(createTodoWriteTool());
  return registry;
}
```

Do not export a definitions array, context object, adapter, presentation registry, Project-aware factory, singleton, or plugin registry.

- [ ] **Step 4: Delete the complete legacy ToolDefinition boundary**

Use `apply_patch` to delete the four legacy files listed by this task. Do not edit their old outer callers; they are outside this plan and may continue failing the whole-repository build.

- [ ] **Step 5: Run all isolated Tool tests**

Run the complete commands under **Isolated Verification**.

Expected: isolated TypeScript compilation exits `0` and every Tool test PASS.

- [ ] **Step 6: Verify architectural imports and removed symbols**

Run:

```powershell
rg -n "coding-agent/(ui|events|project)|\.\./ui|\.\./events|\.\./project|Permission|CodingToolContext|ToolDefinition|toAgentTool|presentation" src/coding-agent/tools
rg -n "safePath" src/coding-agent/tools
```

Expected: the first command has no matches except the intentionally retained text inside `builtin/bash/bash-policy.ts` if any; the second has no matches. Inspect any match rather than weakening the check.

- [ ] **Step 7: Inspect the final scope**

Run:

```powershell
git status --short
git diff --check -- src/coding-agent/tools tests/coding-agent/tools
```

Expected: only Task 8 files remain uncommitted, whitespace check passes, and the pre-existing Project foundation changes remain untouched.

- [ ] **Step 8: Commit the factory migration**

```powershell
git add -- src/coding-agent/tools/factory.ts src/coding-agent/tools/definition.ts src/coding-agent/tools/builtin/files.ts tests/coding-agent/tools/factory.test.ts tests/coding-agent/tools/definition.test.ts tests/coding-agent/tools/builtin/files.test.ts
git commit -m "refactor: register built-ins as direct agent tools"
```

## Completion Check

After Task 8, confirm all specification requirements without expanding scope:

```powershell
git log --oneline -8
git status --short
```

Expected:

- eight focused implementation commits are visible after the design/plan commits;
- only the user’s pre-existing Project foundation changes remain in the worktree;
- built-ins are not yet registered by `Project`;
- no Events, Permission, UI, public export, outer factory, or README migration was performed.
