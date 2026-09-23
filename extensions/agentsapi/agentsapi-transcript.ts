import {
  createAgentHarnessToolCallMessage,
  createAgentHarnessToolResultMessage,
} from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import type {
  AgentHarnessAttemptParamsV2,
  AgentMessage,
  AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { appendSessionTranscriptMessageByIdentityStrict } from "openclaw/plugin-sdk/session-transcript-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { AgentsApiFunctionCall, AgentsApiItem } from "./agentsapi-client.js";
import {
  agentsApiNativeTool,
  agentsApiNativeToolDetails,
  agentsApiNativeToolOutcome,
  agentsApiNativeToolOutput,
} from "./agentsapi-native-items.js";

/** Canonical native facts use the same durable identities during live and historical repair. */
export async function recordAgentsApiNativeToolTranscript(
  params: AgentHarnessAttemptParamsV2,
  sessionId: string,
  turnId: string,
  item: AgentsApiItem,
  assertCurrent: () => void,
  nextTimestamp: () => number,
  options: {
    enclosingStatus?: string;
    capturedOutput?: string;
    captureTruncated?: boolean;
  } = {},
): Promise<boolean> {
  assertCurrent();
  const tool = agentsApiNativeTool(item, params);
  if (!tool || !["completed", "failed", "incomplete"].includes(item.status ?? "")) {
    // A failed parent turn can retire before its command completes. Do not
    // freeze a provisional result under the command's durable identity.
    return false;
  }
  const id = `agentsapi:${sessionId}:${turnId}:${item.id}`;
  const outcome = agentsApiNativeToolOutcome(item, options.enclosingStatus);
  const output = agentsApiNativeToolOutput(item, options.capturedOutput);
  const details = agentsApiNativeToolDetails(
    sessionId,
    turnId,
    item,
    outcome,
    options.capturedOutput,
  );
  const text =
    output ??
    (item.type === "web_search_call"
      ? `Web search ${outcome.status}; native search results are unavailable.`
      : (outcome.error ?? `${tool.name} ${outcome.status}`));
  await appendAgentsApiTranscriptMessage(
    params,
    {
      ...createAgentHarnessToolCallMessage(
        { api: "openai-responses", provider: "openai", modelId: params.model.id },
        { id, name: tool.name, arguments: tool.args },
        nextTimestamp(),
      ),
      idempotencyKey: `${id}:call`,
    },
    assertCurrent,
  );
  await appendAgentsApiTranscriptMessage(
    params,
    {
      ...createAgentHarnessToolResultMessage(
        { id, name: tool.name, text, isError: outcome.isError, details },
        nextTimestamp(),
      ),
      __openclaw: {
        toolOutput: {
          source: "execution",
          modelInput: "unverified",
          ...(outcome.outcomeUnknown ? { outcome: "unknown" } : {}),
          ...(options.captureTruncated ? { captureTruncated: true } : {}),
        },
        ...(item.type === "web_search_call" ? { resultContentSource: "network" } : {}),
      },
      idempotencyKey: `${id}:result`,
    },
    assertCurrent,
  );
  return true;
}

/** Persist host tool evidence before its result is acknowledged by the native session. */
export async function recordAgentsApiToolTranscript(
  params: AgentHarnessAttemptParamsV2,
  call: AgentsApiFunctionCall,
  result: Awaited<ReturnType<AnyAgentTool["execute"]>>,
  isError: boolean,
  assertCurrent: () => void,
): Promise<void> {
  const identity = `agentsapi:tool:${call.turn_id}:${call.call_id}`;
  const attribution = {
    api: "openai-responses" as const,
    provider: "openai",
    modelId: params.model.id,
  };
  const toolCall = {
    ...createAgentHarnessToolCallMessage(
      attribution,
      { id: call.call_id, name: call.name, arguments: asOptionalRecord(call.arguments) ?? {} },
      Date.now(),
    ),
    idempotencyKey: `${identity}:call`,
  };
  const toolResult = {
    ...createAgentHarnessToolResultMessage(
      {
        id: call.call_id,
        name: call.name,
        content: result.content,
        details: result.details,
        isError,
      },
      Date.now(),
    ),
    idempotencyKey: `${identity}:result`,
  };
  await appendAgentsApiTranscriptMessage(params, toolCall, assertCurrent);
  await appendAgentsApiTranscriptMessage(params, toolResult, assertCurrent);
}

export async function appendAgentsApiTranscriptMessage<TMessage extends AgentMessage>(
  params: AgentHarnessAttemptParamsV2,
  message: TMessage,
  assertCurrent: () => void,
): Promise<TMessage> {
  assertCurrent();
  const { agentId, sessionId, sessionKey, storePath } = params.sessionTarget ?? {};
  if (
    !agentId ||
    !sessionId ||
    !sessionKey ||
    !storePath ||
    sessionId !== params.sessionId ||
    agentId !== params.agentId ||
    sessionKey !== params.sessionKey
  ) {
    throw new Error("Agents API requires a matching host-prepared session target");
  }
  const append = await appendSessionTranscriptMessageByIdentityStrict({
    ...params.sessionTarget,
    agentId,
    sessionId,
    sessionKey,
    storePath,
    config: params.config,
    message,
    prepareMessageAfterIdempotencyCheck: (prepared) => {
      assertCurrent();
      return prepared;
    },
  });
  assertCurrent();
  if (append.kind !== "result") {
    throw new Error("Agents API transcript append was refused");
  }
  return append.result.message;
}
