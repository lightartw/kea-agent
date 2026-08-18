import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

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
      throw new Error(`git rev-parse produced no work-tree root for ${cwd}`);
    }
    return root;
  } catch (error) {
    if (isNotARepository(error)) return undefined;
    throw new Error(`Unable to determine the Git work-tree root for ${cwd}`, {
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
    throw new Error(`Directory does not exist: ${path}`, { cause: error });
  }
  const info = await stat(real);
  if (!info.isDirectory()) {
    throw new Error(`Path is not a directory: ${real}`);
  }
  return real;
}

/**
 * Resolve the canonical Project directory owning a startup directory:
 * absolute, realpath-normalized, then the Git work-tree root when the
 * directory is inside one. Git discovery is an application concern; the
 * Coding Agent factory receives the resolved directory.
 */
export async function resolveProjectDirectory(
  startupDirectory: string,
): Promise<string> {
  const startup = resolve(startupDirectory);
  const canonical = await requireDirectory(startup);
  const gitRoot = await findGitRoot(canonical);
  return gitRoot === undefined ? canonical : await requireDirectory(gitRoot);
}
