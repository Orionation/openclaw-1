import { createHash } from "node:crypto";
import type { AgentReasoningParam } from "openai/resources/beta/agents/agents";
import {
  buildCurrentInboundPrompt,
  createAgentHarnessAttemptCancellation,
  createAgentHarnessAttemptDeadlineController,
  createAgentHarnessAttemptLifecycle,
  emitAgentHarnessAttemptEvent,
  selectSupportedReasoningEffort,
  type AgentHarnessAttemptTimeout,
} from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import {
  abortAndDrainAgentHarnessRun,
  agentHarnessAttemptTerminal,
  awaitAgentEndSideEffects,
  buildAgentHookContextChannelFields,
  buildEmbeddedForegroundPromptContext,
  clearActiveEmbeddedRun,
  embeddedAgentLog,
  formatErrorMessage,
  AgentHarnessSessionSupersededError,
  resolveAgentDir,
  runAgentEndSideEffects,
  runAgentHarnessLlmOutputHook,
  setActiveEmbeddedRun,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessAttemptResult,
  type AgentHarnessV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { captureNativeSessionGenerationAuthority } from "openclaw/plugin-sdk/agent-harness-session-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import {
  resolveOpenAIModelReasoningEfforts,
  resolveOpenAIReasoningEffortMap,
  resolveOpenAIReasoningEffortMapping,
} from "openclaw/plugin-sdk/llm";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createAgentsApiBindings } from "./agentsapi-bindings.js";
import { AgentsApiClient } from "./agentsapi-client.js";
import { collectOutputs, prepareInputs, uploadInputs } from "./agentsapi-files.js";
import { createAgentsApiMessageProjection } from "./agentsapi-messages.js";
import { createAgentsApiSession } from "./agentsapi-session.js";
import { buildAgentsApiToolSurface } from "./agentsapi-tools.js";

/** Agents API owns native protocol; the host harness runtime owns coordination. */
export function createAgentsApiHarness(runtime: PluginRuntime): AgentHarnessV2 {
  let disposed = false;
  let closing = false;
  const runningSessions = new Map<string, number>();
  let bindings: ReturnType<typeof createAgentsApiBindings> | undefined;
  const getBindings = () => (bindings ??= createAgentsApiBindings(runtime));
  const assertCurrent = () => {
    if (disposed) {
      throw new Error("Agents API harness is disposed");
    }
  };
  return {
    id: "agentsapi",
    label: "OpenAI Agents API (MVP)",
    autoSelection: { providerIds: [] },
    deliveryDefaults: { visibleReplies: "automatic" },
    supports: (ctx) => {
      if (ctx.provider !== "openai") {
        return { supported: false, reason: "Agents API requires the OpenAI provider" };
      }
      if (
        ctx.modelProvider?.preparedAuth?.requirement === "subscription" ||
        (ctx.modelProvider?.api && ctx.modelProvider.api !== "openai-responses") ||
        ctx.modelProvider?.requestTransportOverrides === "present" ||
        (ctx.modelProvider?.baseUrl && ctx.modelProvider.baseUrl !== "https://api.openai.com/v1")
      ) {
        return { supported: false, reason: "Agents API MVP requires the official API-key route" };
      }
      return { supported: true };
    },
    runAttempt: async (params) => {
      assertCurrent();
      if (closing) {
        throw new Error("Agents API harness is closing");
      }
      const target = validateAgentsApiInput(params);
      const authority = captureNativeSessionGenerationAuthority({
        target,
        config: params.config,
        storePath: target.storePath,
        assertCurrent: () => {
          assertCurrent();
          params.hostCapabilities.assertActive();
        },
        createSupersededError: (sessionId) =>
          new AgentHarnessSessionSupersededError(
            `Agents API session generation is no longer current: ${sessionId}`,
          ),
      });
      authority.assertCurrent();
      runningSessions.set(params.sessionId, (runningSessions.get(params.sessionId) ?? 0) + 1);
      try {
        return await getBindings().withSession(
          params.sessionId,
          () => authority.assertCurrent(),
          (binding, bind, assertLeaseCurrent) => {
            if (closing) {
              throw new Error("Agents API harness is closing");
            }
            return runAgentsApiSession(
              params,
              binding,
              bind,
              () => {
                authority.assertCurrent();
                assertLeaseCurrent();
              },
              () => {
                assertCurrent();
                assertLeaseCurrent();
              },
              target,
            );
          },
        );
      } finally {
        const count = runningSessions.get(params.sessionId)! - 1;
        if (count > 0) {
          runningSessions.set(params.sessionId, count);
        } else {
          runningSessions.delete(params.sessionId);
        }
      }
    },
    reset: async (params) => {
      assertCurrent();
      if (params.sessionId) {
        await getBindings().reset(params.sessionId, assertCurrent);
      }
    },
    withSessionDeletion: (params, run) =>
      getBindings().withSessionDeletion(
        {
          ...params,
          assertCurrent: () => {
            params.assertCurrent();
            assertCurrent();
          },
        },
        run,
      ),
    dispose: async () => {
      closing = true;
      await Promise.all(
        [...runningSessions.keys()].map((sessionId) =>
          abortAndDrainAgentHarnessRun({ sessionId, settleMs: 95_000 }),
        ),
      );
      if (bindings) {
        await bindings.withExclusiveMutationFence(async () => {
          disposed = true;
        });
      } else {
        disposed = true;
      }
    },
  };
}

