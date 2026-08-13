import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type {
  OpenProjectInput,
  OpenedProject,
  ProjectInfo,
  UpdateProjectInput,
} from "./types.js";

const PROJECT_VERSION = 1;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const execFileAsync = promisify(execFile);

class ProjectError extends Error {}

function projectDir(keaHome: string, projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new ProjectError(`Project ID is invalid: ${projectId}`);
  }
  return resolve(keaHome, "projects", projectId);
}

function projectPath(keaHome: string, projectId: string): string {
  return resolve(projectDir(keaHome, projectId), "project.json");
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

function parseProjectInfo(raw: unknown): ProjectInfo {
  if (!isRecord(raw) || raw.version !== PROJECT_VERSION ||
    !isString(raw.id) || !PROJECT_ID_PATTERN.test(raw.id) ||
    !isString(raw.name) || raw.name.trim() === "" ||
    !Array.isArray(raw.directories) ||
    !isString(raw.primaryDirectory) ||
    !isTimestamp(raw.createdAt) || !isTimestamp(raw.updatedAt)) {
    throw new ProjectError("Project file has invalid fields");
  }

  const directories = (raw.directories as unknown[]).map((value) => {
    if (!isString(value)) throw new ProjectError("Project directory is not a string");
    return resolve(value);
  });
  if (directories.length === 0) {
    throw new ProjectError("Project must contain at least one directory");
  }
  for (const directory of directories) {
    if (directories.filter((candidate) => candidate === directory).length > 1) {
      throw new ProjectError(`Project directory is duplicated: ${directory}`);
    }
  }

  const primaryDirectory = resolve(raw.primaryDirectory);
  if (!directories.includes(primaryDirectory)) {
    throw new ProjectError("Project primary directory must be registered");
  }

  return {
    id: raw.id,
    name: raw.name.trim(),
    directories,
    primaryDirectory,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

export async function readProjectInfo(keaHome: string, projectId: string): Promise<ProjectInfo> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(projectPath(keaHome, projectId), "utf8"));
  } catch (error) {
    throw new ProjectError(`Could not read project ${projectId}: ${String(error)}`);
  }
  return parseProjectInfo(raw);
}

/** Persist Project state; returns the Project storage directory. */
export async function persistProject(keaHome: string, info: ProjectInfo): Promise<string> {
  const dir = projectDir(keaHome, info.id);
  await mkdir(dir, { recursive: true });
  const target = projectPath(keaHome, info.id);
  const temporary = `${target}.tmp`;
  const contents = JSON.stringify({
    version: PROJECT_VERSION,
    id: info.id,
    name: info.name,
    directories: [...info.directories],
    primaryDirectory: info.primaryDirectory,
    createdAt: info.createdAt,
    updatedAt: info.updatedAt,
  }, null, 2);
  try {
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, target);
  } catch (error) {
    throw new ProjectError(`Could not persist project ${info.id}: ${String(error)}`);
  }
  return dir;
}

function validateProjectUpdate(
  current: ProjectInfo,
  input: UpdateProjectInput,
): ProjectInfo {
  const name = input.name === undefined ? current.name : input.name.trim();
  if (name === "") throw new ProjectError("Project name must not be empty");

  let directories = current.directories;
  if (input.directories !== undefined) {
    if (input.directories.length === 0) {
      throw new ProjectError("Project must contain at least one directory");
    }
    directories = input.directories.map((directory) => resolve(directory));
    for (const directory of directories) {
      if (directories.filter((candidate) => candidate === directory).length > 1) {
        throw new ProjectError(`Project directory is duplicated: ${directory}`);
      }
    }
  }

  const primaryDirectory = input.primaryDirectory === undefined
    ? current.primaryDirectory
    : resolve(input.primaryDirectory);
  if (!directories.includes(primaryDirectory)) {
    throw new ProjectError("Project primary directory must be registered");
  }

  const changed = name !== current.name ||
    directories.length !== current.directories.length ||
    directories.some((directory, index) => directory !== current.directories[index]) ||
    primaryDirectory !== current.primaryDirectory;

  return {
    id: current.id,
    name,
    directories,
    primaryDirectory,
    createdAt: current.createdAt,
    updatedAt: changed ? new Date().toISOString() : current.updatedAt,
  };
}

