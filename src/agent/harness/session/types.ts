import type { AgentMessage } from "../../types.js";
import type { ModelConfig } from "../../../ai/types.js";

export interface SessionEntryBase {
  readonly id: string;
  readonly parentId: string | null;
}

export interface SessionMessageEntry extends SessionEntryBase {
  readonly type: "message";
  readonly message: AgentMessage;
}

export interface SessionModelChangeEntry extends SessionEntryBase {
  readonly type: "model_change";
  readonly provider: string;
  readonly modelId: string;
}

export type SessionEntry =
  | SessionMessageEntry
  | SessionModelChangeEntry;

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
