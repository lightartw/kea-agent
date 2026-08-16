import type { ModelRuntime } from "../../src/core/ai/types.js";

export type TestStream = ModelRuntime["stream"];

export function runtimeFromStream(stream: TestStream): ModelRuntime {
  return {
    stream,
    async complete() {
      throw new Error("Unexpected complete() call in stream-only test");
    },
  };
}
