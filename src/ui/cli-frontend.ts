import { createInterface, type Interface } from "node:readline/promises";

import type {
  CodingAgentInteractions,
  CodingAgentRuntime,
} from "../coding-agent/index.js";
import { CliHarnessRenderer } from "./cli-harness-renderer.js";
import { CliInteractions } from "./cli-interactions.js";

const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

interface CliFrontendOptions {
  readonly interactions?: CliInteractions;
  readonly readline?: Interface;
  readonly input?: NodeJS.ReadStream;
  readonly write?: (text: string) => void;
  readonly log?: (text: string) => void;
}

/** The readline presentation adapter; core modules never import this class. */
export class CliFrontend {
  private readonly readline: Interface;
  private readonly cliInteractions: CliInteractions;
  private readonly writeFn: (text: string) => void;
  private readonly logFn: (text: string) => void;

  constructor(options: CliFrontendOptions = {}) {
    this.readline = options.readline ??
      createInterface({ input: process.stdin, output: process.stdout });
    this.cliInteractions = options.interactions ?? new CliInteractions({
      readline: this.readline,
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.log !== undefined ? { log: options.log } : {}),
    });
    this.writeFn = options.write ?? ((text: string) => process.stdout.write(text));
    this.logFn = options.log ?? ((text: string) => console.log(text));
  }

  /** The interaction adapter, available for factory injection. */
  get interactions(): CodingAgentInteractions {
    return this.cliInteractions;
  }

  /** Keep accepting user turns while AgentHarness owns conversation state. */
  async run(runtime: CodingAgentRuntime): Promise<void> {
    const renderer = new CliHarnessRenderer(
      { write: this.writeFn, log: this.logFn },
      runtime.renderToolEvent,
    );
    const unsubscribe = runtime.harness.subscribe((event) => {
      renderer.render(event);
    });

    this.logFn("Agent Loop");
    this.logFn("Press Enter to send. ESC to abort streaming. 'q' to quit.\n");

    try {
      while (true) {
        let query: string;
        try {
          query = await this.readline.question(`${CYAN}>> ${RESET}`);
        } catch {
          break;
        }
        if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;

        const unbind = this.cliInteractions.bindRunAbort(() => runtime.harness.abort());
        try {
          await runtime.harness.prompt(query);
        } finally {
          unbind();
        }
        this.logFn("");
      }
    } finally {
      unsubscribe();
    }
  }

  /** Safe to call after normal exit, Ctrl+C, or startup failure. */
  close(): void {
    this.cliInteractions.close();
  }
}
