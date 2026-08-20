# Kea — Course Release Specification

Kea is a terminal coding agent implemented in TypeScript. It runs as the `kea`
command, uses layered JSON configuration, and exercises every harness mechanism
deterministically against a mock LLM. This document is written against the
course rubric and names the implementing modules and tests for each dimension.

## 1. Domain and mechanism design

Kea lets a user run an agentic coding loop in a terminal. The loop requests a
model, streams reasoning and tool calls, executes tools under governance, and
persists every complete message to a recoverable Session.

The system is layered with a strict dependency direction:

```text
ui -> coding-agent -> harness -> ai
```

All layers communicate through one shared `Events` instance per Project.
`emit()` publishes decided facts; `intercept()` wraps a pending behavior so
listeners can change it before it is committed.

- Implementing modules: `src/ui/`, `src/coding-agent/`, `src/core/harness/`,
  `src/core/events/`, `src/core/ai/`.
- Tests: `tests/events/events.test.ts`, `tests/harness/agent-loop.test.ts`.

## 2. Decision and agent loop

One Agent Run processes a user prompt across one or more Turns. Each Turn
requests the model once, persists the complete assistant message, then executes
every Tool Call in source order. The loop decides whether to continue through
`shouldContinue()`, and each Run completes with one of `completed`, `aborted`,
or `error`.

- Implementing modules: `src/core/harness/agent-loop.ts`,
  `src/core/harness/agent-harness.ts`.
- Tests: `tests/harness/agent-loop.test.ts`,
  `tests/harness/control-events.test.ts`.

## 3. Tools and environment interaction

Kea provides Bash, file read/write/edit, glob, and Todo tools. Each tool is a
`ToolDefinition` that exposes typed parameters, an executable body, and an
optional presentation. The `AgentToolRegistry` runs lookup, validation, and the
three interception stages (`tools/pre-execute`, `tools/execute`,
`tools/post-execute`).

- Implementing modules: `src/coding-agent/tools/`,
  `src/core/harness/tools/registry.ts`.
- Tests: `tests/coding-agent/tools/`, `tests/harness/tools/registry.test.ts`.

## 4. Governance and safety (main contribution)

Governance is Kea's main contribution because it is the most mechanism-heavy and
thoroughly isolated part of the harness. Each control is deterministic and
testable without a real model or shell:

- **Permission classification** — Bash commands are classified into allow, ask,
  and deny outcomes by `classifyBashCommand`.
- **Hard denies** — commands such as `sudo`, `shutdown`/`reboot`, `mkfs`,
  raw `dd` input, redirection into `/dev`, and recursive forced root deletion
  (`rm -rf /`) are rejected below the confirmation layer.
- **Ask-before-run** — `rm`, writes into `/etc/`, and `chmod 777` pause for
  explicit confirmation; confirmation defaults to deny.
- **Workspace path boundaries** — file tools reject any path that escapes the
  Project directory through canonical path checks.
- **Tool timeout and abort propagation** — tool execution has a configurable
  timeout and forwards the Run's `AbortSignal` into the running tool.
- **Event interception around tool execution** — the three Tool stages let
  listeners modify or stop a call before it commits.
- **Deterministic run bounds** — `maxTurns` stops the loop while preserving one
  result per Tool Call.

- Implementing modules: `src/coding-agent/events/permission/`,
  `src/coding-agent/tools/builtin/bash.ts`, `src/utils/workspace.ts`,
  `src/core/harness/agent-loop.ts`, `src/core/harness/agent-harness.ts`.
- Tests: `tests/coding-agent/events/permission/bash-policy.test.ts`,
  `tests/coding-agent/tools/builtin/bash.test.ts`,
  `tests/harness/agent-loop.test.ts`, `tests/harness/agent-harness.test.ts`.

## 5. Configuration and stopping

Production startup reads JSON configuration with precedence explicit `--config`,
project, user, then built-in defaults. Credentials live only in
`~/.kea/auth.json`; project configuration cannot contain secrets. The first run
auto-creates the missing `config.json` and `auth.json` templates and never
overwrites existing files. The Harness enforces `maxTurns`, and each Run
completes with one of `completed`, `aborted`, or `error`.

