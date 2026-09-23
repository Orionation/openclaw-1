import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { makeEmbeddedRunnerAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  getCoreTtsAttemptResultMediaUrls,
  markCoreTtsAttemptResult,
} from "../../tools/tts-tool-result-provenance.js";
import { registerAgentWorkspaceAccess, type AgentWorkspaceAccess } from "../../workspace-access.js";
import { runEmbeddedAttemptWithBackend } from "./backend.js";
import { prepareEmbeddedAttemptPromptExecution } from "./prompt-image-preparation.js";

const harnessMocks = vi.hoisted(() => ({
  runAttempt: vi.fn(),
  settleRequester: vi.fn(),
}));

vi.mock("../../harness/selection.js", () => ({
  runAgentHarnessAttempt: harnessMocks.runAttempt,
  runAgentHarnessSettledTurnFinalization: vi.fn(),
}));

vi.mock("../../subagents/registry/subagent-registry.js", () => ({
  settleRequesterAfterSessionSpawns: harnessMocks.settleRequester,
}));

describe("embedded attempt backend", () => {
  beforeEach(() => {
    harnessMocks.runAttempt.mockReset();
    harnessMocks.settleRequester.mockReset();
  });

  it.each([
    { yielded: true, settled: true, accepted: true, expected: true },
    { yielded: true, settled: false, accepted: true, expected: undefined },
    { yielded: false, settled: true, accepted: true, expected: undefined },
    { yielded: true, settled: false, accepted: false, expected: undefined },
  ])(
    "requires core settlement before acknowledging continuation ($yielded/$settled/$accepted)",
    async ({ yielded, settled, accepted, expected }) => {
      harnessMocks.settleRequester.mockReturnValue(settled);
      harnessMocks.runAttempt.mockResolvedValueOnce(
        makeEmbeddedRunnerAttempt({
          agentHarnessId: "codex",
          yieldDetected: yielded,
          // A harness-supplied value must not manufacture core settlement.
          requesterContinuationSettled: true,
          acceptedSessionSpawns: accepted
            ? [{ runId: "child", childSessionKey: "agent:main:subagent:child" }]
            : [],
        }),
      );
      const result = await runEmbeddedAttemptWithBackend({
        sessionKey: "agent:main:main",
        agentId: "main",
        runId: "parent",
      } as never);
      expect(result.requesterContinuationSettled).toBe(expected);
    },
  );

  it("does not return a continuation acknowledgment when registry persistence throws", async () => {
    harnessMocks.settleRequester.mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    harnessMocks.runAttempt.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        agentHarnessId: "codex",
        yieldDetected: true,
        acceptedSessionSpawns: [{ runId: "child", childSessionKey: "agent:main:subagent:child" }],
      }),
    );
    await expect(
      runEmbeddedAttemptWithBackend({
        sessionKey: "agent:main:main",
        agentId: "main",
        runId: "parent",
      } as never),
    ).rejects.toThrow("storage unavailable");
  });

  it("preserves the built-in runner's completed settlement", async () => {
    harnessMocks.runAttempt.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        agentHarnessId: "openclaw",
        yieldDetected: true,
        requesterContinuationSettled: true,
      }),
    );
    const result = await runEmbeddedAttemptWithBackend({} as never);
    expect(result.requesterContinuationSettled).toBe(true);
    expect(harnessMocks.settleRequester).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "keeps runtime model selection only for prepared ownership (%s)",
    async (runtimeOwned) => {
      const selection = { provider: "native-provider", model: "native-model" };
      harnessMocks.runAttempt.mockResolvedValueOnce({
        agentHarnessId: "native-runtime",
        runtimeModelSelection: selection,
      });
      const nativeRuntime: NonNullable<Parameters<typeof runEmbeddedAttemptWithBackend>[1]> = {
        harness: {
          id: "native-runtime",
          label: "Native runtime",
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("unexpected direct harness call");
          },
        },
        auth: "native",
        assertCurrent: async () => {},
      };
      const result = await runEmbeddedAttemptWithBackend(
        {} as never,
        runtimeOwned ? nativeRuntime : undefined,
      );
      if (runtimeOwned) {
        expect(result).toMatchObject({ runtimeModelSelection: selection });
      } else {
        expect(result).not.toHaveProperty("runtimeModelSelection");
      }
    },
  );

  it("preserves core TTS delivery provenance through backend projection", async () => {
    const operationalRunInstance = {};
    const attempt = markCoreTtsAttemptResult(
      {
        agentHarnessId: "openclaw",
        toolMediaUrls: ["/tmp/reply.opus"],
      },
      ["/tmp/reply.opus"],
      operationalRunInstance,
    );
    harnessMocks.runAttempt.mockResolvedValueOnce(attempt);

    const result = await runEmbeddedAttemptWithBackend({} as never);

    expect(
      getCoreTtsAttemptResultMediaUrls(result, result.toolMediaUrls, operationalRunInstance),
    ).toEqual(["/tmp/reply.opus"]);
  });

  it.each([
    {
      name: "replaces stale harness provenance",
      credentialSource: {
        kind: "direct" as const,
        evidence: "environment" as const,
        authorization: "ambient" as const,
      },
      expected: {
        provider: "groq",
        model: "openai/gpt-oss-120b",
        credentialSource: {
          kind: "direct",
          evidence: "environment",
          authorization: "ambient",
        },
      },
    },
    {
      name: "clears provenance when the runtime does not own auth selection",
      credentialSource: undefined,
      expected: undefined,
    },
  ])("$name", async ({ credentialSource, expected }) => {
    harnessMocks.runAttempt.mockResolvedValueOnce({
      agentHarnessId: "openclaw",
      modelAttempt: {
        provider: "stale-provider",
        model: "stale-model",
        credentialSource: { kind: "profile" },
      },
    });

    const result = await runEmbeddedAttemptWithBackend({
      runtimePlan: {
        resolvedRef: { provider: "groq", modelId: "openai/gpt-oss-120b" },
        auth: credentialSource ? { credentialSource } : {},
      },
    } as never);

    expect(result.modelAttempt).toEqual(expected);
  });
});

