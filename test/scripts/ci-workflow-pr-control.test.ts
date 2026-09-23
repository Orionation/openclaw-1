import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  evaluateWorkflowExpression,
  readCiWorkflow,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("PR failure cancellation", () => {
  it("uses prompt paid capacity only for current failure reporting", () => {
    const gate = readCiWorkflow().jobs["ci-gate"];
    const context = {
      eventName: "pull_request" as const,
      repository: "openclaw/openclaw",
      runAttempt: 1,
      runnerProfile: "hybrid" as const,
      failFastOutputs: { failure_job_id: "42", failure_run_attempt: "1" },
    };
    expect(evaluateWorkflowExpression(gate["runs-on"], context)).toBe(
      "blacksmith-4vcpu-ubuntu-2404",
    );
    for (const override of [
      { failFastOutputs: {} },
      { runAttempt: 2 },
      { runnerProfile: "github" as const },
      { eventName: "push" as const },
      { eventName: "workflow_dispatch" as const },
      { headRepository: "contributor/openclaw" },
    ]) {
      expect(evaluateWorkflowExpression(gate["runs-on"], { ...context, ...override })).toBe(
        "ubuntu-24.04",
      );
    }
  });
  it("limits cancellation authority to the same-repository PR monitor", () => {
    const workflow = readCiWorkflow();
    expect(
      Object.entries(workflow.jobs)
        .filter(
          ([, job]) =>
            (job as { permissions?: { actions?: string } }).permissions?.actions === "write",
        )
        .map(([name]) => name),
    ).toEqual(["pr-fail-fast"]);
    for (const [eventName, headRepository, admitted] of [
      ["pull_request", "openclaw/openclaw", true],
      ["pull_request", "contributor/openclaw", false],
      ["push", "openclaw/openclaw", false],
      ["workflow_dispatch", "openclaw/openclaw", false],
    ] as const) {
      expect(
        evaluateWorkflowExpression(workflow.jobs["pr-fail-fast"].if, {
          eventName,
          headRepository,
          repository: "openclaw/openclaw",
          runAttempt: 1,
          preflightOutputs: { run_checks_node_core_nondist: "true" },
        }),
      ).toBe(admitted);
    }
  });
  it("does not admit the final gate for cancelled workflows or draft pull requests", () => {
    const gate = readCiWorkflow().jobs["ci-gate"];
    for (const eventName of ["pull_request", "push", "workflow_dispatch"] as const) {
      for (const cancelled of [true, false]) {
        for (const draft of [true, false]) {
          expect(
            evaluateWorkflowExpression(gate.if, {
              cancelled,
              draft,
              eventName,
              repository: "openclaw/openclaw",
              runAttempt: 1,
            }),
            JSON.stringify({ cancelled, draft, eventName }),
          ).toBe(!cancelled && (eventName !== "pull_request" || !draft));
        }
      }
    }
  });

  it.each(["pull_request", "push", "workflow_dispatch"] as const)(
    "uses native matrix fail-fast only for PRs (%s)",
    (eventName) => {
      const workflow = readCiWorkflow();
      const failFast = workflow.jobs["checks-node-core-test-nondist-shard"].strategy["fail-fast"];
      expect(
        typeof failFast === "string"
          ? evaluateWorkflowExpression(failFast, {
              eventName,
              repository: "openclaw/openclaw",
              runAttempt: 1,
            })
          : failFast,
      ).toBe(eventName === "pull_request");
    },
  );

  it("keeps an uncertain cancellation red even if cause outputs are unavailable", () => {
    expect(
      evaluateWorkflowExpression(readCiWorkflow().jobs["ci-gate"].if, {
        eventName: "pull_request",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        cancelled: true,
        failFastResult: "failure",
      }),
    ).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "does not reuse a previous attempt's failure cause or monitor result",
    () => {
      const workflow = readCiWorkflow();
      const gate = workflow.jobs["ci-gate"];
      const context = {
        eventName: "pull_request" as const,
        repository: "openclaw/openclaw",
        runAttempt: 2,
        failFastOutputs: { failure_job_id: "42", failure_run_attempt: "1" },
        failFastResult: "failure",
        preflightOutputs: { run_checks_node_core_nondist: "true" },
      };
      expect(evaluateWorkflowExpression(workflow.jobs["pr-fail-fast"].if, context)).toBe(false);
      expect(evaluateWorkflowExpression(gate.if, { ...context, cancelled: true })).toBe(false);
      const report = gate.steps.find(
        (entry: WorkflowStep) => entry.name === "Report originating PR failure",
      );
      expect(evaluateWorkflowExpression(`\${{ ${report.if} }}`, context)).toBe(false);
      const verify = gate.steps.find(
        (entry: WorkflowStep) => entry.name === "Verify selected CI lanes",
      );
      const monitorRow = verify.env.JOB_RESULTS.split("\n")
        .find((line: string) => line.startsWith("pr-fail-fast="))
        .replace(/\$\{\{[\s\S]*?\}\}/gu, (expression: string) =>
          String(evaluateWorkflowExpression(expression, context)),
        );
      expect(monitorRow).toBe("pr-fail-fast=skipped|false");
      for (const [result, exit] of [
        ["success", 0],
        ["failure", 1],
        ["cancelled", 1],
      ] as const) {
        const run = spawnSync("/bin/bash", ["-c", verify.run], {
          encoding: "utf8",
          env: {
            ...process.env,
            JOB_RESULTS: `preflight=success|true\nsecurity-fast=success|true\nchecks-node-core-test-nondist-shard=${result}|true\n${monitorRow}`,
          },
        });
        expect(run.status, run.stdout).toBe(exit);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports the originating failure after cancelling other jobs",
    () => {
      const workflow = readCiWorkflow();
      const gate = workflow.jobs["ci-gate"];
      expect(
        evaluateWorkflowExpression(gate.if, {
          eventName: "pull_request",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          cancelled: true,
          failFastOutputs: { failure_job_id: "42", failure_run_attempt: "1" },
        }),
      ).toBe(true);
      const summary = path.join(tempDirs.make("pr-cancel-gate-"), "summary.md");
      const step = gate.steps.find(
        (entry: WorkflowStep) => entry.name === "Report originating PR failure",
      );
      expect(
        evaluateWorkflowExpression(`\${{ ${step.if} }}`, {
          eventName: "pull_request",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          cancelled: true,
          failFastOutputs: { failure_job_id: "42", failure_run_attempt: "1" },
        }),
      ).toBe(true);
      const result = spawnSync("/bin/bash", ["-c", step.run], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_REPOSITORY: "openclaw/openclaw",
          GITHUB_RUN_ID: "100",
          FAILURE_JOB_ID: "42",
          FAILURE_JOB_NAME: "checks-node-example",
        },
      });
      expect(result.status, result.stderr).toBe(1);
      expect(readFileSync(summary, "utf8")).toContain("checks-node-example");
      expect(readFileSync(summary, "utf8")).toContain("/actions/runs/100/job/42");
    },
  );
});
