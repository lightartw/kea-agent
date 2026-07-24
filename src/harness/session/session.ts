import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Message, ModelConfig } from "../../ai/types.js";

// ── Entry types ──

interface EntryBase {
  id: string;
  parentId: string | null;
}

interface MessageEntry extends EntryBase {
  type: "message";
  message: Message;
}

interface ModelChangeEntry extends EntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

type Entry = MessageEntry | ModelChangeEntry;

// ── Helpers ──

function newId(): string {
  return randomUUID().slice(0, 12);
}

async function readEntries(filePath: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  try {
    const rl = createInterface({
      input: createReadStream(filePath, "utf8"),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const raw = JSON.parse(line) as Record<string, unknown>;
      if (raw.type === "message" || raw.type === "model_change") {
        entries.push(raw as unknown as Entry);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return entries;
}

// ── Session ──

/**
 * Append-only conversation tree backed by a JSONL file.
 *
 * Each entry has an id and parentId. The leaf pointer tracks the current
 * position; appending creates a child of the leaf. buildContext() walks
 * from leaf to root to reconstruct messages and the current model.
 *
 * Two modes:
 *   Session.create(dir)    — persistent, file in <dir>/sessions/<id>.jsonl
 *   Session.open(dir, id)  — open existing session
 *   Session.inMemory()     — no file I/O, data lives only in memory
 */
export class Session {
  private entries: Entry[] = [];
  private byId = new Map<string, Entry>();
  private leafId: string | null = null;

  // Persistence state
  private persistPath: string | null;
  private flushed = false;

  private constructor(readonly id: string, storageDir?: string) {
    if (storageDir !== undefined) {
      this.persistPath = join(storageDir, "sessions", `${id}.jsonl`);
    } else {
      this.persistPath = null;
    }
  }

  // ── Factories ──

  /** Create a new session backed by a JSONL file. */
  static async create(storageDir: string): Promise<Session> {
    const dir = join(storageDir, "sessions");
    await mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    const id = `${ts}_${randomUUID().slice(0, 8)}`;
    return new Session(id, storageDir);
  }

  /** Open an existing session by id. */
  static async open(storageDir: string, sessionId: string): Promise<Session> {
    const session = new Session(sessionId, storageDir);
    const path = session.persistPath!;
    const loaded = await readEntries(path);

    // File exists but is empty — create hook can pre-populate
    if (loaded.length === 0 && session.persistPath) {
      session.flushed = true;
      return session;
    }

    for (const entry of loaded) {
      session.entries.push(entry);
      session.byId.set(entry.id, entry);
      session.leafId = entry.id;
    }
    session.flushed = loaded.length > 0;
    return session;
  }

  /** Create an in-memory session that never touches disk. */
  static inMemory(): Session {
    return new Session(randomUUID().slice(0, 12));
  }

  // ── Append ──

  private async persist(entry: Entry): Promise<void> {
    if (this.persistPath === null) return;

    const hasAssistant = this.entries.some(
      (e) => e.type === "message" && e.message.role === "assistant",
    );

    if (!hasAssistant) {
      // Buffer in memory until the first assistant message arrives.
      // This avoids creating empty session files for abandoned prompts.
      this.flushed = false;
      return;
    }

    if (!this.flushed) {
      // First assistant — create the file and flush all buffered entries.
      const lines = this.entries.map((e) => `${JSON.stringify(e)}\n`).join("");
      await appendFile(this.persistPath, lines, "utf8");
      this.flushed = true;
    } else {
      await appendFile(this.persistPath, `${JSON.stringify(entry)}\n`, "utf8");
    }
  }

  private push(entry: Entry): void {
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
  }

  async appendMessage(message: Message): Promise<void> {
    const entry: MessageEntry = {
      type: "message", id: newId(), parentId: this.leafId, message,
    };
    this.push(entry);
    await this.persist(entry);
  }

  async appendModelChange(provider: string, modelId: string): Promise<void> {
    const entry: ModelChangeEntry = {
      type: "model_change", id: newId(), parentId: this.leafId, provider, modelId,
    };
    this.push(entry);
    await this.persist(entry);
  }

  // ── Query ──

  private branch(): Entry[] {
    const path: Entry[] = [];
    let cursor: string | null = this.leafId;
    while (cursor !== null) {
      const entry = this.byId.get(cursor);
      if (!entry) break;
      path.push(entry);
      cursor = entry.parentId;
    }
    return path.reverse();
  }

  /** Rebuild messages and current model by walking from leaf to root. */
  buildContext(): { messages: Message[]; model: ModelConfig | null } {
    const messages: Message[] = [];
    let model: ModelConfig | null = null;

    for (const entry of this.branch()) {
      if (entry.type === "message") {
        messages.push(entry.message);
      } else if (entry.type === "model_change") {
        model = { provider: entry.provider, model: entry.modelId };
      }
    }

    return { messages, model };
  }

  messages(): Message[] {
    return this.buildContext().messages;
  }
}
