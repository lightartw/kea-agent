import { resolve } from "node:path";

export type Arguments = {
  readonly continue: boolean;
  readonly config?: string;
  readonly verbose: boolean;
  readonly directory: string;
};

/**
 * Parse production argv before any file, Project, or Runtime work. The
 * optional directory and --config value resolve against process.cwd().
 */
export function parseArguments(argv: readonly string[]): Arguments {
  let continueFlag = false;
  let verbose = false;
  let config: string | undefined;
  let directory: string | undefined;

  let index = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    if (token === "-c") {
      if (continueFlag) throw new Error("Duplicate option: -c");
      continueFlag = true;
      index += 1;
    } else if (token === "--verbose") {
      if (verbose) throw new Error("Duplicate option: --verbose");
      verbose = true;
      index += 1;
    } else if (token === "--config") {
      if (config !== undefined) throw new Error("Duplicate option: --config");
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("Missing value for --config");
      }
      config = resolve(value);
      index += 2;
    } else if (token.startsWith("-")) {
      throw new Error(`Unknown option: ${token}`);
    } else {
      if (directory !== undefined) {
        throw new Error(`Multiple directories: ${token}`);
      }
      directory = resolve(token);
      index += 1;
    }
  }

  return {
    continue: continueFlag,
    ...(config === undefined ? {} : { config }),
    verbose,
    directory: directory ?? process.cwd(),
  };
}
