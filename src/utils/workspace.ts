import { relative, resolve } from "node:path";

/** Resolve a tool path and reject paths that leave the configured workspace. */
export function safePath(workspace: string, path: string): string {
  const resolved = resolve(workspace, path);
  const fromWorkspace = relative(workspace, resolved);
  if (
    fromWorkspace === ".." ||
    fromWorkspace.startsWith("..\\") ||
    fromWorkspace.startsWith("../")
  ) {
    throw new Error(`Path escapes workspace: ${path}`);
  }
  return resolved;
}
