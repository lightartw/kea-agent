import type { AgentMessage, AgentToolCall, AgentToolResult } from "../core/agent/index.js";
import type { HarnessEvent } from "../core/harness/index.js";

type HarnessRunEnd = Extract<HarnessEvent, { readonly type: "run-end" }>;

const PREVIEW_LENGTH = 200;

export interface RendererOptions {
  readonly thinking: "hidden" | "visible";
  readonly toolDetails: "compact" | "full";
  readonly write: (text: string) => void;
  readonly log: (text: string) => void;
}

function bounded(text: string, limit = PREVIEW_LENGTH): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Terminal display for user input, Session history, and Harness facts. Only
 * display policy and per-Run Tool counts are state; rendering failures are
 * reported through the injected logger and never change Agent execution.
 */
export class Renderer {
  private readonly thinking: "hidden" | "visible";
  private readonly toolDetails: "compact" | "full";
  private readonly writeFn: (text: string) => void;
  private readonly logFn: (text: string) => void;
  private readonly toolCounts = new Map<string, number>();

  constructor(options: RendererOptions) {
    this.thinking = options.thinking;
    this.toolDetails = options.toolDetails;
    this.writeFn = options.write;
    this.logFn = options.log;
  }

  handle(event: HarnessEvent): void {
    try {
      switch (event.type) {
        case "text-delta":
          this.writeFn(event.text);
          break;
        case "thinking-delta":
          if (this.thinking === "visible") this.writeFn(event.thinking);
          break;
        case "tool-call":
          this.renderToolCall(event.call);
          break;
        case "tool-result":
          this.toolCounts.set(
            event.runId,
            (this.toolCounts.get(event.runId) ?? 0) + 1,
          );
          this.renderToolResult(event.call, event.result);
          break;
        case "run-end":
          this.renderRunEnd(event);
          break;
        default:
          break;
      }
    } catch (error) {
      this.logFn(
        `renderer error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Echo the user's submitted Prompt before the Harness runs it. */
  renderUser(text: string): void {
    this.writeFn(`\n> ${text}`);
  }

  /** Replay a Session's stored messages after restoring it. */
  renderHistory(messages: readonly AgentMessage[]): void {
    for (const message of messages) {
      if (message.role === "user") {
        this.writeFn(`\n> ${message.content}`);
      } else if (message.role === "assistant") {
        const text = message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        if (text !== "") this.writeFn(`\n${text}`);
      } else {
        this.writeFn(`\n[tool] ${message.content}`);
      }
    }
  }

  renderError(message: string): void {
    this.writeFn(`\n✗ ${message}`);
  }

  /** Numbered options for /session and /model selection. */
  renderSelection(prompt: string, options: readonly string[]): void {
    this.writeFn(`\n${prompt}`);
    for (const [index, option] of options.entries()) {
      this.writeFn(`\n${index + 1}. ${option}`);
    }
  }

  renderHelp(): void {
    this.writeFn([
      "",
      "Commands:",
      "  /new      Start a new session",
      "  /session  Switch sessions",
      "  /model    Switch model",
      "  /help     Show this help",
      "  /exit     Quit",
      "",
    ].join("\n"));
  }

  private renderToolCall(call: AgentToolCall): void {
    const argumentsText = this.toolDetails === "compact"
      ? bounded(JSON.stringify(call.arguments))
      : JSON.stringify(call.arguments);
    this.writeFn(`\n⚙ ${call.name} ${argumentsText}`);
  }

  private renderToolResult(call: AgentToolCall, result: AgentToolResult): void {
    if (this.toolDetails === "full") {
      this.writeFn(`\n${result.isError ? "✗" : "✓"} ${call.name}\n${result.content}`);
      return;
    }
    if (result.isError) {
      this.writeFn(`\n✗ ${call.name}: ${bounded(result.content)}`);
    } else {
      this.writeFn(`\n✓ ${call.name}`);
    }
  }

  private renderRunEnd(event: HarnessRunEnd): void {
    const count = this.toolCounts.get(event.runId) ?? 0;
    this.toolCounts.delete(event.runId);
    if (event.reason === "error") {
      this.writeFn(`\n✗ run failed: ${event.errorMessage} (${count} tool calls)`);
    } else if (event.reason === "completed") {
      this.writeFn(`\n✓ completed (${count} tool calls)`);
    } else {
      this.writeFn(`\naborted (${count} tool calls)`);
    }
  }
}
