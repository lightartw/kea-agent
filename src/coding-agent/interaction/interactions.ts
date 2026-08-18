import type { AgentToolCall } from "../../core/harness/tools/types.js";

export type PermissionRequest =
  | {
      readonly kind: "dangerous-command";
      readonly sessionId: string;
      readonly runId: string;
      readonly call: AgentToolCall;
      readonly command: string;
      readonly cwd: string;
      readonly reason: string;
    }
  | {
      readonly kind: "external-directory";
      readonly sessionId: string;
      readonly runId: string;
      readonly call: AgentToolCall;
      readonly targetPath: string;
      readonly directory: string;
      readonly reason: string;
    };

export type PermissionReply =
  | { readonly kind: "once" }
  | { readonly kind: "always" }
  | { readonly kind: "deny"; readonly reason?: string };

/**
 * Port from Permission to an external decider (terminal, UI, or test).
 * The returned Promise ties one request to one reply; adapters needing a
 * request ID generate it in their own transport layer. Assemblers must
 * provide an adapter explicitly; there is no built-in default.
 */
export interface Interactions {
  permission(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<PermissionReply>;
}
