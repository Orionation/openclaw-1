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
import type { AgentsApiFunctionCall } from "./agentsapi-client.js";

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
