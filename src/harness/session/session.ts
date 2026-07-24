import { randomUUID } from "node:crypto";
import type { Message, ModelConfig } from "../../ai/types.js";

// ── Session entry types ──

interface EntryBase {
  readonly id: string;
  readonly parentId: string | null;
}

export interface MessageEntry extends EntryBase {
  readonly type: "message";
  readonly message: Message;
}

export interface ModelChangeEntry extends EntryBase {
  readonly type: "model_change";
  readonly provider: string;
  readonly modelId: string;
}

export type SessionEntry = MessageEntry | ModelChangeEntry;

// ── Helpers ──

function newId(): string {
  return randomUUID().slice(0, 12);
}

/** Walk from leaf to root, reverse so the order is chronological. */
function pathToRoot(
  entries: Map<string, SessionEntry>,
  leafId: string,
): SessionEntry[] {
  const path: SessionEntry[] = [];
  let cursor: string | null = leafId;
  while (cursor !== null) {
    const entry = entries.get(cursor);
    if (!entry) break;
    path.push(entry);
    cursor = entry.parentId;
  }
  return path.reverse();
}

// ── Session ──

/** Tree-structured session. Each entry links to its parent; buildContext walks from leaf. */
export class Session {
  private readonly entries = new Map<string, SessionEntry>();
  private leafId: string | null = null;

  constructor(readonly id: string) {}

  // ── Append ──

  private appendEntry(entry: SessionEntry): void {
    this.entries.set(entry.id, entry);
    this.leafId = entry.id;
  }

  appendMessage(message: Message): void {
    this.appendEntry({
      type: "message",
      id: newId(),
      parentId: this.leafId,
      message,
    });
  }

  appendModelChange(provider: string, modelId: string): void {
    this.appendEntry({
      type: "model_change",
      id: newId(),
      parentId: this.leafId,
      provider,
      modelId,
    });
  }

  // ── Query ──

  getBranch(leafId?: string): SessionEntry[] {
    const target = leafId ?? this.leafId;
    if (target === null) return [];
    return pathToRoot(this.entries, target);
  }

  /** Rebuild messages and current model from the session tree. */
  buildContext(): { messages: Message[]; model: ModelConfig | null } {
    const branch = this.getBranch();
    const messages: Message[] = [];
    let model: ModelConfig | null = null;

    for (const entry of branch) {
      if (entry.type === "message") {
        messages.push(entry.message);
      } else if (entry.type === "model_change") {
        model = { provider: entry.provider, model: entry.modelId };
      }
    }

    return { messages, model };
  }

  // ── Serialization ──

  /** Export all entries for JSONL persistence. */
  toJSON(): SessionEntry[] {
    return this.getBranch();
  }

  /** Restore from parsed JSONL lines. */
  static fromJSON(id: string, entries: SessionEntry[]): Session {
    const session = new Session(id);
    for (const entry of entries) {
      session.entries.set(entry.id, entry);
      session.leafId = entry.id;
    }
    return session;
  }
}