async function runAgentsApiSession(
  params: AgentHarnessAttemptParamsV2,
  binding: import("./agentsapi-bindings.js").AgentsApiBinding | undefined,
  bind: (binding: import("./agentsapi-bindings.js").AgentsApiBinding) => Promise<void>,
  assertOwnerCurrent: () => void,
  assertHarnessCurrent: () => void,
  target: ReturnType<typeof validateAgentsApiInput>,
): Promise<AgentHarnessAttemptResult> {
  const startedAtMs = Date.now();
  const cancellationState = {
    explicitCancellationObserved: false,
    terminalOutcomeFrozen: false,
    sharedAbortAllowedAfterTerminalOutcome: false,
  };
  const cancellation = createAgentHarnessAttemptCancellation({
    upstreamSignal: params.abortSignal,
    onAttemptAbort: params.onAttemptAbort,
    state: cancellationState,
  });
  const { controller } = cancellation;
  const assertCurrent = () => {
    assertOwnerCurrent();
    controller.signal.throwIfAborted();
  };
  let timeout: AgentHarnessAttemptTimeout | undefined;
  const deadlines = createAgentHarnessAttemptDeadlineController({
    startedAtMs,
    timeoutMs: params.timeoutMs,
    settlementTimeoutMs: 30_000,
    signal: controller.signal,
    onDeadlineChanged: params.onAttemptDeadlineChanged,
    onTimeout: (expired) => {
      timeout = expired;
      const error = new Error(`Agents API ${expired.kind} timed out`);
      params.onAttemptTimeout?.(error);
      cancellation.abortExplicitly(error);
    },
  });
  const emitEvent = (
    event: Parameters<NonNullable<AgentHarnessAttemptParamsV2["onAgentEvent"]>>[0],
  ) => emitAgentHarnessAttemptEvent(params, event, { label: "Agents API", log: embeddedAgentLog });
  const lifecycle = createAgentHarnessAttemptLifecycle({
    attempt: params,
    backend: "agentsapi",
    startedAtMs,
    state: { lifecycleStarted: false, lifecycleTerminalEmitted: false },
    emitEvent,
  });
  let native: ReturnType<typeof createAgentsApiSession> | undefined;
  let remoteSessionId = binding?.sessionId;
  let terminal: ReturnType<typeof agentHarnessAttemptTerminal.normalize> = { kind: "ok" };
  let reply: ReturnType<typeof createAgentsApiMessageProjection>["reply"] | undefined;
  let projection: ReturnType<typeof createAgentsApiMessageProjection> | undefined;
  let usageRecorded = false;
  let terminalTurnId: string | undefined;
  const toolCleanups: Array<(reason: string) => Promise<void>> = [];
  let toolSurface: ReturnType<typeof buildAgentsApiToolSurface> | undefined;
  let outputMedia: Awaited<ReturnType<typeof collectOutputs>> | undefined;
  let startedToolCount = 0;
  let completedToolCount = 0;
  const handle = {
    kind: "embedded",
    toolAuthorityFingerprint: params.toolAuthorityFingerprint,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
    supportsTranscriptCommitWait: true,
    runId: params.runId,
    startedAtMs,
    queueMessage: async (text, options) => {
      assertCurrent();
      if (!native?.isAvailable()) {
        throw new Error("Agents API turn is not ready for steering");
      }
      if (options?.images?.length) {
        throw new Error("Agents API MVP accepts text steering only");
      }
      await options?.userTurnTranscriptRecorder?.persistApproved();
      assertCurrent();
      await native.queueMessage(
        buildCurrentInboundPrompt({ context: options?.currentInboundContext, prompt: text }),
      );
      options?.userTurnTranscriptRecorder?.markSentToProvider?.();
    },
    isStreaming: () => native?.isAvailable() ?? false,
    isStopped: () => controller.signal.aborted || (native?.isSettled() ?? false),
    isAborted: () => controller.signal.aborted,
    isCompacting: () => false,
    abort: () => cancellation.abortExplicitly(new Error("Agents API turn interrupted")),
    cancel: () => cancellation.abortExplicitly(new Error("Agents API turn interrupted")),
  } satisfies Parameters<typeof setActiveEmbeddedRun>[1];
  try {
    params.replyOperation?.attachBackend(handle);
    setActiveEmbeddedRun(
      params.sessionId,
      handle,
      params.sessionKey,
      params.sessionFile,
      params.agentId,
    );
    assertCurrent();
    const surface = buildAgentsApiToolSurface(params, controller.signal, assertCurrent, (cleanup) =>
      toolCleanups.push(cleanup),
    );
    toolSurface = surface;
    const inputs = await prepareInputs(
      params.media,
      params.workspaceDir,
      assertCurrent,
      controller.signal,
    );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([params.model.id, params.resolvedApiKey, surface.declarations]))
      .digest("hex");
    if (binding && binding.authFingerprint !== fingerprint) {
      throw new Error(
        "Agents API model, credential, or tool surface changed; reset the OpenClaw session before continuing",
      );
    }
    const client = new AgentsApiClient(params.resolvedApiKey!, assertOwnerCurrent);
    const reasoningEffort = resolveAgentsApiReasoningEffort(params);
    const creatingSession = !remoteSessionId;
    if (!remoteSessionId) {
      remoteSessionId = await client.create(
        controller.signal,
        [
          "You are the OpenClaw assistant. Use your hosted Linux workspace for commands and files.",
          "OpenClaw functions run in the Gateway and use its workspace; your hosted VM owns shell commands and VM files.",
          "Uploaded attachments are mapped to hosted VM paths in each user message. Files you finish writing under /workspace/outputs are transferred and attached to your final reply after your turn completes.",
          "Gateway messaging functions cannot open VM paths. Complete your assistant turn to deliver VM output attachments. Image generation is unavailable.",
          params.extraSystemPrompt,
        ]
          .filter(Boolean)
          .join("\n\n"),
        params.model.id,
        reasoningEffort,
        { functions: surface.declarations, files: inputs.files },
      );
      assertCurrent();
      await bind({ sessionId: remoteSessionId, authFingerprint: fingerprint });
    } else {
      await client.setReasoningEffort(remoteSessionId, reasoningEffort, controller.signal);
      assertCurrent();
    }
    if (!creatingSession && inputs.files.length) {
      await uploadInputs(client, remoteSessionId, inputs.files, assertCurrent, controller.signal);
    }
    projection = createAgentsApiMessageProjection(remoteSessionId, (event) => {
      void emitEvent(event);
    });
    const messageProjection = projection;
    reply = projection.reply;
    native = createAgentsApiSession({
      client,
      // Admitted hosted work must still be retired when host run authority closes.
      cleanupClient: new AgentsApiClient(params.resolvedApiKey!, assertHarnessCurrent),
      sessionId: remoteSessionId,
      signal: controller.signal,
      assertCurrent,
      onSettled: () => deadlines.beginSettlement(Date.now()),
      onUsageError: (error) =>
        embeddedAgentLog.warn("Agents API token accounting unavailable", { error }),
      executeFunction: async (call) => {
        startedToolCount++;
        void emitEvent({
          stream: "tool",
          data: { phase: "start", name: call.name, toolCallId: call.call_id },
        });
        return surface.execute(call);
      },
      onFunctionResult: (call, result) => {
        completedToolCount++;
        void emitEvent({
          stream: "tool",
          data: {
            phase: "result",
            name: call.name,
            toolCallId: call.call_id,
            isError: !result.success,
          },
        });
      },
      onEvent: (event) => {
        messageProjection.observe(event);
        params.onRunProgress?.({
          reason: event.type,
          provider: "openai",
          model: params.model.id,
          backend: "agentsapi",
        });
      },
    });
    lifecycle.emitLifecycleStart({ provider: "openai", model: params.model.id });
    const result = await native.run(
      [
        buildCurrentInboundPrompt({ context: params.currentInboundContext, prompt: params.prompt }),
        inputs.mappingText,
      ].filter(Boolean).join("\n\n"),
      async () => {
        await params.userTurnTranscriptRecorder?.persistApproved();
      },
      () => params.userTurnTranscriptRecorder?.markSentToProvider?.(),
    );
    // A terminal root turn is insufficient: run() also waits for native session idle.
    terminalTurnId = result.turn.id;
    const turns = await native.readUsageTurns();
    assertCurrent();
    projection.recordUsage(params.model, turns);
    usageRecorded = true;
    params.hostCapabilities.reportOutputTokens?.(reply.usage?.output ?? 0);
    if (result.cancelled) {
      terminal = { kind: "aborted", source: "runtime" };
    } else if (!result.terminatedByTool) {
      const items = await client.items(remoteSessionId, result.turn.id, controller.signal);
      assertCurrent();
      outputMedia = await collectOutputs(
        client,
        remoteSessionId,
        result.turn.id,
        assertCurrent,
        controller.signal,
      );
      await projection.commit(params, result.turn, items, assertCurrent);
      assertCurrent();
    }
  } catch (error) {
    terminal = timeout
      ? { kind: "timeout", phase: "prompt", source: "runtime", aborted: true }
      : params.abortSignal?.aborted
        ? { kind: "aborted", source: "external" }
        : cancellationState.explicitCancellationObserved
          ? { kind: "aborted", source: "runtime" }
          : { kind: "failed", source: "prompt", error };
    if (terminal.kind === "failed") {
      embeddedAgentLog.warn("Agents API session failed", { error });
    }
  } finally {
    try {
      await native?.close();
    } catch (error) {
      terminal = { kind: "failed", source: "prompt", error };
    }
    try {
      if (native && projection && !usageRecorded) {
        const turns = await native.readUsageTurns();
        assertHarnessCurrent();
        projection.recordUsage(params.model, turns);
        usageRecorded = true;
      }
    } catch (error) {
      terminal = { kind: "failed", source: "prompt", error };
    }
    cancellation.freezeTerminalOutcome();
    deadlines.dispose();
    cancellation.dispose();
    controller.abort();
    for (const cleanup of toolCleanups.toReversed()) {
      try {
        await cleanup("Agents API attempt settled");
      } catch (error) {
        embeddedAgentLog.warn("Agents API tool cleanup failed", { error });
      }
    }
    clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
    lifecycle.emitLifecycleTerminal({ phase: terminal.kind === "failed" ? "error" : "end" });
  }
  const result: AgentHarnessAttemptResult = {
    terminal,
    sessionIdUsed: params.sessionId,
    sessionFileUsed: params.sessionFile,
    agentHarnessId: "agentsapi",
    messagesSnapshot: SessionManager.open(target, params.workspaceDir).buildSessionContext()
      .messages,
    assistantTexts:
      reply?.lastAssistant?.content
        .filter((part) => part.type === "text")
        .map((part) => part.text) ?? [],
    lastAssistant: reply?.lastAssistant,
    currentAttemptAssistant: reply?.lastAssistant,
    currentAttemptCompletedAssistant: reply?.lastAssistant,
    assistantTranscriptOwned: Boolean(reply?.lastAssistant),
    assistantTranscriptIdempotencyKey:
      reply?.lastAssistant && terminalTurnId
        ? `agentsapi:${remoteSessionId}:${terminalTurnId}`
        : undefined,
    toolMetas: toolSurface?.toolMetas ?? [],
    lastToolError: toolSurface?.lastToolError,
    ...toolSurface?.runtimeFacts,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    ...toolSurface?.delivery,
    ...(outputMedia && {
      hostOwnedToolMediaUrls: outputMedia.hostOwnedToolMediaUrls,
      toolMediaUrls: [
        ...new Set([...(toolSurface?.delivery.toolMediaUrls ?? []), ...outputMedia.toolMediaUrls]),
      ],
      // Verified hosted artifacts must not promote unrelated plugin media.
      toolTrustedLocalMedia:
        outputMedia.toolMediaUrls.length && !toolSurface?.delivery.toolMediaUrls?.length
          ? true
          : toolSurface?.delivery.toolTrustedLocalMedia,
    }),
    cloudCodeAssistFormatError: false,
    attemptUsage: reply?.usage,
    replayMetadata: {
      hadPotentialSideEffects: native?.wasSubmitted() ?? false,
      replaySafe: !native?.wasSubmitted(),
    },
    itemLifecycle: {
      startedCount: startedToolCount,
      completedCount: completedToolCount,
      activeCount: Math.max(0, startedToolCount - completedToolCount),
    },
  };
  assertHarnessCurrent();
  const contextWindow = {
    contextTokenBudget: params.contextWindowInfo?.tokens ?? params.contextTokenBudget,
    contextWindowSource: params.contextWindowInfo?.source,
    contextWindowReferenceTokens: params.contextWindowInfo?.referenceTokens,
  };
  const hookContext = {
    runId: params.runId,
    agentId: target.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    modelProviderId: params.provider,
    modelId: params.model.id,
    trigger: params.trigger,
    inputProvenance: params.inputProvenance,
    ...buildAgentHookContextChannelFields(params),
    channelContext: params.channelContext,
    ...contextWindow,
  };
  runAgentHarnessLlmOutputHook({
    event: {
      runId: params.runId,
      sessionId: params.sessionId,
      provider: params.provider,
      model: params.model.id,
      resolvedRef: `${params.provider}/${params.model.id}`,
      harnessId: "agentsapi",
      prompt: params.prompt,
      ...contextWindow,
      assistantTexts: result.assistantTexts,
      lastAssistant: result.lastAssistant,
      usage: result.attemptUsage,
    },
    ctx: hookContext,
  });
  const agentEnd = {
    event: {
      runId: params.runId,
      messages: result.messagesSnapshot,
      success: terminal.kind === "ok",
      error: terminal.kind === "failed" ? formatErrorMessage(terminal.error) : undefined,
      durationMs: Date.now() - startedAtMs,
    },
    ctx: {
      ...hookContext,
      config: params.config,
      foregroundPromptContext: buildEmbeddedForegroundPromptContext(
        { ...params, agentId: target.agentId },
        params.agentDir ?? resolveAgentDir(params.config ?? {}, target.agentId),
      ),
      skillWorkshopAvailable: false,
      compacted: false,
    },
  };
  if (!params.messageChannel && !params.messageProvider) {
    await awaitAgentEndSideEffects(agentEnd);
  } else {
    runAgentEndSideEffects(agentEnd);
  }
  return result;
}

