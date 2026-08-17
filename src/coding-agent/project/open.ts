import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

import type { ModelConfig, ModelRuntime } from "../../core/ai/types.js";
import { SessionRepository } from "../../core/harness/session/repository.js";
import { Project, ProjectError } from "./project.js";
import { ProjectStorage } from "./storage.js";

const execFileAsync = promisify(execFile);

/** Result of resolving the Git work-tree root for one directory. */
export type GitToplevelResult =
  | { readonly kind: "root"; readonly root: string }
  | { readonly kind: "not_a_repository" };

export type GitToplevelExecutor = (cwd: string) => Promise<GitToplevelResult>;

const defaultGitToplevel: GitToplevelExecutor = async (cwd) => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd },
    );
    const root = stdout.trim();
    if (root === "") {
      throw new ProjectError(`git rev-parse produced no work-tree root for ${cwd}`);
    }
    return { kind: "root", root: resolve(root) };
  } catch (error) {
    if (isNotARepository(error)) return { kind: "not_a_repository" };
    throw new ProjectError(`Unable to determine the Git work-tree root for ${cwd}`, {
      cause: error,
    });
  }
};

function isNotARepository(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === "string" && /not a git repository/i.test(stderr);
}

let gitToplevelExecutor: GitToplevelExecutor = defaultGitToplevel;

/** Test-only injection point for open.test.ts; openOrCreateProject is the only public entry. */
export function setGitToplevelExecutorForTests(
  executor: GitToplevelExecutor | null,
): void {
  gitToplevelExecutor = executor ?? defaultGitToplevel;
}

/** Resolve a cwd to its real directory path. */
async function requireDirectory(path: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    throw new ProjectError(`Project directory does not exist: ${path}`, { cause: error });
  }
  const info = await stat(real);
  if (!info.isDirectory()) {
    throw new ProjectError(`Project directory is not a directory: ${real}`);
  }
  return real;
}

/**
 * Open the Project owning a startup cwd, creating and persisting a fresh
 * Project when none owns the directory. Never creates a Harness.
 */
export async function openOrCreateProject(options: {
  readonly keaHome: string;
  readonly cwd?: string;
  readonly runtime: ModelRuntime;
  readonly modelConfig: ModelConfig;
}): Promise<Project> {
  const startupCwd = resolve(options.cwd ?? process.cwd());
  const canonicalCwd = await requireDirectory(startupCwd);

  const gitResult = await gitToplevelExecutor(canonicalCwd);
  const projectDirectory = gitResult.kind === "root" ? gitResult.root : canonicalCwd;

  const storage = new ProjectStorage(options.keaHome);
  let info = await storage.findByDirectory(projectDirectory);
  if (info === undefined) {
    const now = new Date().toISOString();
    info = {
      id: randomUUID(),
      name: basename(projectDirectory),
      directory: projectDirectory,
      createdAt: now,
      updatedAt: now,
    };
    await storage.create(info);
  }

  const sessions = new SessionRepository(storage.dataDirectory(info.id));
  return new Project({
    info,
    sessions,
    runtime: options.runtime,
    modelConfig: options.modelConfig,
  });
}
