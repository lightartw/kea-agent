import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  SESSION_ID_PATTERN,
  Session,
  isRecord,
  isString,
  isTimestamp,
  newId,
  parseNode,
  validateTree,
} from "./session.js";
import { SessionError, type SessionMetadata, type SessionNode } from "./types.js";

/**
 * Internal persistence port. A Session accepts new nodes and titles only
 * after this port resolves; it is not exported from the Harness package
 * entry, so a future shared immutable node store can back it unchanged.
 */
export interface SessionStorage {
  appendNode(node: SessionNode): Promise<void>;
  setTitle(title: string, updatedAt: string): Promise<void>;
}

interface StoredSessionHeader {
  readonly type: "session";
  readonly version: 2;
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly parentSessionId?: string;
}

export interface StoredTitleChange {
  readonly type: "session_title";
  readonly createdAt: string;
  readonly title: string;
}

export type StoredSessionRow = SessionNode | StoredTitleChange;

const SESSION_FILE_RE = /^[A-Za-z0-9_-]+\.jsonl$/;

/** Directory where one project's session files live, relative to its storageDir. */
export function sessionsDir(storageDir: string): string {
  return join(storageDir, "sessions");
}

/** @internal */
export function sessionPath(storageDir: string, sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new SessionError("invalid_session", "Session ID is invalid");
  }
  return join(sessionsDir(storageDir), `${sessionId}.jsonl`);
}

function asStorageError(message: string, error: unknown): SessionError {
  return new SessionError("storage", message, { cause: error });
}

function invalidEntry(message: string): never {
  throw new SessionError("invalid_entry", message);
}

function invalidSession(message: string): never {
  throw new SessionError("invalid_session", message);
}

function parseHeader(raw: unknown): StoredSessionHeader {
  if (!isRecord(raw) || raw.type !== "session" || raw.version !== 2 ||
    !isString(raw.id) || !SESSION_ID_PATTERN.test(raw.id) ||
    !isString(raw.cwd) || !isAbsolute(raw.cwd) ||
    !isString(raw.title) || !isTimestamp(raw.createdAt) ||
    (raw.parentSessionId !== undefined &&
      (!isString(raw.parentSessionId) || !SESSION_ID_PATTERN.test(raw.parentSessionId)))) {
    invalidSession("Session header is invalid");
  }
  return {
    type: "session",
    version: 2,
    id: raw.id,
    cwd: resolve(raw.cwd),
    title: raw.title,
    createdAt: raw.createdAt,
    ...(raw.parentSessionId !== undefined ? { parentSessionId: raw.parentSessionId } : {}),
  };
}

function parseRow(raw: unknown): StoredSessionRow {
  if (!isRecord(raw) || !isString(raw.type) || !isTimestamp(raw.createdAt)) {
    return invalidEntry("Session record has invalid metadata");
  }

  if (raw.type === "session_title") {
    if (raw.title === undefined || !isString(raw.title)) {
      return invalidEntry("Session title record is invalid");
    }
    return {
      type: "session_title",
      createdAt: raw.createdAt,
      title: raw.title,
    };
  }

  return parseNode(raw);
}

function parseJson(line: string, path: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new SessionError("invalid_session", "Session file contains invalid JSON", {
      cause: error,
    });
  }
}

function jsonlStorage(storageDir: string, sessionId: string): SessionStorage {
  return {
    appendNode: (node) => appendRow(storageDir, sessionId, node),
    setTitle: (title, updatedAt) =>
      appendRow(storageDir, sessionId, { type: "session_title", createdAt: updatedAt, title }),
  };
}

