import type { AgentMessage } from "../../agent/types.js";
import type { ModelConfig } from "../../ai/types.js";

export interface CreateSessionInput {
  readonly projectId: string;
  readonly directory: string;
  readonly cwd: string;
}

export interface SessionHeader extends CreateSessionInput {
  readonly type: "session";
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
}

export interface SessionTitleEntry {
  readonly type: "session_title";
  readonly createdAt: string;
  readonly title: string;
}

export interface SessionMessageEntry {
  readonly type: "message";
  readonly id: string;
  readonly parentId: string | null;
  readonly createdAt: string;
  readonly message: AgentMessage;
}

export interface SessionModelChangeEntry {
  readonly type: "model_change";
  readonly id: string;
  readonly parentId: string | null;
  readonly createdAt: string;
  readonly provider: string;
  readonly modelId: string;
}

export type SessionRecord =
  | SessionMessageEntry
  | SessionModelChangeEntry
  | SessionTitleEntry;

export interface SessionInfo extends CreateSessionInput {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionContext {
  readonly messages: AgentMessage[];
  readonly model: ModelConfig | null;
}

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