- Implementing modules: `src/coding-agent/config/`,
  `src/coding-agent/cli/args.ts`, `src/main.ts`, `src/core/harness/`.
- Tests: `tests/coding-agent/config/`, `tests/main.test.ts`,
  `tests/harness/agent-harness.test.ts`.

## 6. Session persistence and title

Each Session is stored as one JSONL file. A header record carries `id`, `cwd`,
`title`, `createdAt`, and `updatedAt`; subsequent records are parent-linked
`message` and `model_selection` nodes forming one rooted tree. The title is a
header field, rewritten in place (rather than an appended record) so it survives
round-trip and live file watching. A title is generated once from the first
non-empty user message; if model generation fails or is empty, the truncated
prompt text itself is used as a deterministic fallback.

- Implementing modules: `src/core/harness/session/`,
  `src/core/harness/session-title.ts`.
- Tests: `tests/harness/session.test.ts`,
  `tests/harness/session-repository.test.ts`.

## 7. Mock-LLM mechanism demonstration

The harness is testable without a real model or network: a scripted `StreamFn`
drives the loop, and unit tests cover dangerous-command denial, deterministic
stopping, session persistence and reopening, and title generation/fallback. The
full suite runs with `npm test`.

- Implementing modules: `tests/harness/`, `tests/coding-agent/`, `tests/ai/`.
- Command: `npm test`.

## 8. Limitations and non-goals

Kea is not deployed and has no hosted WebUI or GitHub Release in this iteration.
It deliberately excludes a full-screen or mouse-driven TUI, project-memory /
vector embedding, MCP, plugins, automatic updates, telemetry, remote
synchronization, and a general policy language with persistent "always allow"
permissions. Distribution is the npm global package (`npm install -g .`); there
is no host-native single-file executable build.

## 9. Problem statement, users, and value

General-purpose LLM APIs can propose code edits but do not by themselves provide
a reliable coding workflow. A useful coding agent also needs controlled file and
shell access, durable sessions, bounded retries, credential handling, and a UI
that lets a human understand and stop it.

Kea targets individual developers and students who want to run a transparent
coding agent in a local repository without adopting a hosted agent framework.
Its value is the independently implemented harness around the model: the same
core can be driven by a real provider during use or a scripted mock during
deterministic tests.

The primary usage environment is a trusted local workstation. Kea reduces
accidental damage but is not a security boundary against hostile repositories,
hostile dependencies, or a compromised operating-system account.

## 10. User stories

### US-1: Safe first-run setup

As a first-time user, I want the first run to create separate configuration and
credential templates without overwriting existing files, so that I can start
without accidentally committing a key.

### US-2: Local coding loop

As a developer, I want to describe a coding task in my terminal and let the
agent read files, propose edits, execute allowed tools, and continue from tool
results, so that I can complete repository work in one recoverable session.

### US-3: Human control over dangerous actions

As a developer, I want destructive commands denied or paused with their full
risk context, so that a model cannot silently perform an action outside my risk
tolerance.

### US-4: Session recovery

As a developer, I want completed messages, tool results, model choice, cwd, and
title persisted, so that restarting the CLI resumes a coherent conversation or
reports storage corruption explicitly.

### US-5: Reproducible local distribution

As a user on a supported platform, I want documented source installation and a
global npm install with an uninstall command, so that I can run Kea without
depending on the author's workstation state.

Each story is independently testable and small enough to accept or reject
without requiring an unrelated story.

## 11. Functional specification

