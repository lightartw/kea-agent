import type { Events } from "../core/events/events.js";

const LARGE_OUTPUT_THRESHOLD = 100_000;
const ARGUMENTS_PREVIEW_LENGTH = 200;
const RESULT_PREVIEW_LENGTH = 2_000;

export interface CliRenderTarget {
  readonly write: (text: string) => void;
  readonly log: (text: string) => void;
}

/** Renders one Harness's events to a terminal-style target. */
export class CliHarnessRenderer {
  constructor(private readonly target: CliRenderTarget) {}

  bind(events: Events, sessionId: string): () => void {
    const toolCounts = new Map<string, number>();
    const unregister: Array<() => void> = [];

    unregister.push(events.on("harness/run-start", (input) => {
      if (input.sessionId !== sessionId) return;
      toolCounts.set(input.runId, 0);
    }));

    unregister.push(events.on("harness/run-end", (input) => {
      if (input.sessionId !== sessionId) return;
      const count = toolCounts.get(input.runId) ?? 0;
      toolCounts.delete(input.runId);
      this.target.log(`session used ${count} tool calls`);
      if (input.reason === "error") {
        this.target.log(`\x1b[31mrun failed: ${input.errorMessage}\x1b[0m`);
      }
    }));

    unregister.push(events.on("agent/text-delta", (input) => {
      if (input.sessionId !== sessionId) return;
      this.target.write(input.text);
    }));

    unregister.push(events.on("agent/thinking-delta", (input) => {
      if (input.sessionId !== sessionId) return;
      this.target.write(`\x1b[90m${input.thinking}\x1b[0m`);
    }));

    unregister.push(events.on("agent/tool-call-start", (input) => {
      if (input.sessionId !== sessionId) return;
      this.target.log(`\n\x1b[33m[tool] ${input.name}\x1b[0m`);
    }));

    unregister.push(events.on("agent/tool-call-delta", (input) => {
      if (input.sessionId !== sessionId) return;
      this.target.write(input.argumentsDelta);
    }));

    unregister.push(events.on("agent/tool-call", (input) => {
      if (input.sessionId !== sessionId) return;
      const summary = summarizeArguments(input.call.arguments);
      if (summary.length > 0) {
        this.target.log(`\x1b[33m  ${summary}\x1b[0m`);
      }
    }));

    unregister.push(events.on("agent/tool-result", (input) => {
      if (input.sessionId !== sessionId) return;
      const count = (toolCounts.get(input.runId) ?? 0) + 1;
      toolCounts.set(input.runId, count);
      this.target.log(
        `\n\x1b[${input.result.isError ? "31" : "32"}m[result] ${input.call.name}\x1b[0m`,
      );
      const preview = input.result.content.length > RESULT_PREVIEW_LENGTH
        ? `${input.result.content.slice(0, RESULT_PREVIEW_LENGTH)}\n…[truncated]`
        : input.result.content;
      if (preview.length > 0) {
        this.target.log(preview);
      }
      if (input.result.content.length > LARGE_OUTPUT_THRESHOLD) {
        this.target.log(`⚠ Large output from ${input.call.name} (${input.result.content.length} characters)`);
      }
    }));

    return () => {
      for (const remove of unregister) remove();
    };
  }
}

function summarizeArguments(arguments_: Record<string, unknown>): string {
  let text: string;
  try {
    text = JSON.stringify(arguments_);
  } catch {
    return "";
  }
  if (text.length > ARGUMENTS_PREVIEW_LENGTH) {
    return `${text.slice(0, ARGUMENTS_PREVIEW_LENGTH)}…`;
  }
  return text;
}
