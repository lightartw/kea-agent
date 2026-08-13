# Harness README Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the Harness README so a reader with only basic Agent knowledge can understand and use the package, especially its Event Bus.

**Architecture:** Replace the current reference-first structure with a progressive explanation: minimum model, usage, one run trace, Event Bus semantics, state/configuration, then the complete API inventory. Keep behavior and public interfaces unchanged.

**Tech Stack:** Markdown, current TypeScript public APIs

## Global Constraints

- Modify documentation only.
- Describe only behavior implemented by the current source.
- Keep every public export discoverable.
- Do not add a diagram or turn the README into an implementation guide.

---

### Task 1: Rewrite and verify the Harness README

**Files:**
- Modify: `src/harness/README.md`
- Reference: `src/harness/index.ts`
- Reference: `src/harness/agent-harness.ts`
- Reference: `src/harness/events/types.ts`
- Reference: `src/harness/events/event-bus.ts`
- Reference: `src/harness/session/session.ts`

**Interfaces:**
- Consumes: current Harness public exports and runtime behavior.
- Produces: a progressive README with a complete, accurate public API inventory.

- [ ] **Step 1: Rewrite the README in the approved order**

Write: minimum model → minimal usage → one `prompt()` trace → Event Bus → Event versus Hook → run identity → Session/configuration → full API → current limits.

- [ ] **Step 2: Check terminology and public API coverage**

Run:

```powershell
rg -n "HarnessEvent|HarnessEventBus|subscribe|runId|lane|Session|AgentHarness|HarnessConfig" src/harness/README.md
```

Expected: each central concept is introduced in prose before or beside its interface, and every export from `src/harness/index.ts` is listed.

- [ ] **Step 3: Verify repository integrity**

Run:

```powershell
npm run typecheck
git diff --check
```

Expected: both commands exit with code 0.

- [ ] **Step 4: Commit**

```powershell
git add src/harness/README.md
git commit -m "docs: rewrite harness readme progressively"
```
