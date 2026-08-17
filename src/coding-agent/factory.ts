import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

import type { ModelConfig, ModelRuntime } from "../core/ai/types.js";
import { SessionRepository } from "../core/harness/session/repository.js";
import { createBuiltinEvents } from "./events/factory.js";
import type { PermissionRule } from "./events/permission/permission.js";
import type { Interactions } from "./interaction/interactions.js";
import { Project, ProjectError } from "./project/project.js";
import { ProjectStorage } from "./project/storage.js";

const execFileAsync = promisify(execFile);

async function findGitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      {
        cwd,
        env: { ...process.env, LANG: "C", LC_ALL: "C" },
      },
    );
    const root = stdout.trim();
    if (root === "") {
      throw new ProjectError(`git rev-parse produced no work-tree root for ${cwd}`);
    }
    return root;
  } catch (error) {
    if (isNotARepository(error)) return undefined;
    throw new ProjectError(`Unable to determine the Git work-tree root for ${cwd}`, {
      cause: error,
    });
  }
}

function isNotARepository(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === "string" && /not a git repository/i.test(stderr);
}

/** Resolve an existing directory to its real path. */
async function requireDirectory(path: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    throw new ProjectError(`Directory does not exist: ${path}`, { cause: error });
  }
  const info = await stat(real);
  if (!info.isDirectory()) {
    throw new ProjectError(`Path is not a directory: ${real}`);
  }
  return real;
}

/**
 * Project runtime composition root.
 *
 * Resolves the Project owning a startup cwd, creates its durable record when
 * needed, then assembles one fresh Project runtime. The returned Project owns
 * one in-memory approval scope and one builtin Events bus shared by all of its
 * Harnesses; each Harness creates its own Tool Registry later. This function
 * never creates a Harness.
 */
export async function openOrCreateProject(options: {
  readonly keaHome: string;
  readonly cwd?: string;
  readonly runtime: ModelRuntime;
  readonly modelConfig: ModelConfig;
  readonly interactions: Interactions;
  readonly onListenerError?: (
    error: unknown,
    name: string,
    input: unknown,
  ) => void;
}): Promise<Project> {
  // Resolve the durable Project identity from the canonical startup directory.
  const startupCwd = resolve(options.cwd ?? process.cwd());
  const canonicalCwd = await requireDirectory(startupCwd);

  const gitRoot = await findGitRoot(canonicalCwd);
  const projectDirectory = gitRoot === undefined
    ? canonicalCwd
    : await requireDirectory(gitRoot);

  // Reuse the persisted Project record, or create it on first open.
  const storage = new ProjectStorage(options.keaHome);
  let info = await storage.findByDirectory(projectDirectory);
  if (info === undefined) {
    const now = new Date().toISOString();
    info = {
      id: randomUUID(),
      name: basename(projectDirectory) || projectDirectory,
      directory: projectDirectory,
      createdAt: now,
      updatedAt: now,
    };
    await storage.create(info);
  }

  // Assemble fresh Project-scoped runtime state around the durable record.
  const sessions = new SessionRepository(storage.dataDirectory(info.id));
  const approved: PermissionRule[] = [];
  const events = createBuiltinEvents({
    interactions: options.interactions,
    approved,
    trustedDirectories: [projectDirectory],
    ...(options.onListenerError === undefined
      ? {}
      : { onListenerError: options.onListenerError }),
  });
  return new Project({
    info,
    sessions,
    runtime: options.runtime,
    modelConfig: options.modelConfig,
    events,
  });
}
