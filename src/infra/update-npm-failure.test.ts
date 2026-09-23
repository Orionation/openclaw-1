import { describe, expect, it } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { classifyPackageUpdatePermissionFailure } from "./package-update-manager-preflight.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import { runStep } from "./update-runner-command.js";

const context = { env: { HOME: "/home/example" }, stateDir: "/npm-report-state" };

describe("npm install failure reports", () => {
  it.each(["EACCES", undefined])(
    "retains spawned npm diagnostics in direct and recorded reports (code=%s)",
    async (code) => {
      const token = `npm_${"synthetic".repeat(5)}`;
      const stderr = [
        "npm warn unrelated warning",
        ...(code ? [`npm ERR! code ${code}`] : []),
        "npm ERR! install failed while preparing package",
        "npm ERR! path /home/example/private directory/package",
        `npm ERR! token=${token}`,
        "npm ERR! registry https://example-user:synthetic-password@registry.example.test/pkg",
        "npm ERR! omitted line",
      ].join("\n");
      const step = await runStep({
        name: "package-install",
        argv: [
          process.execPath,
          "-e",
          "process.stderr.write(process.argv[1]); process.exitCode = 1",
          stderr,
        ],
        cwd: process.cwd(),
        env: context.env,
        runCommand: runCommandWithTimeout,
        stepIndex: 0,
        totalSteps: 1,
      });
      expect(step.exitCode).toBe(1);
      expect(step.failureFacts?.[0]).toMatchObject({ check: "npm", code: code ?? "unknown" });
      for (const recorded of [false, true]) {
        const report = await prepareUpdateFailureReport(
          {
            attemptId: "npm-fixture",
            result: {
              mode: "npm",
              status: "error",
              reason: "global-install-failed",
              durationMs: 1,
              steps: recorded ? [] : [step],
            },
            ...(recorded
              ? { recordedRun: { runId: "npm-fixture", steps: updateRunStepsFromResultStep(step) } }
              : {}),
          },
          context,
        );
        expect(report.body).toContain(`npm failure code: ${code ?? "unknown"}`);
        expect(report.body).toContain("npm ERR! install failed while preparing package");
        expect(report.body).toContain("[redacted-path]");
        for (const privateText of [
          token,
          "/home/example",
          "private directory",
          "example-user",
          "synthetic-password",
          "unrelated warning",
        ]) {
          expect(report.body).not.toContain(privateText);
          expect(JSON.stringify(step.failureFacts)).not.toContain(privateText);
        }
        if (code) {
          expect(report.body).toContain("Next step: Check the npm global prefix");
        }
      }
      if (code) {
        const classified = await classifyPackageUpdatePermissionFailure(
          step,
          { manager: "npm", command: "npm", globalRoot: process.cwd(), packageRoot: process.cwd() },
          context.env,
        );
        const report = await prepareUpdateFailureReport(
          {
            attemptId: "npm-permission",
            result: { mode: "npm", status: "error", durationMs: 1, steps: [classified] },
          },
          context,
        );
        expect(report.body).toContain("npm failure code: EACCES");
        expect(report.body).toContain("npm ERR! install failed while preparing package");
      }
    },
  );

  it.each([
    ["ENOSPC", "Free disk space"],
    ["E404", "Check the configured npm registry"],
    ["ETARGET", "Check the configured npm registry"],
    ["ECONNRESET", "npm failure code: ECONNRESET"],
    ["PRIVATE_IDENTIFIER", "npm failure code: unknown"],
  ])("retains whole stdout diagnostic lines and classifies %s", async (code, guidance) => {
    const cause = "npm error install failed while preparing package";
    const detail = "npm error retained detail after oversized lines";
    const omitted = "npm error (20 lines omitted: exceed 200-byte diagnostic limit)";
    const step = await runStep({
      name: "package-install-omit-optional",
      argv: ["npm", "install", "-g", "openclaw"],
      cwd: process.cwd(),
      env: context.env,
      runCommand: async () => ({
        code: 1,
        stderr: "",
        stdout: [
          `npm error code ${code}`,
          cause,
          ...Array.from({ length: 20 }, () => `npm error ${"🦞".repeat(200)}`),
          detail,
        ].join("\n"),
      }),
      stepIndex: 0,
      totalSteps: 1,
    });
    const excerpt = step.failureFacts?.map((fact) => fact.message).join("\n") ?? "";
    expect(excerpt.split("\n")).toEqual([
      `npm error code ${code === "PRIVATE_IDENTIFIER" ? "unknown" : code}`,
      cause,
      detail,
      omitted,
    ]);
    expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(1024);
    expect(excerpt.split("\n").length).toBeLessThanOrEqual(12);
    const report = await prepareUpdateFailureReport(
      {
        attemptId: "npm-bound",
        result: { mode: "npm", status: "error", steps: [step], durationMs: 1 },
      },
      context,
    );
    expect(report.body).toContain(guidance);
    for (const line of [cause, detail, omitted]) {
      expect(report.body).toContain(`- ${line}\n`);
    }
    expect(report.body).not.toContain("PRIVATE_IDENTIFIER");
    expect(report.body).not.toContain("\ufffd");
  });
});