async function appendRow(
  storageDir: string,
  sessionId: string,
  row: StoredSessionRow,
): Promise<void> {
  const path = sessionPath(storageDir, sessionId);
  try {
    const file = await open(path, "r+");
    try {
      const { size } = await file.stat();
      const contents = Buffer.from(`${JSON.stringify(row)}\n`, "utf8");
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
}

/**
 * Create a persistent Session on disk. Only the SessionRepository uses this
 * helper; a fresh Session writes its header with `wx` so a colliding file is
 * rejected, while a fork publishes copied nodes atomically via a temp file.
 *
 * @internal
 */
export async function createPersistentSession(
  storageDir: string,
  options: {
    readonly cwd: string;
    readonly parentSessionId?: string;
    readonly nodes?: readonly SessionNode[];
  },
): Promise<Session> {
  const id = newId();
  const header: StoredSessionHeader = {
    type: "session",
    version: 2,
    id,
    cwd: resolve(options.cwd),
    title: "unknown",
    createdAt: new Date().toISOString(),
    ...(options.parentSessionId !== undefined
      ? { parentSessionId: options.parentSessionId }
      : {}),
  };
  const nodes = options.nodes ?? [];
  const path = sessionPath(storageDir, id);
  try {
    await mkdir(sessionsDir(storageDir), { recursive: true });
    if (nodes.length === 0) {
      await writeFile(path, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
    } else {
      const contents = [
        JSON.stringify(header),
        ...nodes.map((node) => JSON.stringify(node)),
        "",
      ].join("\n");
      const tempPath = join(sessionsDir(storageDir), `.tmp-${id}.jsonl`);
      try {
        await writeFile(tempPath, contents, { encoding: "utf8", flag: "wx" });
        await rename(tempPath, path);
      } catch (error) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
      }
    }
  } catch (error) {
    throw asStorageError("Could not create session storage", error);
  }
  return Session.fromStorage(
    {
      id,
      title: header.title,
      cwd: header.cwd,
      createdAt: header.createdAt,
      updatedAt: header.createdAt,
      ...(header.parentSessionId !== undefined
        ? { parentSessionId: header.parentSessionId }
        : {}),
    },
    nodes,
    jsonlStorage(storageDir, id),
  );
}

/**
 * Restore a persistent Session from its JSONL file, validating the header,
 * every stored row, and the node topology. Only the SessionRepository uses
 * this helper.
 *
 * @internal
 */
export async function openPersistentSession(
  storageDir: string,
  sessionId: string,
): Promise<Session> {
  const path = sessionPath(storageDir, sessionId);
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
  const header = parseHeader(parseJson(lines[0]!, path));
  if (header.id !== sessionId) {
    invalidSession("Session header ID does not match the filename");
  }

  const rows: StoredSessionRow[] = [];
  for (let index = 1; index < lines.length; index++) {
    rows.push(parseRow(parseJson(lines[index]!, path)));
  }
  const nodes = rows.filter((row): row is SessionNode => row.type !== "session_title");
  validateTree(nodes);

  let title = header.title;
  let updatedAt = header.createdAt;
  for (const row of rows) {
    if (row.createdAt > updatedAt) updatedAt = row.createdAt;
    if (row.type === "session_title") title = row.title;
  }

  return Session.fromStorage(
    {
      id: sessionId,
      title,
      cwd: header.cwd,
      createdAt: header.createdAt,
      updatedAt,
      ...(header.parentSessionId !== undefined
        ? { parentSessionId: header.parentSessionId }
        : {}),
    },
    nodes,
    jsonlStorage(storageDir, sessionId),
  );
}

/**
 * List Session metadata from the storage directory, newest first.
 *
 * @internal
 */
export async function listSessions(
  storageDir: string,
): Promise<readonly SessionMetadata[]> {
  const dir = sessionsDir(storageDir);
  let entries: string[];

  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new SessionError("storage", "Could not read sessions directory", {
      cause: error,
    });
  }

  const jsonlFiles = entries.filter(
    (entry) =>
      SESSION_FILE_RE.test(entry) && !entry.startsWith("."),
  );

  const sessions = await Promise.all(
    jsonlFiles.map(async (filename) => {
      const session = await openPersistentSession(
        storageDir,
        filename.replace(/\.jsonl$/, ""),
      );
      return session.metadata;
    }),
  );

  sessions.sort((a, b) => {
    const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
    return byUpdated !== 0 ? byUpdated : b.id.localeCompare(a.id);
  });

  return sessions;
}

/** @internal */
export async function deleteSession(storageDir: string, sessionId: string): Promise<void> {
  const path = sessionPath(storageDir, sessionId);
  try {
    await rm(path, { force: true });
  } catch (error) {
    throw new SessionError("storage", "Could not delete session storage", {
      cause: error,
    });
  }
}
