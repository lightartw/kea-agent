import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  parseSessionId,
  parseSessionRecord,
  validateSessionRecords,
} from "./records.js";
import {
  SessionError,
  type SessionMetadata,
  type SessionRecord,
  type SessionStorage,
} from "./types.js";

interface StoredSessionHeader {
  readonly type: "session";
  readonly version: 2;
  readonly id: string;
  readonly cwd: string;
  readonly title: string;
  readonly createdAt: string;
  readonly parentSessionId?: string;
}

const SESSION_FILE_RE = /^[A-Za-z0-9_-]+\.jsonl$/;

/** Directory where one project's session files live, relative to its storageDir. */
function sessionsDir(storageDir: string): string {
  return join(storageDir, "sessions");
}

function sessionPath(storageDir: string, sessionId: string): string {
  const id = parseSessionId(sessionId);
  return join(sessionsDir(storageDir), `${id}.jsonl`);
}

function asStorageError(message: string, error: unknown): SessionError {
  return new SessionError("storage", message, { cause: error });
}

function invalidSession(message: string): never {
  throw new SessionError("invalid_session", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new SessionError("invalid_session", "Session file contains invalid JSON", {
      cause: error,
    });
  }
}

function parseHeader(raw: unknown): StoredSessionHeader {
  if (!isRecord(raw) || raw.type !== "session" || raw.version !== 2 ||
    !isString(raw.cwd) || !isAbsolute(raw.cwd) ||
    !isString(raw.title) || raw.title.trim() === "" || raw.title.includes("\n") ||
    !isTimestamp(raw.createdAt)) {
    invalidSession("Session header is invalid");
  }
  const id = parseSessionId(raw.id);
  const parentSessionId = raw.parentSessionId === undefined
    ? undefined
    : parseSessionId(raw.parentSessionId);
  return {
    type: "session",
    version: 2,
    id,
    cwd: resolve(raw.cwd),
    title: raw.title,
    createdAt: raw.createdAt,
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
  };
}

/** Fold the last title record and the maximum record timestamp into metadata. */
function metadataFrom(
  header: StoredSessionHeader,
  records: readonly SessionRecord[],
): SessionMetadata {
  let title = header.title;
  let updatedAt = header.createdAt;
  for (const record of records) {
    if (record.createdAt > updatedAt) updatedAt = record.createdAt;
    if (record.type === "session_title") title = record.title;
  }
  return {
    id: header.id,
    title,
    cwd: header.cwd,
    createdAt: header.createdAt,
    updatedAt,
    ...(header.parentSessionId !== undefined
      ? { parentSessionId: header.parentSessionId }
      : {}),
  };
}

/**
 * Serialize mutations for one Session ID without blocking other IDs. A settled
 * entry is removed only if it still points to this operation's chain, so a
 * rejected operation neither leaks nor blocks later work.
 */
function enqueueById<T>(
  pendingById: Map<string, Promise<void>>,
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = pendingById.get(sessionId) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const chain = result.then(
    () => undefined,
    () => undefined,
  );
  pendingById.set(sessionId, chain);
  void chain.then(() => {
    if (pendingById.get(sessionId) === chain) {
      pendingById.delete(sessionId);
    }
  });
  return result;
}

/**
 * The concrete JSONL backend serving every Session in one Repository. It
 * never imports, returns, or constructs `Session`; the physical header format
 * and file layout are private to this module.
 */
export class JsonlSessionStorage implements SessionStorage {
  private readonly storageDir: string;
  private readonly pendingById = new Map<string, Promise<void>>();

  constructor(storageDir: string) {
    this.storageDir = resolve(storageDir);
  }