describe("workspace inputs at harness dispatch", () => {
  async function fixture(prepare?: AgentWorkspaceAccess["prepareTurnAttachments"]) {
    const runId = randomUUID();
    const workspaceDir = `/tmp/remote-workspace-${runId}`;
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance: createOperationalRunInstanceRef(runId),
      facts: {
        runId,
        agentId: "main",
        ingress: { kind: "system", state: "present", boundary: "workspace-attachments-test" },
      },
    });
    const admittedRunContext = await admission.admit("embedded");
    const release = registerAgentWorkspaceAccess(workspaceDir, {
      bridge: {
        readFile: async () => Buffer.alloc(0),
        writeFile: async () => {},
        stat: async () => null,
      },
      prepareTurnAttachments: prepare,
    });
    return {
      params: {
        workspaceDir,
        admittedRunContext,
        prompt: "Inspect attachment",
        media: [{ path: "media://inbound/report.pdf" }],
        timeoutMs: 1_000,
      },
      admission,
      release,
      cleanup: () => {
        release();
        admission.close();
      },
    };
  }

  beforeEach(() => {
    harnessMocks.runAttempt.mockReset();
  });

  it.each(["codex", "openclaw"])(
    "prepares attachments before the %s harness and preserves original input",
    async (harness) => {
      const prepare = vi.fn<NonNullable<AgentWorkspaceAccess["prepareTurnAttachments"]>>(
        async (_turn, assertCurrent) => {
          assertCurrent();
          expect(harnessMocks.runAttempt).not.toHaveBeenCalled();
          return "Use the execution workspace input directory.";
        },
      );
      const f = await fixture(prepare);
      harnessMocks.runAttempt.mockResolvedValueOnce({ agentHarnessId: harness });
      try {
        await runEmbeddedAttemptWithBackend(f.params as never);
        const dispatched = harnessMocks.runAttempt.mock.calls[0]?.[0];
        expect(dispatched).toMatchObject({
          prompt: `${f.params.prompt}\n\nUse the execution workspace input directory.`,
          transcriptPrompt: f.params.prompt,
        });
        expect(dispatched.media).toBe(f.params.media);
        expect(f.params.prompt).toBe("Inspect attachment");
        expect(prepare.mock.calls[0]?.[0].media).toBe(f.params.media);
      } finally {
        f.cleanup();
      }
    },
  );

  it("transfers canonical documents after native image projection without a transcript recorder", async () => {
    const prepare = vi.fn<NonNullable<AgentWorkspaceAccess["prepareTurnAttachments"]>>(
      async () => "Read /remote/.inputs/report.pdf",
    );
    const f = await fixture(prepare);
    const media = [{ path: "media://inbound/report.pdf", kind: "document" as const }];
    harnessMocks.runAttempt.mockResolvedValueOnce({ agentHarnessId: "codex" });
    try {
      const projected = await prepareEmbeddedAttemptPromptExecution({
        attempt: { ...f.params, media, model: { input: ["text", "image"] } },
        mediaOwnerAgentId: "main",
        effectiveFsWorkspaceOnly: false,
        effectiveWorkspace: f.params.workspaceDir,
        prompt: "",
        skipPromptSubmission: false,
        pluginHarness: true,
      });
      expect(projected.media).toBeUndefined();
      await runEmbeddedAttemptWithBackend({ ...f.params, ...projected } as never, undefined, media);
      expect(prepare.mock.calls[0]?.[0].media).toBe(media);
      expect(harnessMocks.runAttempt.mock.calls[0]?.[0]).toMatchObject({
        prompt: "Inspect attachment\n\nRead /remote/.inputs/report.pdf",
        transcriptPrompt: "Inspect attachment",
        media: undefined,
      });
    } finally {
      f.cleanup();
    }
  });

  it("dispatches a plain remote turn without an attachment provider", async () => {
    const f = await fixture();
    harnessMocks.runAttempt.mockResolvedValueOnce({ agentHarnessId: "codex" });
    const params = { ...f.params, media: [] };
    try {
      await runEmbeddedAttemptWithBackend(params as never);
      expect(harnessMocks.runAttempt).toHaveBeenCalledWith(params, undefined);
    } finally {
      f.cleanup();
    }
  });

  it.each(["failed", "revoked", "run-closed", "aborted"])(
    "does not dispatch attachments after preparation is %s",
    async (failure) => {
      const controller = new AbortController();
      const f = await fixture(async (_turn, assertCurrent) => {
        if (failure === "failed") {
          throw new Error("transfer unavailable");
        }
        if (failure === "revoked") {
          f.release();
        } else if (failure === "run-closed") {
          f.admission.close();
        } else {
          controller.abort(new Error("cancelled"));
        }
        expect(assertCurrent).toThrow();
        return "obsolete input directory";
      });
      try {
        await expect(
          runEmbeddedAttemptWithBackend({
            ...f.params,
            abortSignal: controller.signal,
          } as never),
        ).rejects.toThrow();
        expect(harnessMocks.runAttempt).not.toHaveBeenCalled();
      } finally {
        f.cleanup();
      }
    },
  );
});
