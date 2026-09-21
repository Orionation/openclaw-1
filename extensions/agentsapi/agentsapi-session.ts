import { setTimeout as delay } from "node:timers/promises";
import type { AgentSessionEvent } from "openai/resources/beta/agents/agents";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  AgentsApiClient,
  type AgentsApiTurn,
  type AgentsApiFunctionCall,
  type AgentsApiFunctionResult,
} from "./agentsapi-client.js";

/** Native input receipts and session idle, together, establish Agents API completion. */
export function createAgentsApiSession(options: {
  client: AgentsApiClient;
  cleanupClient: AgentsApiClient;
  sessionId: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  onEvent: (event: AgentSessionEvent) => void;
  onSettled?: () => void;
  onUsageError?: (error: unknown) => void;
  executeFunction?: (call: AgentsApiFunctionCall) => Promise<FunctionExecutionResult>;
  onFunctionResult?: (call: AgentsApiFunctionCall, result: FunctionExecutionResult) => void;
}) {
  const { client, cleanupClient, sessionId, signal, assertCurrent } = options;
  let streamController = new AbortController();
  let submitted = false;
  let stopped = false;
  let settled = false;
  let rootTurn: Turn | AgentsApiTurn | undefined;
  let turnFailure: string | undefined;
  let cancelled = false;
  let submission: Promise<void> = Promise.resolve();
  let admittedSubmission: Promise<void> = Promise.resolve();
  let cancellation: Promise<void> | undefined;
  let admittedMessageCount = 0;
  const observedInputItems = new Set<string>();
  const coordinatorTurnIds = new Set<string>();
  let latestInputTurnId: string | undefined;
  let baselineTurnId: string | undefined;
  let usageTurns: Promise<Turn[]> | undefined;
  let terminatedByTool = false;

  const isAvailable = () => submitted && !stopped && !settled && !rootTurn && !signal.aborted;
  const submit = (text: string) => {
    assertCurrent();
    signal.throwIfAborted();
    if (stopped || settled || rootTurn) {
      throw new Error("Agents API turn is stopped");
    }
    submission = submission.then(() => {
      assertCurrent();
      if (stopped || settled || rootTurn || signal.aborted) {
        throw new Error("Agents API turn settled before input was submitted");
      }
      admittedMessageCount++;
      submitted = true;
      // An admitted POST must finish before native cancellation; aborting its
      // HTTP request would leave acceptance of hosted work indeterminate.
      admittedSubmission = client.message(sessionId, text, AbortSignal.timeout(60_000));
      return admittedSubmission;
    });
    void submission.catch(() => {});
    return submission;
  };
  const cancel = () => {
    stopped = true;
    streamController.abort();
    if (!submitted || settled) {
      return Promise.resolve();
    }
    cancellation ??= (async () => {
      let submissionError: unknown;
      try {
        await admittedSubmission;
      } catch (error) {
        submissionError = error;
      }
      await cleanupClient.cancel(sessionId, AbortSignal.timeout(30_000));
      settled = true;
      if (submissionError !== undefined) {
        throw submissionError instanceof Error
          ? submissionError
          : new Error(formatErrorMessage(submissionError), { cause: submissionError });
      }
    })();
    void cancellation.catch(() => {});
    return cancellation;
  };
  const onAbort = () => {
    void cancel();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const collectInputs = async (turnId: string) => {
    for (const item of await client.items(sessionId, turnId, signal)) {
      if (item.type === "message" && item.role === "user" && item.id) {
        observedInputItems.add(item.id);
      }
    }
  };
  const assertSessionUsable = (session: { status: string; error: string | null }) => {
    if (session.status === "failed") {
      throw new Error(session.error ?? "Agents API session failed");
    }
  };

  return {
    isAvailable,
    wasSubmitted: () => submitted,
    isSettled: () => settled,
    queueMessage: submit,
    cancel,
    readUsageTurns() {
      if (!submitted || !settled) {
        return Promise.resolve([]);
      }
      return (usageTurns ??= (async () => {
        const usageSignal = AbortSignal.timeout(5_000);
        let turns: Turn[] = [];
        // Idle can precede the REST records and their usage. Give accounting
        // a bounded settlement window, without treating unknown usage as zero.
        try {
          while (true) {
            turns = await cleanupClient.turns(sessionId, usageSignal, baselineTurnId);
            const recordedIds = new Set(turns.map((turn) => turn.id));
            if (
              turns.length > 0 &&
              [...coordinatorTurnIds].every((id) => recordedIds.has(id)) &&
              turns.every((turn) => turn.usage !== null)
            ) {
              return turns;
            }
            await delay(500, undefined, { signal: usageSignal });
          }
        } catch (error) {
          if (!usageSignal.aborted) {
            options.onUsageError?.(error);
          }
          return turns;
        }
      })());
    },
    async run(prompt: string, persistInput: () => Promise<void>, onSubmitted: () => void) {
      signal.throwIfAborted();
      baselineTurnId = (await client.turns(sessionId, signal, undefined, true))[0]?.id;
      const relayedCalls = new Set<string>();
      const relayFunctions = async () => {
        assertCurrent();
        signal.throwIfAborted();
        if (!options.executeFunction) {
          throw new Error("Agents API MVP cannot continue: agent.session.requires_action");
        }
        const calls = await client.pendingFunctionCalls(sessionId, signal);
        if (!calls.length) {
          return;
        }
        const turns = await client.turns(sessionId, signal, baselineTurnId);
        for (const turn of turns) {
          coordinatorTurnIds.add(turn.id);
        }
        const latestTurn = turns.at(-1);
        if (!latestTurn) {
          throw new Error("Agents API function request has no current attempt root turn");
        }
        latestInputTurnId = latestTurn.id;
        for (const call of calls) {
          if (
            call.turn_id !== latestTurn.id ||
            !["in_progress", "waiting"].includes(latestTurn.status)
          ) {
            throw new Error(
              "Agents API function request belongs to a different or settled root turn",
            );
          }
          const identity = `${sessionId}:${call.turn_id}:${call.call_id}`;
          if (relayedCalls.has(identity)) {
            continue;
          }
          // Claim before execution so duplicate events cannot repeat a Gateway side effect.
          relayedCalls.add(identity);
          const result = await options.executeFunction(call);
          assertCurrent();
          signal.throwIfAborted();
          submission = submission.then(() => {
            assertCurrent();
            signal.throwIfAborted();
            admittedSubmission = client.toolResult(
              sessionId,
              call,
              result,
              AbortSignal.timeout(60_000),
            );
            return admittedSubmission;
          });
          void submission.catch(() => {});
          await submission;
          options.onFunctionResult?.(call, result);
          if (result.terminate || result.sourceReplyDelivered) {
            // Acknowledge the host's delivered reply before retiring native work.
            await cleanupClient.cancel(sessionId, AbortSignal.timeout(30_000));
            const session = await client.session(sessionId, signal);
            if (session.status !== "idle") {
              throw new Error(
                session.error ?? "Agents API tool termination did not establish native idle",
              );
            }
            const nativeRoot = await client.turn(sessionId, call.turn_id, signal);
            rootTurn = nativeRoot;
            if (!["completed", "cancelled"].includes(nativeRoot.status)) {
              throw new Error("Agents API tool termination did not settle its native root turn");
            }
            terminatedByTool = true;
            cancelled = false;
            settled = true;
            streamController.abort();
            return;
          }
        }
      };
      let events = await client.subscribe(
        sessionId,
        AbortSignal.any([signal, streamController.signal]),
      );
      let nextEvent = events.next();
      void nextEvent.catch(() => {});
      let reconciledStream = false;
      try {
        await persistInput();
        assertCurrent();
        signal.throwIfAborted();
        await submit(prompt);
        onSubmitted();
        while (!settled) {
          const chunk = await nextEvent;
          if (chunk.done) {
            reconciledStream = true;
            streamController.abort();
            await events.return(undefined);
            await delay(500, undefined, { signal });
            streamController = new AbortController();
            // Subscribe before reconciliation: Agents API streams do not replay.
            events = await client.subscribe(
              sessionId,
              AbortSignal.any([signal, streamController.signal]),
            );
            nextEvent = events.next();
            void nextEvent.catch(() => {});
            await submission;
            const admittedCount = admittedMessageCount;
            const turns = await client.turns(sessionId, signal, baselineTurnId);
            for (const turn of turns) {
              coordinatorTurnIds.add(turn.id);
              await collectInputs(turn.id);
            }
            const latestTurn = turns.at(-1);
            if (latestTurn) {
              latestInputTurnId = latestTurn.id;
              rootTurn = ["completed", "failed", "cancelled"].includes(latestTurn.status)
                ? latestTurn
                : undefined;
              turnFailure =
                latestTurn.status === "failed"
                  ? (latestTurn.error?.message ?? "Agents API turn failed")
                  : undefined;
              cancelled = latestTurn.status === "cancelled";
            }
            const session = await client.session(sessionId, signal);
            assertCurrent();
            assertSessionUsable(session);
            if (session.status === "requires_action") {
              await relayFunctions();
              if (settled) {
                break;
              }
            }
            settled = Boolean(
              rootTurn &&
              session.status === "idle" &&
              admittedCount === admittedMessageCount &&
              observedInputItems.size >= admittedMessageCount,
            );
            continue;
          }
          const event = chunk.value;
          nextEvent = events.next();
          void nextEvent.catch(() => {});
          assertCurrent();
          options.onEvent(event);
          if (rootTurn && event.type === "agent.session.idle") {
            await submission;
            assertCurrent();
            if (observedInputItems.size < admittedMessageCount) {
              for (const turnId of coordinatorTurnIds) {
                await collectInputs(turnId);
              }
            }
            if (
              observedInputItems.size < admittedMessageCount ||
              rootTurn.id !== latestInputTurnId
            ) {
              continue;
            }
            if (reconciledStream) {
              const session = await client.session(sessionId, signal);
              assertSessionUsable(session);
              if (session.status !== "idle") {
                continue;
              }
            }
            settled = true;
            break;
          }
          if (event.type === "agent.session.turn.created" && event.turn?.subagent_id === null) {
            if (!coordinatorTurnIds.has(event.turn.id)) {
              coordinatorTurnIds.add(event.turn.id);
              latestInputTurnId = event.turn.id;
              rootTurn = undefined;
              turnFailure = undefined;
              cancelled = false;
            }
          }
          if (
            (event.type === "agent.session.turn.item.added" ||
              event.type === "agent.session.turn.item.done") &&
            event.item?.type === "message" &&
            event.item.role === "user" &&
            event.item.id &&
            !observedInputItems.has(event.item.id)
          ) {
            observedInputItems.add(event.item.id);
            const inputTurnId = event.item.turn_id ?? event.turn_id;
            if (!inputTurnId) {
              throw new Error("Agents API input item is missing its turn ID");
            }
            if (!latestInputTurnId) {
              coordinatorTurnIds.add(inputTurnId);
              latestInputTurnId = inputTurnId;
            }
          }
          if (event.type === "error") {
            throw new Error(event.error?.message ?? "Agents API stream error");
          }
          if (event.type === "agent.session.requires_action") {
            await relayFunctions();
            if (settled) {
              break;
            }
            continue;
          }
          if (["agent.session.failed", "agent.session.environment.failed"].includes(event.type)) {
            throw new Error(`Agents API MVP cannot continue: ${event.type}`);
          }
          if (
            (event.type === "agent.session.turn.completed" ||
              event.type === "agent.session.turn.failed" ||
              event.type === "agent.session.turn.cancelled") &&
            event.turn.subagent_id === null &&
            event.turn.id === latestInputTurnId
          ) {
            rootTurn = event.turn;
            turnFailure = event.type.endsWith(".failed")
              ? (event.turn.error?.message ?? "Agents API turn failed")
              : undefined;
            cancelled = event.type.endsWith(".cancelled");
          }
        }
        options.onSettled?.();
      } finally {
        streamController.abort();
        await events.return(undefined);
      }
      if (!rootTurn || !settled) {
        throw new Error(
          "Agents API stream closed before the root turn settled; reset or inspect the session before retrying",
        );
      }
      if (turnFailure) {
        throw new Error(turnFailure);
      }
      return { turn: rootTurn, cancelled, terminatedByTool };
    },
    async close() {
      signal.removeEventListener("abort", onAbort);
      streamController.abort();
      if (submitted && !settled) {
        await cancel();
      }
      await cancellation;
      stopped = true;
    },
  };
}

type FunctionExecutionResult = AgentsApiFunctionResult & {
  sourceReplyDelivered?: true;
  terminate?: true;
};
