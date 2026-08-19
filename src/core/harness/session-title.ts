import type { ModelConfig, ModelRuntime } from "../ai/types.js";
import type { Session } from "./session/session.js";

const DEFAULT_TITLE = "unknown";
const MAX_TITLE_LENGTH = 100;
// Generous output budget: reasoning models consume tokens on thinking before
// the title, so a tiny budget truncates the completion and yields no title.
const TITLE_MAX_TOKENS = 1024;
// Input cap: a long first prompt needs no full context to produce a title.
const TITLE_INPUT_LIMIT = 1000;

const TITLE_SYSTEM_PROMPT = [
  "Generate a concise session title from the user's first message.",
  "Return only the title as a single line, without Markdown or quotation marks.",
  "Preserve the user's language and use at most 100 characters.",
].join(" ");

function titleFromResponse(
  response: Awaited<ReturnType<ModelRuntime["complete"]>>,
): string | undefined {
  // A title only needs the first non-empty text line. Accept a truncated
  // completion too; only error/abort carry no usable title.
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    return undefined;
  }

  const firstLine = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (firstLine === undefined) return undefined;

  const unquoted = firstLine
    .replace(/^["'`“‘]+/u, "")
    .replace(/["'`”’]+$/u, "")
    .trim();
  if (unquoted === "") return undefined;

  const characters = Array.from(unquoted);
  return characters.length <= MAX_TITLE_LENGTH
    ? unquoted
    : `${characters.slice(0, MAX_TITLE_LENGTH - 3).join("")}...`;
}

function truncateChars(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length <= limit
    ? text
    : `${chars.slice(0, limit - 3).join("")}...`;
}

/** Deterministic last-resort title: collapse to one line and trim. */
function fallbackTitleFromText(text: string): string | undefined {
  const singleLine = text.replace(/\s+/gu, " ").trim();
  if (singleLine === "") return undefined;
  return truncateChars(singleLine, MAX_TITLE_LENGTH);
}

/**
 * Generate a session title from the first non-empty user message. The model
 * produces a natural title; if that fails or is empty, the truncated prompt
 * text itself is used as a deterministic fallback, so the title never stays
 * at the default. Re-runs are guarded by the "still default" check.
 */
export async function ensureSessionTitle(input: {
  readonly session: Session;
  readonly runtime: ModelRuntime;
  readonly model: ModelConfig;
  readonly signal?: AbortSignal;
}): Promise<void> {
  try {

    // Awlays try until title is not DEFAULT_TITLE
    if (input.session.metadata.title !== DEFAULT_TITLE) return;

    let source: string | undefined;
    for (const message of input.session.messages()) {
      if (message.role === "user" && typeof message.content === "string" && message.content.trim() !== "") {
        source = message.content;
        break;
      }
    }
    if (source === undefined) return;

    let title: string | undefined;
    try {
      const response = await input.runtime.complete(
        input.model,
        {
          systemPrompt: TITLE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: truncateChars(source, TITLE_INPUT_LIMIT) }],
        },
        {
          maxTokens: TITLE_MAX_TOKENS,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
      );
      title = titleFromResponse(response);
    } catch {
      title = undefined;
    }

    const finalTitle = title ?? fallbackTitleFromText(source);
    if (finalTitle === undefined) return;

    await input.session.setTitle(finalTitle);
  } catch {
    // A title is optional metadata; failure must not prevent the Agent Run.
  }
}
