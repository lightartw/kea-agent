import type { Message } from "../../llm-client/types.js";

/** A project groups sessions and owns a working directory. */
export interface Project {
  readonly id: string;
  /** null for anonymous (path-encoded) projects. */
  readonly name: string | null;
  readonly workDir: string;
  readonly storageDir: string;
}

/** Persistence contract for one session; SessionRepo creates implementations. */
export interface SessionStore {
  append(message: Message): Promise<void>;
  load(): Promise<Message[]>;
}
