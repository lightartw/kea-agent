import type { Events } from "../events/events.js";
import type { Unregister } from "../events/types.js";
import type { ToolPresentationInput } from "../coding-agent/ui/presentation.js";

const LARGE_OUTPUT_THRESHOLD = 100_000;

export interface CliRenderTarget {
  readonly write: (text: string) => void;
  readonly log: (text: string) => void;
}

export class CliHarnessRenderer {
  constructor(
    private readonly target: CliRenderTarget,
    private readonly renderToolEvent: (event: ToolPresentationInput) => string,
  ) {}

  bind(events: Events, sessionId: string): Unregister {
    const toolCounts = new Map<string, number>();
    const unregister: Unregister[] = [];
    const render = (event: ToolPresentationInput): string => {
      try {
        return this.renderToolEvent(event);
      } catch (error) {
        this.target.log(`[ui error] ${error instanceof Error ? error.message : String(error)}`);
        return "";
      }
    };

    unregister.push(events.on("harness/run-start", (input) => {
      if (input.sessionId !== sessionId) return;
      toolCounts.set(input.runId, 0);
    }));

    unregister.push(events.on("harness/run-end", (input) => {
      if (input.sessionId !== sessionId) return;
      const count = toolCounts.get(input.runId) ?? 0;
      toolCounts.delete(input.runId);
      this.target.log(`session used ${count} tool calls`);
    }));

    unregister.push(events.on("agent/text-delta", (input) => {
      if (input.sessionId !== sessionId) return;
      this.target.write(input.text);
    }));

    unregister.push(events.on("agent/thinking-delta", (input) => {
      if (input.sessionId !== sessionId) return;
      this.target.write(`\x1b[90m${input.thinking}\x1b[0m`);
    }));

    unregister.push(events.on("agent/toolcall-start", (input) => {
      if (input.sessionId !== sessionId) return;
      this.target.log(`\n\x1b[33m[tool] ${input.name}\x1b[0m`);
    }));

    unregister.push(events.on("agent/toolcall-delta", (input) => {
      if (input.sessionId !== sessionId) return;
      this.target.write(input.argumentsDelta);
    }));

    unregister.push(events.on("agent/tool-start", (input) => {
      if (input.sessionId !== sessionId) return;
      const event: ToolPresentationInput = {
        type: "tool_start",
        call: input.call,
      };
      const text = render(event);
      if (text.length > 0) {
        this.target.log(`\n\x1b[33m${text}\x1b[0m`);
      }
    }));

    unregister.push(events.on("agent/tool-end", (input) => {
      if (input.sessionId !== sessionId) return;
      const count = (toolCounts.get(input.runId) ?? 0) + 1;
      toolCounts.set(input.runId, count);
      const event: ToolPresentationInput = {
        type: "tool_end",
        call: input.call,
        result: input.result,
      };
      const text = render(event);
      if (text.length > 0) {
        this.target.log(text);
      }
      if (input.result.content.length > LARGE_OUTPUT_THRESHOLD) {
        this.target.log(`⚠ Large output from ${input.call.name} (${input.result.content.length} characters)`);
      }
    }));

    unregister.push(events.on("agent/tool-rejected", (input) => {
      if (input.sessionId !== sessionId) return;
      const count = (toolCounts.get(input.runId) ?? 0) + 1;
      toolCounts.set(input.runId, count);
      const event: ToolPresentationInput = {
        type: "tool_rejected",
        call: input.call,
        ...(input.effectiveArguments === undefined ? {} : { effectiveArguments: input.effectiveArguments }),
        result: input.result,
        reason: input.reason,
      };
      const text = render(event);
      if (text.length > 0) {
        this.target.log(text);
      }
    }));

    return () => {
      for (const remove of unregister) remove();
    };
  }
}
