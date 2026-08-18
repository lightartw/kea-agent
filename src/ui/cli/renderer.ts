import type {
  AgentMessage,
  AgentToolCall,
  AgentToolResult,
  HarnessEvent,
} from "../../core/harness/index.js";
import type { ModelConfig } from "../../core/ai/index.js";

type HarnessRunEnd = Extract<HarnessEvent, { readonly type: "run-end" }>;

const PREVIEW_LENGTH = 200;

/** One in-flight tool call line: the name opened the line, deltas stream the arguments. */
interface ToolCallStream {
  readonly name: string;
  argsWritten: number;
  truncated: boolean;
}

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
 * display policy, per-Run Tool counts, and in-flight tool call lines are
 * state; rendering failures are reported through the injected logger and
 * never change Agent execution.
 */
export class Renderer {
  private readonly thinking: "hidden" | "visible";
  private readonly toolDetails: "compact" | "full";
  private readonly writeFn: (text: string) => void;
  private readonly logFn: (text: string) => void;
  private readonly toolCounts = new Map<string, number>();
  private readonly toolCallStreams = new Map<string, ToolCallStream>();

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
        case "tool-call-start":
          this.renderToolCallStart(event.runId, event.id, event.name);
          break;
        case "tool-call-delta":
          this.renderToolCallDelta(event.runId, event.id, event.argumentsDelta);
          break;
        case "tool-call":
          this.renderToolCall(event.runId, event.call);
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

  /** Session banner plus the stored history when a Harness becomes active. */
  renderSession(harness: {
    readonly sessionId: string;
    readonly model: ModelConfig;
    readonly messages: readonly AgentMessage[];
  }): void {
    this.writeFn(
      `\nSession ${harness.sessionId} — ${harness.model.provider}/${harness.model.model}`,
    );
    this.renderHistory(harness.messages);
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

  /** Key tool call lines by Run and call id; ids are only unique within a Run. */
  private toolCallKey(runId: string, id: string): string {
    return `${runId}\u0000${id}`;
  }

  /** Open the tool call line; the arguments stream in as deltas. */
  private renderToolCallStart(runId: string, id: string, name: string): void {
    this.toolCallStreams.set(this.toolCallKey(runId, id), {
      name,
      argsWritten: 0,
      truncated: false,
    });
    this.writeFn(`\n⚙ ${name} `);
  }

  /** Stream the arguments JSON in place; compact mode bounds the line. */
  private renderToolCallDelta(runId: string, id: string, argumentsDelta: string): void {
    const stream = this.toolCallStreams.get(this.toolCallKey(runId, id));
    if (stream === undefined || stream.truncated) return;
    if (this.toolDetails === "full") {
      stream.argsWritten += argumentsDelta.length;
      this.writeFn(argumentsDelta);
      return;
    }
    const remaining = PREVIEW_LENGTH - stream.argsWritten;
    if (argumentsDelta.length <= remaining) {
      stream.argsWritten += argumentsDelta.length;
      this.writeFn(argumentsDelta);
      return;
    }
    stream.truncated = true;
    this.writeFn(`${argumentsDelta.slice(0, Math.max(remaining, 0))}…`);
  }

  private renderToolCall(runId: string, call: AgentToolCall): void {
    const stream = this.toolCallStreams.get(this.toolCallKey(runId, call.id));
    if (stream !== undefined) {
      // The arguments were already streamed; only an empty call needs the JSON.
      if (stream.argsWritten === 0) {
        this.writeFn(
          this.toolDetails === "compact"
            ? bounded(JSON.stringify(call.arguments))
            : JSON.stringify(call.arguments),
        );
      }
      return;
    }
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
    const streamPrefix = `${event.runId}\u0000`;
    for (const key of this.toolCallStreams.keys()) {
      if (key.startsWith(streamPrefix)) this.toolCallStreams.delete(key);
    }
    if (event.reason === "error") {
      this.writeFn(`\n✗ run failed: ${event.errorMessage} (${count} tool calls)`);
    } else if (event.reason === "completed") {
      this.writeFn(`\n✓ completed (${count} tool calls)`);
    } else {
      this.writeFn(`\naborted (${count} tool calls)`);
    }
  }
}