  create(stored: {
    readonly metadata: SessionMetadata;
    readonly records: readonly SessionRecord[];
  }): Promise<void> {
    return enqueueById(this.pendingById, stored.metadata.id, async () => {
      const header = parseHeader({
        type: "session",
        version: 2,
        id: stored.metadata.id,
        cwd: stored.metadata.cwd,
        title: stored.metadata.title,
        createdAt: stored.metadata.createdAt,
        ...(stored.metadata.parentSessionId !== undefined
          ? { parentSessionId: stored.metadata.parentSessionId }
          : {}),
      });
      const records = stored.records.map((record) => parseSessionRecord(record));
      validateSessionRecords(records);

      const contents = [
        JSON.stringify(header),
        ...records.map((record) => JSON.stringify(record)),
        "",
      ].join("\n");
      const path = sessionPath(this.storageDir, header.id);
      const tempPath = join(sessionsDir(this.storageDir), `.tmp-${header.id}.jsonl`);
      try {
        await mkdir(sessionsDir(this.storageDir), { recursive: true });
        await writeFile(tempPath, contents, { encoding: "utf8", flag: "wx" });
        await rename(tempPath, path);
      } catch (error) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw asStorageError("Could not create session storage", error);
      }
    });
  }

  load(sessionId: string): Promise<{
    readonly metadata: SessionMetadata;
    readonly records: readonly SessionRecord[];
  }> {
    return enqueueById(this.pendingById, sessionId, async () => {
      const id = parseSessionId(sessionId);
      const path = sessionPath(this.storageDir, id);
      let contents: string;
      try {
        contents = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new SessionError("not_found", `Session ${sessionId} was not found`, {
            cause: error,
          });
        }
        throw asStorageError("Could not read session storage", error);
      }

      if (contents.trim() === "") {
        invalidSession("Session file is empty");
      }

      const lines = contents.split(/\r?\n/).filter((line) => line.trim() !== "");
      const header = parseHeader(parseJson(lines[0]!));
      if (header.id !== id) {
        invalidSession("Session header ID does not match the filename");
      }

      const records: SessionRecord[] = [];
      for (let index = 1; index < lines.length; index++) {
        records.push(parseSessionRecord(parseJson(lines[index]!)));
      }
      validateSessionRecords(records);

      return { metadata: metadataFrom(header, records), records };
    });
  }

  list(): Promise<readonly SessionMetadata[]> {
    return (async () => {
      let entries: string[];
      try {
        entries = await readdir(sessionsDir(this.storageDir));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw asStorageError("Could not read sessions directory", error);
      }

      const jsonlFiles = entries.filter((entry) => SESSION_FILE_RE.test(entry));
      const sessions = await Promise.all(
        jsonlFiles.map(async (filename) => {
          const loaded = await this.load(filename.replace(/\.jsonl$/, ""));
          return loaded.metadata;
        }),
      );

      sessions.sort((a, b) => {
        const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
        return byUpdated !== 0 ? byUpdated : b.id.localeCompare(a.id);
      });

      return sessions;
    })();
  }

  append(sessionId: string, record: SessionRecord): Promise<void> {
    return enqueueById(this.pendingById, sessionId, async () => {
      const id = parseSessionId(sessionId);
      const detached = parseSessionRecord(record);
      const path = sessionPath(this.storageDir, id);
      try {
        const file = await open(path, "r+");
        try {
          const { size } = await file.stat();
          const contents = Buffer.from(`${JSON.stringify(detached)}\n`, "utf8");
          let offset = 0;
          while (offset < contents.length) {
            const { bytesWritten } = await file.write(
              contents,
              offset,
              contents.length - offset,
              size + offset,
            );
            if (bytesWritten === 0) {
              throw new Error("Session append wrote zero bytes");
            }
            offset += bytesWritten;
          }
        } finally {
          await file.close();
        }
      } catch (error) {
        throw asStorageError("Could not persist session row", error);
      }
    });
  }

  delete(sessionId: string): Promise<void> {
    return enqueueById(this.pendingById, sessionId, async () => {
      const id = parseSessionId(sessionId);
      const path = sessionPath(this.storageDir, id);
      try {
        await rm(path, { force: true });
      } catch (error) {
        throw asStorageError("Could not delete session storage", error);
      }
    });
  }
}