export function applyProjectUpdate(
  info: ProjectInfo,
  input: UpdateProjectInput,
): ProjectInfo {
  return validateProjectUpdate(info, input);
}

function normalizeDirectory(value: string): string {
  return resolve(value);
}

function isSameOrBelow(candidate: string, base: string): boolean {
  const fromBase = relative(base, candidate);
  return fromBase === "" || (!fromBase.startsWith(`..${sep}`) && fromBase !== "..");
}

async function discoverGitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    });
    const root = stdout.trim();
    return root.length > 0 ? resolve(root) : undefined;
  } catch {
    return undefined;
  }
}

async function scanProjects(keaHome: string): Promise<ProjectInfo[]> {
  const projectsRoot = resolve(keaHome, "projects");
  let entries;
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects: ProjectInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !PROJECT_ID_PATTERN.test(entry.name)) continue;
    try {
      projects.push(await readProjectInfo(keaHome, entry.name));
    } catch {
      // Skip invalid Project files during discovery.
    }
  }
  return projects;
}

function assertNoDuplicateDirectories(projects: readonly ProjectInfo[]): void {
  const seen = new Map<string, string>();
  for (const project of projects) {
    for (const directory of project.directories) {
      const owner = seen.get(directory);
      if (owner !== undefined && owner !== project.id) {
        throw new ProjectError(`Project directory ${directory} is owned by multiple Projects`);
      }
      seen.set(directory, project.id);
    }
  }
}

function matchProject(
  projects: readonly ProjectInfo[],
  initialCwd: string,
): { project: ProjectInfo; matchedDirectory: string } | undefined {
  let best: { project: ProjectInfo; matchedDirectory: string } | undefined;
  for (const project of projects) {
    for (const directory of project.directories) {
      if (!isSameOrBelow(initialCwd, directory)) continue;
      if (best === undefined || directory.length > best.matchedDirectory.length) {
        best = { project, matchedDirectory: directory };
      }
    }
  }
  return best;
}

/** Validate that every directory is owned by exactly one Project. */
export async function assertDirectoryOwnership(
  keaHome: string,
  projectId: string,
  directories: readonly string[],
): Promise<void> {
  const projects = (await scanProjects(keaHome)).filter((project) => project.id !== projectId);
  const seen = new Map<string, string>();
  for (const project of projects) {
    for (const directory of project.directories) {
      seen.set(directory, project.id);
    }
  }
  for (const directory of directories) {
    const normalized = normalizeDirectory(directory);
    const owner = seen.get(normalized);
    if (owner !== undefined) {
      throw new ProjectError(`Project directory ${normalized} is owned by Project ${owner}`);
    }
  }
}

export async function openOrCreateProject(input: OpenProjectInput): Promise<OpenedProject> {
  const keaHome = resolve(input.keaHome);

  let explicitDirectory: string | undefined;
  if (input.directory !== undefined) {
    explicitDirectory = normalizeDirectory(input.directory);
    const stats = await stat(explicitDirectory).catch(() => undefined);
    if (stats === undefined || !stats.isDirectory()) {
      throw new ProjectError(`Project directory does not exist or is not a directory: ${explicitDirectory}`);
    }
  }

  const initialCwd = normalizeDirectory(explicitDirectory ?? input.cwd ?? process.cwd());

  const projects = await scanProjects(keaHome);
  assertNoDuplicateDirectories(projects);

  const matched = matchProject(projects, initialCwd);
  if (matched !== undefined) {
    return {
      info: matched.project,
      storageDir: projectDir(keaHome, matched.project.id),
      initialCwd,
    };
  }

  let root: string;
  if (input.directory !== undefined) {
    root = normalizeDirectory(input.directory);
  } else {
    root = (await discoverGitRoot(initialCwd)) ?? initialCwd;
  }

  const now = new Date().toISOString();
  const info: ProjectInfo = {
    id: `project_${randomUUID()}`,
    name: root.split(sep).at(-1) ?? root,
    directories: [root],
    primaryDirectory: root,
    createdAt: now,
    updatedAt: now,
  };
  const storageDir = await persistProject(keaHome, info);
  return { info, storageDir, initialCwd };
}
