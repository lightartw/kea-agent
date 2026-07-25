import { HookRegistry } from "./registry.js";
import type { Hook } from "./types.js";
import { ContextInjectHook } from "./context-inject.js";
import { LargeOutputHook, LogHook } from "./log.js";
import { PermissionHook } from "./permission.js";
import { SummaryHook } from "./summary.js";
import {
  TodoCalledHook,
  TodoRemindHook,
  TodoResetHook,
} from "./todo-reminder.js";

function builtinHooks(cwd: string): readonly Hook[] {
  return [
    new ContextInjectHook(cwd),
    new PermissionHook(),
    new LogHook(),
    new LargeOutputHook(),
    new SummaryHook(),
    new TodoResetHook(),
    new TodoCalledHook(),
    new TodoRemindHook(),
  ];
}

/**
 * Build the default hook pipeline. Built-in hooks are registered internally;
 * callers can optionally supply additional hooks. Mirrors createToolRegistry.
 */
export function createHookRegistry(
  cwd: string,
  hooks?: Iterable<Hook>,
): HookRegistry {
  const registry = new HookRegistry();
  for (const hook of builtinHooks(cwd)) registry.register(hook);
  if (hooks !== undefined) {
    for (const hook of hooks) registry.register(hook);
  }
  return registry;
}
