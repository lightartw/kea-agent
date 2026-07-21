import type { Message } from "../../llm-client/types.js";

/**
 * In-memory message history for one session.
 * First version is a flat array; tree structure (parentId) later.
 */
export class Session {
  constructor(
    readonly id: string,
    private messages: Message[] = [],
  ) {}

  getMessages(): readonly Message[] {
    return this.messages;
  }

  append(message: Message): void {
    this.messages.push(message);
  }

  /** Serialize for JSONL persistence. */
  toJSON(): object[] {
    return this.messages.map((m) => ({ ...m }));
  }

  /** Deserialize from parsed JSONL lines. */
  static fromJSON(id: string, lines: object[]): Session {
    return new Session(id, lines as Message[]);
  }
}
