import type { Context, ModelConfig, StreamFn } from "../ai/types.js";
import type { SessionTitleGenerator } from "../harness/types.js";

const TITLE_SYSTEM_PROMPT =
  "Generate a brief single-line title for this coding session. Return only the title.";

export function createSessionTitleGenerator(
  streamFn: StreamFn,
): SessionTitleGenerator {
  return async (prompt: string, model: ModelConfig): Promise<string> => {
    const context: Context = {
      systemPrompt: TITLE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      tools: [],
    };

    let text = "";
    let finalText = "";
    for await (const event of streamFn(model, context)) {
      if (event.type === "text_delta") {
        text += event.text;
      } else if (event.type === "done") {
        for (const block of event.message.content) {
          if (block.type === "text") finalText += block.text;
        }
      }
    }

    const trimmed = (text || finalText).trim();
    if (trimmed === "") {
      throw new Error("Title generation produced no text");
    }
    return trimmed;
  };
}
