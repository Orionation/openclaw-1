import { validateAgentRunDelegatedAuthority } from "../infra/agent-run-registry.js";
import type {
  AgentRuntimeDelegatedAuthority,
  AgentRuntimeIdentity,
} from "./agent-runtime-identity-token.js";
import { resolveMessageActionTurnCapability } from "./message-action-turn-capability.js";
import type { WorkerSessionTurnClaim } from "./worker-environments/placement-record.js";
import {
  captureWorkerTurnClaimCurrentness,
  type WorkerTurnExecutionIdentityStore,
} from "./worker-environments/placement-turn-claim-events.js";

export type AgentRuntimeApprovalAuthorityValidator = (identity: AgentRuntimeIdentity) => boolean;

/** Builds the use-time approval gate from the run owner and canonical worker store. */
export function createAgentRuntimeApprovalAuthorityValidator(
  placements?: WorkerTurnExecutionIdentityStore,
): AgentRuntimeApprovalAuthorityValidator {
  const workerClaims = new WeakMap<
    AgentRuntimeDelegatedAuthority,
    {
      claim: WorkerSessionTurnClaim;
      isCurrent: () => boolean;
    }
  >();
  return (identity) => {
    const authority = identity.delegatedAuthority;
    if (!validateAgentRunDelegatedAuthority(authority)) {
      return false;
    }
    if (authority.kind === "worker") {
      let captured = workerClaims.get(authority);
      if (!captured) {
        const isCurrent =
          placements && captureWorkerTurnClaimCurrentness(placements, authority.turnClaim);
        if (!isCurrent) {
          return false;
        }
        captured = { claim: authority.turnClaim, isCurrent };
        workerClaims.set(authority, captured);
      }
      if (captured.claim !== authority.turnClaim || !captured.isCurrent()) {
        return false;
      }
    }
    const messageActionContext = identity.messageActionContext;
    if (!messageActionContext) {
      return true;
    }
    if (!messageActionContext.turnCapability) {
      return false;
    }
    return Boolean(
      resolveMessageActionTurnCapability({
        token: messageActionContext.turnCapability,
        agentId: identity.agentId,
        runId: identity.operationalRunInstance.runId,
        sessionKey: identity.sessionKey,
        sessionId: messageActionContext.sessionId,
      }),
    );
  };
}
