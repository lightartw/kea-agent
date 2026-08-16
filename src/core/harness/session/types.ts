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

/**
 * One logical state change accepted into the durable Session log. Tree records
 * are `SessionNode`s; a Session-wide title change is a record but not a node.
 *
 * @internal
 */
export type SessionRecord =
  | SessionNode
  | {
      readonly type: "session_title";
      readonly createdAt: string;
      readonly title: string;
    };

/**
 * Internal persistence port. A Session accepts new records only after this
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
  append(sessionId: string, record: SessionRecord): Promise<void>;
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
