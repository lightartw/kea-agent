import type { HarnessProject, SystemPromptBuilder } from "../agent/harness/types.js";
import type { StreamFn, ModelConfig } from "../ai/types.js";
import type { Session } from "../agent/harness/session/session.js";

/** A structured permission request shown to the user for confirmation. */
export interface PermissionRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly reason: string;
}

/** A notification from a Hook to the UI layer. */
export interface HookNotification {
  readonly source:
    | "context_inject"
    | "tool_log"
    | "large_output"
    | "summary";
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}

/**
 * Narrow UI port that coding-agent defines; CLI or any frontend implements it.
 * Coding-agent never imports CLI or frontend code.
 */
export interface CodingHookUI {
  readonly available: boolean;
  confirm(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<boolean>;
  notify(notification: HookNotification): void | Promise<void>;
}

/** Context passed to every Hook handler. */
export interface CodingHookContext {
  readonly cwd: string;
  readonly ui: CodingHookUI;
}

/** Configuration for creating a Coding Agent harness through the public factory. */
export interface CreateHarnessConfig {
  readonly project: HarnessProject;
  readonly streamFn: StreamFn;
  readonly model: ModelConfig;
  readonly session?: Session;
  readonly systemPrompt?: string | SystemPromptBuilder;
  readonly ui?: CodingHookUI;
}
