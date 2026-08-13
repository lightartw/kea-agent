import type { HarnessEvent } from "../harness/events/types.js";
import type { CodingToolPresentationRegistry } from "../coding-agent/ui/presentation-registry.js";

const LARGE_OUTPUT_THRESHOLD = 100_000;

export interface CliRenderTarget {
  readonly write: (text: string) => void;
  readonly log: (text: string) => void;
}

export class CliHarnessRenderer {
  constructor(
    private readonly target: CliRenderTarget,
    private readonly presentations: CodingToolPresentationRegistry,
  ) {}

  render(event: HarnessEvent): void {
    try {
      this.renderEvent(event);
    } catch (error) {
      this.target.log(`[ui error] ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private renderEvent(event: HarnessEvent): void {
    switch (event.type) {
      case "text_delta":
        this.target.write(event.text);
        break;
      case "thinking_delta":
        this.target.write(`\x1b[90m${event.thinking}\x1b[0m`);
        break;
      case "toolcall_start":
        this.target.log(`\n\x1b[33m[tool] ${event.name}\x1b[0m`);
        break;
      case "toolcall_delta":
        this.target.write(event.argumentsDelta);
        break;
      case "toolcall_end":
        break;
      case "tool_start":
        this.target.log(`\n\x1b[33m${this.presentations.render(event)}\x1b[0m`);
        break;
      case "tool_end": {
        this.target.log(this.presentations.render(event));
        if (event.result.content.length > LARGE_OUTPUT_THRESHOLD) {
          this.target.log(`⚠ Large output from ${event.call.name} (${event.result.content.length} characters)`);
        }
        break;
      }
      case "tool_rejected":
        this.target.log(this.presentations.render(event));
        break;
      case "agent_end": {
        const toolCount = event.messages.filter((message) => message.role === "tool").length;
        this.target.log(`session used ${toolCount} tool calls`);
        break;
      }
      case "turn_start":
      case "turn_end":
      case "agent_start":
      case "run_start":
      case "run_end":
        break;
    }
  }
}
