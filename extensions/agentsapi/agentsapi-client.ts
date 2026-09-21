import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import OpenAI from "openai";
import type {
  AgentReasoningParam,
  AgentSessionEvent,
  AgentSessionItem,
} from "openai/resources/beta/agents/agents";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import { responseWithRelease } from "openclaw/plugin-sdk/fetch-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { z } from "zod";

const usageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  input_tokens_details: z.object({ cached_tokens: z.number() }).optional(),
});
const errorSchema = z.object({ message: z.string() });
const functionCallSchema = z.object({
  type: z.literal("function_call"),
  turn_id: z.string().min(1),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.unknown(),
});
const sessionSchema = z.object({
  id: z.string(),
  status: z.enum(["idle", "in_progress", "requires_action", "failed"]),
  error: z.string().nullable(),
  required_actions: z.array(
    z.union([
      functionCallSchema,
      z.object({ type: z.literal("environment_connection"), environment_id: z.string() }),
    ]),
  ),
});
const turnSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  subagent_id: z.string().nullable(),
  status: z.enum(["queued", "in_progress", "waiting", "completed", "failed", "cancelled"]),
  error: errorSchema.nullable(),
  usage: usageSchema.nullable(),
});
export type AgentsApiTurn = z.infer<typeof turnSchema>;
export type AgentsApiFunctionCall = z.infer<typeof functionCallSchema>;
export type AgentsApiFunctionDeclaration = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  defer_loading?: boolean;
};
export type AgentsApiFunctionResult =
  | { success: true; output: string }
  | { success: false; error: string };

/** Session lifecycle uses the SDK; tool replies retain their existing request contract. */
export class AgentsApiClient {
  private readonly sessions: OpenAI["beta"]["agents"]["sessions"];