| Module | Input | Behavior | Output | Boundaries and errors |
| --- | --- | --- | --- | --- |
| CLI | argv and cwd | Parse run/continue/verbose/config options and compose the application | Interactive session or exit | Reject unknown flags, missing values, and extra positional arguments |
| Configuration | explicit, project, and user JSON | Validate, merge by precedence, separate provider credentials; auto-create missing templates | Immutable resolved configuration | Name the invalid source and field; never echo API keys; reject secrets in project config |
| AI adapters | model, messages, tools | Translate one provider stream into common chunks | Text, thinking, tool calls, terminal done/error chunk | Lazy-load providers; reject unknown provider; omit internal tool details from wire payload |
| Agent loop | prompt, context, limits, StreamFn | Request model, persist assistant message, execute calls in order, append results, decide continuation | completed/aborted/error outcome | Exactly one result per call; reject missing terminal chunk; propagate abort |
| Tool registry | tool call, events, signal | Lookup, validate, intercept, execute with timeout, post-process | Tool result visible to session and next model turn | Unknown/invalid/blocked/thrown calls become error results |
| Coding tools | cwd, project root, arguments | Read/write/edit/glob, Bash, Todo | Typed model-visible content plus optional UI details | File paths stay inside the project root; hard-denied commands never reach executor |
| Session repository | JSONL records | Append one parent-linked conversation tree and reopen it | Messages, metadata, model, title, cwd | Reject malformed files, duplicate IDs, missing parents, multiple roots, and path traversal |
| Project | startup directory and Kea home | Discover/reuse project, share Events, create/open/continue sessions | Project-scoped Harness instances | Canonical root wins; corrupt recent session is not silently skipped |
| UI | project events and interactions | Render thinking, tool summaries, permission prompts, stop reasons | Terminal output and explicit confirmations | Display failures notify but do not change core result; empty confirmation denies |

## 12. Non-functional requirements

### Performance

- Tool and model streams are processed incrementally; the CLI does not wait for
  a complete response before displaying progress.
- Every tool has a configurable timeout, and every run has a maximum turn count.

### Availability and recoverability

- A Session record is appended before the corresponding fact event is observed.
- Failed persistence rolls in-memory state back to the last durable tree.
- Corrupt storage produces an actionable error rather than silent data loss.

### Observability

- Thinking and tool summaries are shown by default; tool details render
  compactly.
- UI listener failures are isolated and reported separately from agent failures.

### Security and credential threat model

**Assets:** provider API keys, source files, local command execution authority,
and session content.

**Threats and controls:**

| Threat | Control | Residual risk |
| --- | --- | --- |
| Key committed through project config | Project config rejects secret fields; local auth path is ignored | A user may copy a real key into another tracked file |
| Key printed in diagnostics | Provider/config errors redact credential values and tests assert the narrow credential shape | Third-party SDK or user command output may reveal unrelated secrets |
| Other local user reads auth file | `auth.json` is stored outside the project with restricted mode where supported | `auth.json` remains plaintext; Windows ACL behavior and compromised accounts are outside this guarantee |
| Model requests dangerous shell action | Deterministic allow/ask/deny classifier plus hard deny in both listener and Bash tool | Classification is not a complete shell sandbox |
| File tool escapes repository | Canonical path checks require the target to remain inside the project root | Bash commands can access broader host resources after user approval |
| Unbounded autonomous loop | maxTurns, timeout, and AbortSignal | A permitted command can still consume resources within its timeout |

The credential lifecycle is explicit: the first run creates the template; the
user updates a key by editing `~/.kea/auth.json`; errors never display the key.
Plaintext user storage is a known limitation rather than an OS-keychain claim.

### Usability

- Confirmation defaults to deny.
- Normal operation shows thinking and compact tool output.
- Errors identify the responsible file, field, command, or storage path.

## 13. Architecture and data flow

The fixed dependency direction is:

```text
CLI/UI -> Coding Agent -> Harness -> AI adapter -> provider API
                       \-> Tool Registry -> coding tools -> local filesystem/shell
Project -> Session Repository -> JSONL files
```

For each user prompt:

1. CLI passes input to its Session-bound Harness.
2. Harness builds the system prompt and Session context.
3. Agent requests one model stream through the provider-neutral `StreamFn`.
4. A complete assistant message is persisted.
5. Each tool call passes deterministic validation and control interceptors.
6. Tool results are persisted and become input to the next model turn.
7. Permission denials and limits use the same normal result path.
8. Harness emits the terminal run outcome and UI renders it.

