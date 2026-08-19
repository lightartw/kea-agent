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
  readonly color?: boolean;
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
  private readonly color: boolean;
  private readonly writeFn: (text: string) => void;
  private readonly logFn: (text: string) => void;
  private readonly toolCounts = new Map<string, number>();
  private readonly toolCallStreams = new Map<string, ToolCallStream>();
  private readonly thinkingRuns = new Set<string>();

  constructor(options: RendererOptions) {
    this.thinking = options.thinking;
    this.toolDetails = options.toolDetails;
    this.color = options.color ?? true;
    this.writeFn = options.write;
    this.logFn = options.log;
  }

  /** ANSI styling; a no-op when color is disabled. */
  private style(code: number, text: string): string {
    return this.color ? `\u001b[${code}m${text}\u001b[0m` : text;
  }

  handle(event: HarnessEvent): void {
    try {
      switch (event.type) {
        case "turn-start":
          this.renderThinkingIndicator(event.runId);
          break;
        case "turn-end":
          this.clearThinkingIndicator(event.runId);
          break;
        case "text-delta":
          this.clearThinkingIndicator(event.runId);
          this.writeFn(event.text);
          break;
        case "thinking-delta":
          this.clearThinkingIndicator(event.runId);
          if (this.thinking === "visible") this.writeFn(this.style(2, event.thinking));
          break;
        case "tool-call-start":
          this.clearThinkingIndicator(event.runId);
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
          this.clearThinkingIndicator(event.runId);
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
      `\n${this.style(36, `Session ${harness.sessionId} — ${harness.model.provider}/${harness.model.model}`)}\n`,
    );
    this.renderHistory(harness.messages);
  }

  /** Replay a Session's stored messages after restoring it. */
  renderHistory(messages: readonly AgentMessage[]): void {
    for (const message of messages) {
      if (message.role === "user") {
        this.writeFn(`\n${this.style(1, `> ${message.content}`)}\n`);
      } else if (message.role === "assistant") {
        const text = message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        if (text !== "") this.writeFn(`\n${text}\n`);
      } else {
        // Tool messages replay like the live tool result, so restored history
        // matches the current run's rendering.
        this.renderToolResultLine(
          message.name,
          message.isError ?? false,
          message.content,
        );
      }
    }
  }

  renderError(message: string): void {
    this.writeFn(`\n${this.style(31, `✗ ${message}`)}\n`);
  }

  /** Numbered options for /session and /model selection. */
  renderSelection(prompt: string, options: readonly string[]): void {
    this.writeFn(`\n${prompt}\n`);
    for (const [index, option] of options.entries()) {
      this.writeFn(`${index + 1}. ${option}\n`);
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

  /** Styled "⚙ name" marker shared by streamed and one-shot tool call lines. */
  private toolCallLabel(name: string): string {
    return this.style(36, `⚙ ${name}`);
  }

  /** Bounded JSON for a tool call's arguments, per toolDetails mode. */
  private toolArgumentsText(arguments_: Record<string, unknown>): string {
    const json = JSON.stringify(arguments_);
    return this.toolDetails === "compact" ? bounded(json) : json;
  }

  /** Open a tool call line; the arguments stream in as deltas. */
  private renderToolCallStart(runId: string, id: string, name: string): void {
    this.toolCallStreams.set(this.toolCallKey(runId, id), {
      name,
      argsWritten: 0,
      truncated: false,
    });
    this.writeFn(`\n${this.toolCallLabel(name)} `);
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

  /**
   * Close a tool call line. If the arguments were already streamed, only a
   * still-empty line needs its JSON appended; otherwise the whole line is
   * rendered at once.
   */
  private renderToolCall(runId: string, call: AgentToolCall): void {
    const stream = this.toolCallStreams.get(this.toolCallKey(runId, call.id));
    if (stream !== undefined) {
      if (stream.argsWritten === 0) {
        this.writeFn(this.toolArgumentsText(call.arguments));
      }
      return;
    }
    this.writeFn(`\n${this.toolCallLabel(call.name)} ${this.toolArgumentsText(call.arguments)}`);
  }

  private renderToolResult(call: AgentToolCall, result: AgentToolResult): void {
    this.renderToolResultLine(call.name, result.isError, result.content);
  }

  /** One styled tool-result line; shared by live results and history replay. */
  private renderToolResultLine(name: string, isError: boolean, content: string): void {
    const marker = isError ? "✗" : "✓";
    const code = isError ? 31 : 32;
    if (this.toolDetails === "full") {
      this.writeFn(`\n${this.style(code, `${marker} ${name}`)}\n${content}\n`);
      return;
    }
    if (isError) {
      this.writeFn(`\n${this.style(code, `${marker} ${name}: ${bounded(content)}`)}\n`);
    } else {
      const preview = bounded(content);
      this.writeFn(`\n${this.style(code, preview === "" ? `${marker} ${name}` : `${marker} ${name}: ${preview}`)}\n`);
    }
  }

  /** Show a dim "thinking…" indicator while the model works without output. */
  private renderThinkingIndicator(runId: string): void {
    if (this.thinkingRuns.has(runId)) return;
    this.thinkingRuns.add(runId);
    this.writeFn(`\n${this.style(2, "💭 thinking…")}`);
  }

  /** End the thinking indicator line once real output arrives. */
  private clearThinkingIndicator(runId: string): void {
    if (!this.thinkingRuns.has(runId)) return;
    this.thinkingRuns.delete(runId);
    this.writeFn("\n");
  }

  private renderRunEnd(event: HarnessRunEnd): void {
    const count = this.toolCounts.get(event.runId) ?? 0;
    this.toolCounts.delete(event.runId);
    const streamPrefix = `${event.runId}\u0000`;
    for (const key of this.toolCallStreams.keys()) {
      if (key.startsWith(streamPrefix)) this.toolCallStreams.delete(key);
    }
    if (event.reason === "error") {
      this.writeFn(`\n${this.style(31, `✗ run failed: ${event.errorMessage} (${count} tool calls)`)}\n`);
    } else if (event.reason === "completed") {
      this.writeFn(`\n${this.style(32, `✓ completed (${count} tool calls)`)}\n`);
    } else {
      this.writeFn(`\n${this.style(2, `aborted (${count} tool calls)`)}\n`);
    }
  }
}