function resolveAgentsApiReasoningEffort(
  params: Pick<AgentHarnessAttemptParamsV2, "model" | "thinkLevel">,
): AgentReasoningParam["effort"] {
  if (params.thinkLevel === "ultra") {
    throw new Error("Agents API MVP does not support the ultra delegation mode");
  }
  if (params.thinkLevel === "adaptive") {
    return undefined;
  }
  const supportedEfforts = resolveOpenAIModelReasoningEfforts(params.model);
  const modelMapped = params.model.thinkingLevelMap?.[params.thinkLevel];
  if (!params.model.reasoning || supportedEfforts?.length === 0 || modelMapped === null) {
    return undefined;
  }
  const mapped =
    resolveOpenAIReasoningEffortMapping(
      params.thinkLevel,
      resolveOpenAIReasoningEffortMap(params.model),
    ) ?? modelMapped;
  const effort = mapped?.trim() ?? (params.thinkLevel === "off" ? "none" : params.thinkLevel);
  switch (effort) {
    case "none":
      return supportedEfforts?.includes("none") ? effort : undefined;
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return supportedEfforts === undefined
        ? effort
        : selectSupportedReasoningEffort({
            requested: effort,
            supportedEfforts,
            effortOrder: ["minimal", "low", "medium", "high", "xhigh", "max"] as const,
          });
    default:
      throw new Error(`Agents API does not support reasoning effort ${effort}`);
  }
}

function validateAgentsApiInput(params: AgentHarnessAttemptParamsV2) {
  const target = params.sessionTarget;
  if (
    !target?.agentId ||
    !target.sessionId ||
    !target.sessionKey ||
    !target.storePath ||
    target.sessionId !== params.sessionId ||
    target.agentId !== params.agentId ||
    target.sessionKey !== params.sessionKey
  ) {
    throw new Error("Agents API requires a matching host-prepared session target");
  }
  if (!params.resolvedApiKey) {
    throw new Error("Agents API MVP requires an OpenAI API key");
  }
  if (params.images?.length || params.sandbox) {
    throw new Error(
      "Agents API MVP supports text and its hosted VM only; images and Gateway sandbox placement are unsupported",
    );
  }
  if (params.contextEngine && params.contextEngine.info.id !== "legacy") {
    throw new Error("Agents API MVP currently supports only the default legacy context engine");
  }
  return {
    ...target,
    agentId: target.agentId,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    storePath: target.storePath,
  };
}
