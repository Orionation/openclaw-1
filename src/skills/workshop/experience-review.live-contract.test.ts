import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import type { Message } from "../../llm/types.js";
import { assertExperienceReviewDecision } from "./experience-review-decision.test-support.js";

type DecisionInput = Parameters<typeof assertExperienceReviewDecision>[0];
const workshopTool = {
  id: "openclaw:core:skill_workshop",
  name: "skill_workshop",
  source: "openclaw",
};
function workshopResult(callId: string, text: string, isError = false) {
  return makeTextToolResult(
    callId,
    "tool_call",
    JSON.stringify({ tool: workshopTool, result: { content: [{ type: "text", text }] } }),
    isError,
    0,
  );
}
function abstention(): DecisionInput {
  const messages: Message[] = [
    makeTextToolResult("history", "exec", "observed recovery", false, 0),
  ];
  return {
    messages,
    startedAt: 1,
    progress: { mutationCount: 0, proposalIds: [] },
    proposals: [],
    outcome: {
      attemptedAtMs: 1,
      outcome: "nothing",
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 8 },
    },
    observation: {
      requests: [
        {
          toolNames: ["exec", "read", "tool_search", "tool_describe", "tool_call"],
          outputs: messages
            .filter((message) => message.role === "toolResult")
            .map((message) =>
              message.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n"),
            ),
        },
      ],
      finalText: "NO_REPLY",
      toolCalls: [],
      toolResults: [],
    },
  };
}

function proposal(): DecisionInput {
  const input = abstention();
  input.progress = { mutationCount: 1, proposalIds: ["proposal-1"] };
  input.proposals = [{ id: "proposal-1", status: "pending" }];
  input.outcome = { ...input.outcome!, outcome: "proposed", proposalId: "proposal-1" };
  input.observation.toolCalls = [
    {
      type: "toolCall",
      id: "create",
      name: "tool_call",
      arguments: { id: workshopTool.id, args: { action: "create" } },
    },
  ];
  input.observation.toolResults = [workshopResult("create", "Created proposal-1")];
  return input;
}

describe("Workshop live decision acceptance", () => {
  it("requires explicit abstention with intact evidence and a fresh recorded outcome", () => {
    expect(assertExperienceReviewDecision(abstention())).toBe("abstained");
  });

  it.each(["read", "prepare_patch"])(
    "allows successful %s before explicit abstention",
    (action) => {
      const input = abstention();
      input.observation.toolCalls.push({
        type: "toolCall",
        id: "prepare",
        name: "tool_call",
        arguments: { id: workshopTool.id, args: { action, name: "existing-skill" } },
      });
      input.observation.toolResults.push(workshopResult("prepare", "Existing skill content"));
      expect(assertExperienceReviewDecision(input)).toBe("abstained");
    },
  );

  it.each([
    [
      "empty completion",
      (input: DecisionInput) => {
        input.observation.finalText = "";
      },
    ],
    [
      "generic completion",
      (input: DecisionInput) => {
        input.observation.finalText = "There is nothing useful to add.";
      },
    ],
    [
      "lost replay result",
      (input: DecisionInput) => {
        input.observation.requests[0]!.outputs.pop();
      },
    ],
    [
      "missing Workshop dispatcher",
      (input: DecisionInput) => {
        input.observation.requests[0]!.toolNames = ["exec", "read"];
      },
    ],
    [
      "stale recorded outcome",
      (input: DecisionInput) => {
        input.outcome!.attemptedAtMs = 0;
      },
    ],
    [
      "missing outcome",
      (input: DecisionInput) => {
        input.outcome = undefined;
      },
    ],
    [
      "mutation attempt before abstention",
      (input: DecisionInput) => {
        input.observation.toolCalls.push({
          type: "toolCall",
          id: "read",
          name: "tool_call",
          arguments: {
            id: workshopTool.id,
            args: { action: "create", name: "existing-skill" },
          },
        });
        input.observation.toolResults.push(workshopResult("read", "Existing skill content"));
      },
    ],
    [
      "rejected tool",
      (input: DecisionInput) => {
        input.observation.toolResults.push(workshopResult("rejected", "name required", true));
      },
    ],
  ] as const)("rejects %s even when the proposal count is zero", (_label, corrupt) => {
    const input = abstention();
    corrupt(input);
    expect(() => assertExperienceReviewDecision(input)).toThrow();
  });
  it("accepts one pending proposal backed by a matching successful tool receipt", () => {
    expect(assertExperienceReviewDecision(proposal())).toBe("proposed");
  });
  it.each([
    [
      "missing mutation call",
      (input: DecisionInput) => {
        input.observation.toolCalls = [];
      },
    ],
    [
      "missing proposal record",
      (input: DecisionInput) => {
        input.proposals = [];
      },
    ],
    [
      "wrong tool receipt",
      (input: DecisionInput) => {
        input.observation.toolResults[0]!.toolCallId = "unrelated";
      },
    ],
    [
      "extra mutation",
      (input: DecisionInput) => {
        input.progress.mutationCount = 2;
      },
    ],
  ] as const)("rejects %s even when one proposal ID is reported", (_label, corrupt) => {
    const input = proposal();
    corrupt(input);
    expect(() => assertExperienceReviewDecision(input)).toThrow();
  });
});

describe("Workshop discovery receipt acceptance", () => {
  function discoveredProposal() {
    const input = proposal();
    input.observation.toolCalls.unshift({
      type: "toolCall",
      id: "discover",
      name: "tool_search",
      arguments: { query: "skill_workshop", limit: 1 },
    });
    input.observation.toolResults.unshift(
      makeTextToolResult("discover", "tool_search", JSON.stringify([workshopTool]), false, 0),
    );
    return input;
  }

  it("accepts a proposal with paired discovery and mutation receipts", () => {
    expect(assertExperienceReviewDecision(discoveredProposal())).toBe("proposed");
  });

  it.each([
    [
      "unpaired discovery",
      (input: DecisionInput) => {
        input.observation.toolResults.shift();
      },
    ],
    [
      "foreign target",
      (input: DecisionInput) => {
        input.observation.toolCalls[1]!.arguments = {
          id: "openclaw:core:exec",
          args: { action: "create" },
        };
      },
    ],
    [
      "foreign receipt",
      (input: DecisionInput) => {
        input.observation.toolResults[1]!.content = [
          {
            type: "text",
            text: JSON.stringify({
              tool: { id: "openclaw:core:exec", name: "exec", source: "openclaw" },
              result: { content: [{ type: "text", text: "Created proposal-1" }] },
            }),
          },
        ];
      },
    ],
  ] as const)("rejects %s despite reported proposal progress", (_label, corrupt) => {
    const input = discoveredProposal();
    corrupt(input);
    expect(() => assertExperienceReviewDecision(input)).toThrow();
  });
});