  constructor(
    private readonly apiKey: string,
    private readonly assertCurrent: () => void,
  ) {
    this.sessions = new OpenAI({
      apiKey,
      // Ignore OPENAI_BASE_URL while retaining the SDK's official endpoint default.
      baseURL: null,
      // SDK retry backoff ignores aborts; preserve the harness's operation deadlines.
      maxRetries: 0,
      defaultHeaders: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Organization": null,
        "OpenAI-Project": null,
      },
      fetch: async (input, init) => {
        this.assertCurrent();
        const guarded = await fetchWithSsrFGuard({
          url: input instanceof Request ? input.url : String(input),
          init,
          signal: init?.signal ?? undefined,
          beforeRequest: this.assertCurrent,
        });
        const response = responseWithRelease(guarded.response, guarded.release);
        try {
          this.assertCurrent();
        } catch (error) {
          await response.body?.cancel().catch(() => undefined);
          throw error;
        }
        return response;
      },
    }).beta.agents.sessions;
  }

  async create(
    signal: AbortSignal,
    instructions: string,
    model: string,
    reasoningEffort?: AgentReasoningParam["effort"],
    extras?: { functions?: AgentsApiFunctionDeclaration[] },
  ): Promise<string> {
    const session = await this.sessions.create(
      {
        agent: {
          model,
          instructions,
          reasoning: reasoningEffort === undefined ? undefined : { effort: reasoningEffort },
          multi_agent: { enabled: false },
          tools: extras?.functions ?? [],
        },
        environment: { type: "openai_hosted" },
      },
      { signal, headers: { "Idempotency-Key": randomUUID() } },
    );
    this.assertCurrent();
    return session.id;
  }

  async setReasoningEffort(
    sessionId: string,
    effort: AgentReasoningParam["effort"],
    signal: AbortSignal,
  ): Promise<void> {
    const session = await this.sessions.update(
      sessionId,
      {},
      {
        signal,
        headers: { "Idempotency-Key": randomUUID() },
        // The API supports agent updates; this SDK version types only metadata.
        body: { agent: { reasoning: { effort: effort ?? null } } },
      },
    );
    this.assertCurrent();
    if (session.id !== sessionId) {
      throw new Error("Agents API returned a different session");
    }
  }

  async subscribe(sessionId: string, signal: AbortSignal) {
    const stream = await this.sessions.events.stream(sessionId, { signal });
    try {
      this.assertCurrent();
      signal.throwIfAborted();
    } catch (error) {
      stream.controller.abort();
      throw error;
    }
    return observeEvents(stream, signal, this.assertCurrent);
  }

  async session(sessionId: string, signal: AbortSignal) {
    const session = await this.sessions.retrieve(sessionId, { signal });
    this.assertCurrent();
    if (session.id !== sessionId) {
      throw new Error("Agents API returned a different session");
    }
    return session;
  }

  async pendingFunctionCalls(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<AgentsApiFunctionCall[]> {
    const session = sessionSchema.parse(await this.session(sessionId, signal));
    if (session.status === "failed") {
      throw new Error(session.error ?? "Agents API session failed");
    }
    if (session.status !== "requires_action") {
      return [];
    }
    const calls: AgentsApiFunctionCall[] = [];
    for (const action of session.required_actions) {
      if (action.type !== "function_call") {
        throw new Error("Agents API hosted prototype cannot reconnect an environment_connection");
      }
      calls.push(action);
    }
    return calls;
  }

  async toolResult(
    sessionId: string,
    call: AgentsApiFunctionCall,
    result: AgentsApiFunctionResult,
    signal: AbortSignal,
  ): Promise<void> {
    await this.input(sessionId, signal, {
      type: "agent.session.input.tool_result",
      turn_id: call.turn_id,
      call_id: call.call_id,
      ...(result.success
        ? { success: true, output: result.output }
        : { success: false, error: result.error }),
    });
  }

  async turn(sessionId: string, turnId: string, signal: AbortSignal): Promise<AgentsApiTurn> {
    const response = await this.request(
      `/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
      "GET",
      signal,
    );
    const turn = turnSchema.parse(await response.json());
    this.assertCurrent();
    if (turn.id !== turnId || turn.session_id !== sessionId || turn.subagent_id !== null) {
      throw new Error("Agents API returned a turn outside the requested root session");
    }
    return turn;
  }

  async turns(sessionId: string, signal: AbortSignal, after?: string, latestOnly = false) {
    const turns: Turn[] = [];
    const pages = this.sessions.turns.list(
      sessionId,
      {
        order: latestOnly ? "desc" : "asc",
        limit: latestOnly ? 1 : 100,
        after,
      },
      { signal },
    );
    for await (const page of (await pages).iterPages()) {
      this.assertCurrent();
      if (page.data.some((turn) => turn.session_id !== sessionId || turn.subagent_id !== null)) {
        throw new Error("Agents API returned a turn outside the single-agent session");
      }
      turns.push(...page.data);
      if (latestOnly) {
        break;
      }
      if (page.has_more && !page.hasNextPage()) {
        throw new Error("Agents API turns page has no continuation cursor");
      }
    }
    return turns;
  }

  async message(sessionId: string, text: string, signal: AbortSignal): Promise<void> {
    await this.sessions.events.create(
      sessionId,
      {
        events: [
          {
            type: "agent.session.input.message",
            input: [{ role: "user", content: [{ type: "input_text", text }] }],
          },
        ],
        "Idempotency-Key": randomUUID(),
      },
      { signal },
    );
    this.assertCurrent();
  }

  async cancel(sessionId: string, signal: AbortSignal): Promise<void> {
    await this.sessions.events.create(
      sessionId,
      {
        events: [{ type: "agent.session.input.cancel" }],
        "Idempotency-Key": randomUUID(),
      },
      { signal },
    );
    this.assertCurrent();
    // The input acknowledgement is not a settlement barrier for hosted work.
    while (true) {
      const session = await this.session(sessionId, signal);
      if (session.status === "idle" || session.status === "failed") {
        return;
      }
      await delay(500, undefined, { signal });
    }
  }

  async items(sessionId: string, turnId: string, signal: AbortSignal): Promise<AgentSessionItem[]> {
    const items: AgentSessionItem[] = [];
    const pages = this.sessions.items.list(sessionId, { order: "asc", limit: 100 }, { signal });
    for await (const page of (await pages).iterPages()) {
      this.assertCurrent();
      items.push(...page.data.filter((item) => item.turn_id === turnId));
      if (page.has_more && !page.hasNextPage()) {
        throw new Error("Agents API items page has no continuation cursor");
      }
    }
    return items;
  }

  private async input(sessionId: string, signal: AbortSignal, event: unknown): Promise<void> {
    const response = await this.request(
      `/${encodeURIComponent(sessionId)}/events`,
      "POST",
      signal,
      {
        events: [event],
      },
    );
    await response.body?.cancel();
  }

  private async request(
    path: string,
    method: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<Response> {
    this.assertCurrent();
    signal.throwIfAborted();
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "OpenAI-Beta": "agents=v1",
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
      ...(method === "POST" ? { "Idempotency-Key": randomUUID() } : {}),
    };
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      this.assertCurrent();
      const guarded = await fetchWithSsrFGuard({
        url: `https://api.openai.com/v1/agents/sessions${path}`,
        signal,
        beforeRequest: this.assertCurrent,
        init: {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        },
      });
      response = responseWithRelease(guarded.response, guarded.release);
      if (response.status !== 503 || attempt === 2) {
        break;
      }
      await response.body?.cancel();
      await delay(1_000, undefined, { signal });
    }
    try {
      this.assertCurrent();
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    if (!response.ok) {
      const result: unknown = await response.json();
      const parsed = z.object({ error: errorSchema }).safeParse(result);
      throw new Error(
        `Agents API ${method} ${path}: HTTP ${response.status}${parsed.success ? `: ${parsed.data.error.message}` : ""}`,
      );
    }
    return response;
  }
}

async function* observeEvents(
  stream: AsyncIterable<AgentSessionEvent>,
  signal: AbortSignal,
  assertCurrent: () => void,
) {
  for await (const event of stream) {
    signal.throwIfAborted();
    assertCurrent();
    yield event;
  }
  signal.throwIfAborted();
}
