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
