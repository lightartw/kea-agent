import { Events } from "../../events/events.js";
import type { CodingAgentInteractions } from "../ui/interactions.js";
import { registerPermission } from "./builtin/permission.js";

export function registerCodingEvents(
  events: Events,
  interactions: CodingAgentInteractions,
): void {
  registerPermission(events, interactions);
}
