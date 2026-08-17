import { resolve } from "node:path";

/**
 * Resolve one Tool path input against the Session cwd. Deliberately
 * policy-free: it never checks containment or existence, so Tools stay
 * independent of workspace and approval concerns.
 */
export function resolveToolPath(cwd: string, input: string): string {
  return resolve(cwd, input);
}
