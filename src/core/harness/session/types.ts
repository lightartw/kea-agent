import type { AgentMessage } from "../../agent/types.js";
import type { ModelConfig } from "../../ai/types.js";

export interface SessionMetadata {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly parentSessionId?: string;
}

export type SessionNode =
  | {
      readonly type: "message";
      readonly id: string;
      readonly parentId: string | null;
      readonly createdAt: string;
      readonly message: AgentMessage;
    }
  | {
      readonly type: "model_selection";
      readonly id: string;
      readonly parentId: string | null;
      readonly createdAt: string;
      readonly selection: ModelConfig;
    };

export type SessionErrorCode =
  | "not_found"
  | "invalid_session"
  | "invalid_entry"
  | "storage";

export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionError";
  }
}
