import type { ModelRuntime } from "../../src/core/ai/types.js";
import type { StreamFn } from "../../src/core/agent/types.js";

export type TestStream = StreamFn;

export function runtimeFromStream(stream: TestStream): ModelRuntime {
  return {
    stream,
    async complete() {
      throw new Error("Unexpected complete() call in stream-only test");
    },
  };
}
