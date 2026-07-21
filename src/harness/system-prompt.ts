/**
 * Format a system prompt for the LLM context window.
 *
 * Supported template variables:
 *   {{cwd}}   — absolute workspace path
 *   {{date}}  — current date in YYYY-MM-DD format
 */
export function formatSystemPrompt(
  content: string,
  options?: { readonly cwd?: string; readonly date?: Date },
): string {
  let formatted = content;
  if (options?.cwd !== undefined) {
    formatted = formatted.replace(/\{\{cwd\}\}/g, options.cwd);
  }
  if (options?.date !== undefined) {
    const yyyy = options.date.getFullYear();
    const mm = String(options.date.getMonth() + 1).padStart(2, "0");
    const dd = String(options.date.getDate()).padStart(2, "0");
    formatted = formatted.replace(/\{\{date\}\}/g, `${yyyy}-${mm}-${dd}`);
  }
  return formatted;
}
