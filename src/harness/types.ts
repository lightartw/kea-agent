import type { Message } from "../ai/types.js";
import type { Session } from "./session/session.js";

/** Persistence contract for one session. */
export interface SessionStore {
  readonly session: Session;
  append(message: Message): Promise<void>;
  load(): Promise<Message[]>;
}