External dependencies are the selected provider API, the local shell, the local
filesystem, Node.js 24 for source/build workflows, and npm for dependency
installation. Mock tests replace provider and command execution boundaries.

## 14. Data model

### Project

- `id`: stable identifier.
- `name`: display name.
- `directory`: canonical root path.
- `createdAt`, `updatedAt`: ISO timestamps.

### Session

- Header: session ID, cwd, title, createdAt, updatedAt.
- Records: parent-linked user/assistant/tool messages and model changes.
- Conversation records contain unique IDs and parent IDs, forming one valid
  rooted tree.

Constraints: file name must match a safe session ID; all parents exist; there is
one root; JSON-only tool details survive round-trip.

### Configuration

- `defaultModel`: provider and model name.
- Provider map: protocol, optional base URL, and user-only API key.
- Agent: positive `maxTurns`.
- Tools: positive `timeoutSeconds`.
- UI: thinking and tool-detail display modes.

## 15. Credential and distribution design

Source installation:

```text
npm ci
npm run build
npm start
```

Global install and uninstall:

```text
npm ci
npm run build
npm install -g .
kea          # run the installed command
npm uninstall -g kea-agent   # remove it
```

`npm install -g .` registers the `kea` bin (pointing at `dist/src/main.js`), so
the build must run first. On a target machine the first run creates
`~/.kea/config.json` and `~/.kea/auth.json`; the user configures model metadata
and places the key only in `auth.json`. Repository-level `.kea/config.json` may
change behavior but cannot contain a key. Known limitations are plaintext user
auth storage and Node/Git Bash requirements for source use.

## 16. Technology choices and rationale

- **TypeScript 7 / Node.js 24:** one language for provider streams, CLI, file
  operations, and tests; strong discriminated unions express
  message/event/tool contracts.
- **node:test:** built into Node, deterministic, and sufficient for unit and
  mock-LLM tests without another test runner.
- **TypeBox:** keeps tool schemas usable both as runtime provider definitions
  and compile-time TypeScript types.
- **Official provider SDKs:** use only the low-level streaming APIs; Kea retains
  ownership of the agent loop and does not use an AgentExecutor.
- **JSON/JSONL:** inspectable local configuration and append-oriented Session
  storage; appropriate for one local user without a database service.
- **npm global package:** a straightforward install/uninstall distribution for a
  Node CLI, without platform-specific native builds.
- **CLI rather than WebUI:** matches local coding workflows and keeps the main
  contribution on harness governance rather than deployment.

## 17. Acceptance criteria

- `npm test` passes without API keys or network and covers all core mechanisms
  (331/333, 2 skipped).
- Dangerous Bash commands are denied below the UI confirmation layer.
- Project config containing a secret is rejected, and errors do not echo keys.
- File tools and Bash execution outside the Project root prompt the user with
  Allow once / Always allow / Deny before proceeding.
- Sessions reopen with messages, model, cwd, title, and structured tool details.
- The title is generated from the first user message with a deterministic
  fallback when model generation fails.
- `npm install -g .` exposes a runnable `kea` command and
  `npm uninstall -g kea-agent` removes it.
- Push CI exposes a `unit-test` job that runs typecheck and the full suite.
- README contains introduction, installation, operation, distribution,
  uninstall, project structure, credential setup, and security boundaries.

## 18. Risks and open issues

- Plaintext `auth.json` is weaker than an OS keychain or encrypted store.
- Bash governance recognizes important command patterns but is not a parser,
  container, VM, or operating-system sandbox.
- Session files have no multi-process locking; two Kea processes writing the
  same Project may race.
- Provider SDK behavior and model tool-call formats can change independently.
- The different-agent cold-start spec audit still needs preserved evidence in
  `SPEC_PROCESS.md`.
- Remote CI becomes complete only after the workflow is committed, pushed, and
  its latest run is confirmed green.
