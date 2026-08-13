import type { CodingAgentInteractions } from "./types.js";

export const NO_INTERACTIONS: CodingAgentInteractions = Object.freeze({
  available: false,
  async confirm() { return false; },
  notify() { return undefined; },
});
