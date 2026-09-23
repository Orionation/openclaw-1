import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import type {
  DiagnosticEventInput,
  DiagnosticEventPrivateData,
  DiagnosticSecurityEvent,
} from "./diagnostic-events.js";

type DiagnosticContentEvent = DiagnosticEventInput | Omit<DiagnosticSecurityEvent, "seq" | "ts">;

function isPrivateEvent(event: DiagnosticContentEvent): boolean {
  return "sessionKey" in event && isIncognitoSessionKey(event.sessionKey);
}

/** Drop optional content before cloning, liveness delivery, or queue admission. */
export function projectDiagnosticEventContent<T extends DiagnosticContentEvent>(event: T): T {
  if (!isPrivateEvent(event)) {
    return event;
  }
  const projected = {} as T & Record<string, unknown>;
  const fields = event as Record<string, unknown>;
  for (const key of Object.keys(event)) {
    if (
      ((event.type === "message.processed" || event.type === "message.dispatch.completed") &&
        (key === "error" || key === "reason")) ||
      (event.type === "session.state" && key === "reason")
    ) {
      continue;
    }
    Object.defineProperty(projected, key, {
      value:
        event.type === "tool.execution.blocked" && key === "reason"
          ? event.deniedReason
          : event.type === "tool.loop" && key === "message"
            ? `${event.detector}:${event.action}`
            : fields[key],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return projected;
}

/** Skill accounting remains functional; optional model/tool/error capture does not. */
export function admitDiagnosticPrivateData(
  event: DiagnosticContentEvent,
  privateData: DiagnosticEventPrivateData | undefined,
): DiagnosticEventPrivateData | undefined {
  if (!privateData) {
    return undefined;
  }
  if (isPrivateEvent(event)) {
    return privateData.skillUsage ? { skillUsage: privateData.skillUsage } : undefined;
  }
  if (!Object.hasOwn(privateData, "hostPluginId")) {
    return privateData;
  }
  // Only host object-identity provenance may assign plugin attribution.
  const sanitized = { ...privateData } as Record<string, unknown>;
  delete sanitized.hostPluginId;
  return sanitized;
}
