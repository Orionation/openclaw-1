import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { captureGatewayToolCallerAssertion } from "../agents/tools/gateway-caller-context.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { resolveGatewayOperatorRoleActor } from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { captureOperatorToolGatewayAuthority } from "./server-plugin-in-process-dispatch.js";

/** Acquire the ambient requester; consumers own retention through their distinct work lifetimes. */
export function captureAmbientGatewayOperatorAuthority(params: {
  missingBindingError: () => Error;
  retainInherited?: true;
}): {
  authority?: AdmittedRunOperatorAuthority;
  assertInvocationCurrent?: () => void;
  release?: () => void;
} {
  const scope = getPluginRuntimeGatewayRequestScope();
  const invocation = captureOperatorToolGatewayAuthority();
  const inheritedOperator = invocation?.authority;
  const context = scope?.context ?? scope?.resolveGatewayContext?.();
  const assertInvocationCurrent =
    inheritedOperator || !scope?.client || !context
      ? invocation?.assertCurrent
      : captureGatewayToolCallerAssertion();
  if (inheritedOperator) {
    if (params.retainInherited) {
      assertAdmittedRunOperatorAuthority(inheritedOperator);
      inheritedOperator.assertCurrent();
    }
    return {
      authority: inheritedOperator,
      assertInvocationCurrent,
      release: params.retainInherited ? inheritedOperator.retain?.() : undefined,
    };
  }
  if (
    scope?.client &&
    !context &&
    resolveGatewayOperatorRoleActor(scope.client)?.kind === "operator"
  ) {
    throw params.missingBindingError();
  }
  const capturedOperator =
    scope?.client && context
      ? captureGatewayOperatorRunAuthority({
          client: scope.client,
          context,
          hasCurrentClientAuthority: scope.hasCurrentClientAuthority,
          invocationAuthority: {
            assertCurrent: () => scope.signal?.throwIfAborted(),
            signal: scope.signal,
          },
        })
      : undefined;
  return { ...capturedOperator, assertInvocationCurrent };
}
