import { relative, resolve, sep } from "node:path";

function isInside(path: string, directory: string): boolean {
  const base = resolve(directory);
  return path === base || path.startsWith(base + sep);
}

/**
 * Resolve a tool path and reject paths that leave every configured Project
 * directory. Relative input is resolved from `cwd`; the resolved target must
 * equal or lie below at least one of the Project directories.
 */
export function safePath(
  cwd: string,
  directories: readonly string[],
  path: string,
): string {
  const resolved = resolve(cwd, path);
  const accepted = directories.some((directory) => isInside(resolved, directory));
  if (!accepted) {
    const rel = relative(resolve(cwd), resolved);
    throw new Error(`Path escapes project directories: ${path} (${rel})`);
  }
  return resolved;
}
