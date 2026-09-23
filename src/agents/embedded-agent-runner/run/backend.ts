/**
 * Dispatches embedded attempts to native harness or OpenClaw backend execution.
 */
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import {
  runAgentHarnessAttempt,
  runAgentHarnessSettledTurnFinalization,
} from "../../harness/selection.js";
import type { AgentHarness } from "../../harness/types.js";
import type { AgentRuntimeModelAttempt, AgentRuntimePlan } from "../../runtime-plan/types.js";
import {
  markRequesterTurnYielded,
  settleRequesterAfterSessionSpawns,
} from "../../subagents/registry/subagent-registry.js";
import { copyCoreTtsAttemptResultProvenance } from "../../tools/tts-tool-result-provenance.js";
import { prepareAgentWorkspaceAttachments } from "../../workspace-access.js";
import { shouldContinueInteractiveAcceptedSessionSpawns } from "./attempt-terminal-evidence.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

/** Replaces backend-retained provenance with the exact prepared request fact. */
export function resolveRuntimeModelAttempt(
  runtimePlan: AgentRuntimePlan | undefined,
): AgentRuntimeModelAttempt | undefined {
  const credentialSource = runtimePlan?.auth.credentialSource;
  return credentialSource
    ? {
        provider: runtimePlan.resolvedRef.provider,
        model: runtimePlan.resolvedRef.modelId,
        credentialSource,
      }
    : undefined;
}

/**
 * Backend bridge for executing one embedded-agent attempt through the selected harness.
 */
export async function runEmbeddedAttemptWithBackend(
  params: EmbeddedRunAttemptParams,
  nativeSessionRuntime?: Parameters<typeof runAgentHarnessAttempt>[1],
  // Native image projection clears media; attachment transfer still needs the originals.
  attachmentMedia = params.media,
): Promise<EmbeddedRunAttemptResult> {
  const assertAdmittedCurrent = params.admittedRunContext
    ? resolveAdmittedRunActiveAssertion(params.admittedRunContext, params.abortSignal)
    : undefined;
  const attachmentNote = await prepareAgentWorkspaceAttachments({
    workspaceDir: params.workspaceDir,
    turn: {
      config: params.config,
      media: attachmentMedia,
      timeoutMs: params.timeoutMs,
      abortSignal: params.abortSignal,
      userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
    },
    assertCurrent: () => {
      if (!assertAdmittedCurrent) {
        throw new Error("Workspace attachment preparation requires active admitted run authority");
      }
      assertAdmittedCurrent();
      params.hostCapabilities?.assertActive();
    },
  });
  const result = await runAgentHarnessAttempt(
    attachmentNote
      ? {
          ...params,
          prompt: `${params.prompt}\n\n${attachmentNote}`,
          transcriptPrompt: params.transcriptPrompt ?? params.prompt,
        }
      : params,
    nativeSessionRuntime,
  );
  // Native harness fields cannot attest core registry settlement. The built-in
  // runner has already settled at its own attempt boundary.
  let requesterContinuationSettled =
    result.agentHarnessId === "openclaw" && result.requesterContinuationSettled === true;
  if (
    result.agentHarnessId !== "openclaw" &&
    params.sessionKey &&
    result.acceptedSessionSpawns?.length
  ) {
    const implicitContinuation = shouldContinueInteractiveAcceptedSessionSpawns({
      attempt: result,
      run: params,
    });
    if (implicitContinuation) {
      const marked = markRequesterTurnYielded({
        requesterSessionKey: params.sessionKey,
        requesterAgentId: params.agentId,
        requesterTurnRunId: params.runId,
      });
      if (marked === 0) {
        throw new Error("accepted continuation children were not durably registered");
      }
    } else {
      const settled = settleRequesterAfterSessionSpawns({
        requesterSessionKey: params.sessionKey,
        requesterAgentId: params.agentId,
        requesterTurnRunId: params.runId,
        requesterYielded: result.yieldDetected === true,
        acceptedSessionSpawns: result.acceptedSessionSpawns,
      });
      requesterContinuationSettled = result.yieldDetected === true && settled;
    }
  }
  const {
    modelAttempt: _backendModelAttempt,
    runtimeModelSelection,
    requesterContinuationSettled: _backendContinuationSettled,
    ...attempt
  } = result;
  const modelAttempt = resolveRuntimeModelAttempt(params.runtimePlan);
  return copyCoreTtsAttemptResultProvenance(result, {
    ...attempt,
    ...(requesterContinuationSettled ? { requesterContinuationSettled: true as const } : {}),
    ...(modelAttempt ? { modelAttempt } : {}),
    // Only private prepared ownership permits a runtime to select the session model.
    ...(nativeSessionRuntime && runtimeModelSelection
      ? {
          runtimeModelSelection: {
            provider: runtimeModelSelection.provider,
            model: runtimeModelSelection.model,
          },
        }
      : {}),
  });
}

/** Runs one operation-specific settled-turn finalization through the selected harness. */
export async function runEmbeddedSettledTurnFinalizationWithBackend(
  params: EmbeddedRunAttemptParams,
  settledAttempt: EmbeddedRunAttemptResult,
  harness: AgentHarness,
) {
  return runAgentHarnessSettledTurnFinalization(params, settledAttempt, harness);
}
