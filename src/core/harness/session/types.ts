import type { AgentMessage } from "../types.js";
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

/**
 * Internal persistence port. A Session accepts new nodes only after this
 * port resolves; it is not exported from the Harness package entry, so a
 * future shared immutable node store can back it unchanged.
 *
 * @internal
 */
export interface SessionStorage {
  create(stored: {
    readonly metadata: SessionMetadata;
    readonly nodes: readonly SessionNode[];
  }): Promise<void>;
  load(sessionId: string): Promise<{
    readonly metadata: SessionMetadata;
    readonly nodes: readonly SessionNode[];
  }>;
  list(): Promise<readonly SessionMetadata[]>;
  append(sessionId: string, node: SessionNode): Promise<void>;
  /** Persist the session title as a header field, not as a record. */
  setTitle(sessionId: string, title: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export type SessionErrorCode =
  | "not_found"
  | "invalid_session"
  | "invalid_record"
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
