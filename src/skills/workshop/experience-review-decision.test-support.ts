import type { AgentMessage } from "@openclaw/agent-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import { readToolSearchCallArgs, readToolSearchId } from "../../agents/tool-search-request.js";
import type { readSkillCuratorReviewStatus } from "./collection-review-state.test-support.js";
import { readExperienceReviewMessageText } from "./experience-review-message-text.test-support.js";
import type { observeExperienceReview } from "./experience-review-observation.test-support.js";
import type { getSkillProposalRunProgress } from "./proposal-run-progress.test-support.js";
import type { listSkillProposals } from "./service.js";

export function assertExperienceReviewDecision(params: {
  observation: Awaited<ReturnType<typeof observeExperienceReview>>;
  messages: AgentMessage[];
  progress: Awaited<ReturnType<typeof getSkillProposalRunProgress>>;
  proposals: readonly Pick<
    Awaited<ReturnType<typeof listSkillProposals>>["proposals"][number],
    "id" | "status"
  >[];
  outcome: ReturnType<typeof readSkillCuratorReviewStatus>["experienceReviews"][string] | undefined;
  startedAt: number;
}): "proposed" | "abstained" {
  const { observation, progress, proposals, outcome } = params;
  expect(observation.requests[0]?.toolNames).toEqual(
    expect.arrayContaining(["exec", "read", "tool_search", "tool_describe", "tool_call"]),
  );
  expect(observation.requests[0]?.toolNames).not.toContain("skill_workshop");
  expect(observation.requests[0]?.outputs).toEqual(
    params.messages
      .filter((message) => message.role === "toolResult")
      .map((message) => readExperienceReviewMessageText(message.content)),
  );
  expect(outcome?.attemptedAtMs).toBeGreaterThanOrEqual(params.startedAt);
  expect(outcome?.usage?.outputTokens).toBeGreaterThan(0);
  expect(observation.toolResults.some((result) => result.isError)).toBe(false);
  const workshopCalls: Array<{ action: unknown; receiptText: string }> = [];
  for (const call of observation.toolCalls) {
    const receipts = observation.toolResults.filter(
      (result) => result.toolName === call.name && result.toolCallId === call.id,
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.isError).toBe(false);
    const text = readExperienceReviewMessageText(receipts[0]!.content);
    if (call.name === "tool_search") {
      continue;
    }
    if (call.name === "tool_describe") {
      expect(["skill_workshop", "openclaw:core:skill_workshop"]).toContain(
        readToolSearchId(call.arguments),
      );
      continue;
    }
    expect(call.name).toBe("tool_call");
    const target = readToolSearchCallArgs(call.arguments);
    expect(["skill_workshop", "openclaw:core:skill_workshop"]).toContain(target.id);
    const envelope: unknown = JSON.parse(text);
    if (!isRecord(envelope) || !isRecord(envelope.result)) {
      throw new Error("Expected a structured Workshop call receipt");
    }
    expect(envelope.tool).toMatchObject({
      id: "openclaw:core:skill_workshop",
      name: "skill_workshop",
      source: "openclaw",
    });
    workshopCalls.push({
      action: isRecord(target.input) ? target.input.action : undefined,
      receiptText: JSON.stringify(envelope.result),
    });
  }
  const mutations = workshopCalls.filter((call) =>
    ["create", "patch", "update", "revise"].includes(String(call.action)),
  );
  if (progress.mutationCount === 0) {
    expect(mutations).toHaveLength(0);
    for (const call of workshopCalls) {
      expect(call.action).toSatisfy(
        (action: unknown) =>
          action === "list" ||
          action === "inspect" ||
          action === "read" ||
          action === "prepare_patch",
      );
    }
    expect(progress.proposalIds).toEqual([]);
    expect(observation.finalText).toBe("NO_REPLY");
    expect(outcome?.outcome).toBe("nothing");
    return "abstained";
  }
  expect(progress.mutationCount).toBe(1);
  expect(progress.proposalIds).toHaveLength(1);
  expect(mutations).toHaveLength(1);
  const proposalId = progress.proposalIds[0]!;
  expect(proposals).toContainEqual(expect.objectContaining({ id: proposalId, status: "pending" }));
  expect(mutations[0]!.receiptText).toContain(proposalId);
  expect(outcome).toMatchObject({ outcome: "proposed", proposalId });
  return "proposed";
}
