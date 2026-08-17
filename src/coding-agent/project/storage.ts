import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  ProjectError,
  PROJECT_ID_PATTERN,
  type ProjectInfo,
  validateProjectInfo,
} from "./project.js";

const PROJECT_VERSION = 1;
const RECORD_KEYS = [
  "version",
  "id",
  "name",
  "directory",
  "createdAt",
  "updatedAt",
] as const;
const RECORD_FILE = "project.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate the exact version-1 disk shape and return a fresh ProjectInfo value. */
function parseProjectDocument(raw: unknown): ProjectInfo {
  if (!isRecord(raw)) {
    throw new ProjectError("Project record must be a JSON object");
  }
  const keys = Object.keys(raw);
  if (keys.length !== RECORD_KEYS.length || RECORD_KEYS.some((key) => !(key in raw))) {
    throw new ProjectError(`Project record must contain exactly ${RECORD_KEYS.join(", ")}`);
  }
  if (raw.version !== PROJECT_VERSION) {
    throw new ProjectError(`Unsupported project record version: ${String(raw.version)}`);
  }
  const info: ProjectInfo = {
    id: raw.id as string,
    name: raw.name as string,
    directory: raw.directory as string,
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
  };
  validateProjectInfo(info);
  return info;
}

/** Throw when the target exists; pass through every other stat failure. */
async function assertAbsent(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new ProjectError(`Project data directory already exists: ${path}`);
}

/**
 * The concrete JSON Project backend for one keaHome. Owns only Project
 * persistence: it never resolves cwd/Git, generates ProjectInfo, constructs
 * Project, or touches Session files.
 */
export class ProjectStorage {
  private readonly projectsDir: string;

  constructor(keaHome: string) {
    this.projectsDir = join(resolve(keaHome), "projects");
  }

  /** Project data directory for a valid ID; performs no I/O. */
  dataDirectory(projectId: string): string {
    if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
      throw new ProjectError(`Project ID is invalid: ${projectId}`);
    }
    return join(this.projectsDir, projectId);
  }

  async findByDirectory(directory: string): Promise<ProjectInfo | undefined> {
    let normalized = resolve(directory);
    try {
      normalized = await realpath(normalized);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ProjectError(`Could not resolve Project directory ${directory}`, {
          cause: error,
        });
      }
    }
    let entries: string[];
    try {
      entries = await readdir(this.projectsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new ProjectError(`Could not read projects directory ${this.projectsDir}`, {
        cause: error,
      });
    }

    const matches: ProjectInfo[] = [];
    for (const entry of entries) {
      if (!PROJECT_ID_PATTERN.test(entry)) continue;
      const info = await this.readRecord(entry);
      if (info.directory === normalized) matches.push(info);
    }
    if (matches.length > 1) {
      throw new ProjectError(
        `More than one project owns directory ${normalized}: `
        + matches.map((match) => match.id).join(", "),
      );
    }
    return matches[0];
  }

  async create(info: ProjectInfo): Promise<void> {
    validateProjectInfo(info);
    const finalDir = this.dataDirectory(info.id);
    const tmpDir = join(this.projectsDir, `.tmp-${randomUUID()}`);
    try {
      await mkdir(this.projectsDir, { recursive: true });
      await mkdir(tmpDir);
      await writeFile(
        join(tmpDir, RECORD_FILE),
        `${JSON.stringify({
          version: PROJECT_VERSION,
          id: info.id,
          name: info.name,
          directory: info.directory,
          createdAt: info.createdAt,
          updatedAt: info.updatedAt,
        }, null, 2)}\n`,
        "utf8",
      );
      await assertAbsent(finalDir);
      await rename(tmpDir, finalDir);
    } catch (error) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async readRecord(projectId: string): Promise<ProjectInfo> {
    const recordPath = join(this.dataDirectory(projectId), RECORD_FILE);
    let contents: string;
    try {
      contents = await readFile(recordPath, "utf8");
    } catch (error) {
      throw new ProjectError(`Could not read project record ${recordPath}`, { cause: error });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(contents);
    } catch (error) {
      throw new ProjectError(`Project record ${recordPath} contains invalid JSON`, {
        cause: error,
      });
    }
    try {
      const info = parseProjectDocument(raw);
      if (info.id !== projectId) {
        throw new ProjectError(
          `Project record ID ${info.id} does not match directory ${projectId}`,
        );
      }
      return info;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ProjectError(`Project record ${recordPath} is invalid: ${detail}`, {
        cause: error,
      });
    }
  }
}
