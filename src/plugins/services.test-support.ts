import { createPluginRuntimeCapabilityLease } from "./capability-lease.js";
import { createPluginServiceGatewayEvents } from "./gateway-events.js";
import type { OpenClawPluginSessionsChangedEvent } from "./gateway-events.js";

export function subscribePluginSessionsChanged(
  handler: (event: OpenClawPluginSessionsChangedEvent) => void,
): () => void {
  const events = createPluginServiceGatewayEvents({
    pluginId: "test",
    broadcast: () => undefined,
    lease: createPluginRuntimeCapabilityLease("test"),
  });
  if (!events) {
    throw new Error("Expected Gateway events with a broadcaster");
  }
  return events.onSessionsChanged(handler);
}
