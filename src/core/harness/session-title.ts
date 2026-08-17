import type { ModelConfig, ModelRuntime } from "../ai/types.js";
import type { Session } from "./session/session.js";

const DEFAULT_TITLE = "unknown";
const MAX_TITLE_LENGTH = 100;
const TITLE_MAX_TOKENS = 64;

const TITLE_SYSTEM_PROMPT = [
  "Generate a concise session title from the user's first message.",
  "Return only the title as a single line, without Markdown or quotation marks.",
  "Preserve the user's language and use at most 100 characters.",
].join(" ");

function titleFromResponse(
  response: Awaited<ReturnType<ModelRuntime["complete"]>>,
): string | undefined {
  if (response.stopReason !== "stop") return undefined;

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

/** Generate the title only for the first persisted user message. */
export async function ensureSessionTitle(input: {
  readonly session: Session;
  readonly prompt: string;
  readonly runtime: ModelRuntime;
  readonly model: ModelConfig;
  readonly signal?: AbortSignal;
}): Promise<void> {
  try {
    if (input.session.metadata.title !== DEFAULT_TITLE) return;

    const messages = input.session.messages();
    if (
      messages.length !== 1
      || messages[0]?.role !== "user"
      || messages[0].content !== input.prompt
    ) {
      return;
    }

    const response = await input.runtime.complete(
      input.model,
      {
        systemPrompt: TITLE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: input.prompt }],
      },
      {
        maxTokens: TITLE_MAX_TOKENS,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
    const title = titleFromResponse(response);
    if (title === undefined) return;

    await input.session.setTitle(title);
  } catch {
    // A title is optional metadata; failure must not prevent the Agent Run.
  }
}
