/** Convert an unknown thrown value into a stable human-readable message. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
