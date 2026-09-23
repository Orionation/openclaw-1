// Release priority: while a Full Release Validation parent runs, hosted-runner
// PR-side workflows defer through a job-level `if` on the repo variable below,
// and `pnpm frv prioritize` cancels queued non-release runs, then restores them.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const RELEASE_PRIORITY_VARIABLE = "OPENCLAW_RELEASE_PRIORITY_RUN";
export const RELEASE_PRIORITY_RECORD_KIND = "openclaw.frv-release-priority";
export const CI_GATE_JOB = "openclaw/ci-gate";
// Hosted-runner workflows whose root jobs carry the variable gate.
export const RELEASE_PRIORITY_WORKFLOWS = Object.freeze([
  "CI",
  "Security Review",
  "Auto response",
  "PR context and evidence",
  "Labeler",
  "CodeQL",
  "CodeQL Critical Quality",
  "CodeQL macOS Critical Security",
  "CodeQL Android Critical Security",
  "Periphery Dead Code Comment",
  "Workflow Sanity",
  "ClawSweeper Dispatch",
  "Maintainer Command Reactions",
]);
const QUEUED_STATUSES = new Set(["queued", "pending", "waiting"]);

export function isReleaseBranch(name) {
  return /^release(?:-ci|-publish)?\//u.test(String(name ?? ""));
}

// Release children are dispatched; operator dispatches keep their intent.
function deferrable(run, parentRunId) {
  return (
    RELEASE_PRIORITY_WORKFLOWS.includes(run?.name) &&
    run.event !== "workflow_dispatch" &&
    !isReleaseBranch(run.head_branch) &&
    String(run.id) !== String(parentRunId)
  );
}

export function describeRun(run) {
  return {
    event: String(run.event ?? ""),
    headBranch: String(run.head_branch ?? ""),
    id: String(run.id),
    name: String(run.name ?? ""),
    url: String(run.html_url ?? ""),
  };
}

export function selectQueuedRunsToCancel(runs, parentRunId) {
  return runs
    .filter((run) => QUEUED_STATUSES.has(run.status) && deferrable(run, parentRunId))
    .map(describeRun);
}

// Gated workflows end skipped; a deferred CI run skips every lane and its gate
// fails naming the release, which keeps the PR unmergeable until the rerun.
export function selectDeferredRunCandidates(runs, record) {
  return runs.filter(
    (run) =>
      run.status === "completed" &&
      String(run.created_at ?? "") >= record.recordedAt &&
      deferrable(run, record.parentRunId) &&
      (run.conclusion === "skipped" || (run.name === "CI" && run.conclusion === "failure")),
  );
}

export function isDeferredCiJobSet(jobs) {
  return (
    jobs.length > 0 &&
    jobs.every((job) =>
      job.name === CI_GATE_JOB ? job.conclusion === "failure" : job.conclusion === "skipped",
    )
  );
}

export function defaultReleasePriorityRecordPath(parentRunId) {
  return `.artifacts/frv-release-priority-${parentRunId}.json`;
}

export function writeReleasePriorityRecord(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

export function readReleasePriorityRecord(path) {
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (
    record?.kind !== RELEASE_PRIORITY_RECORD_KIND ||
    !/^[1-9][0-9]*$/u.test(String(record.parentRunId)) ||
    Number.isNaN(Date.parse(record.recordedAt)) ||
    !Array.isArray(record.cancelled) ||
    record.cancelled.some((run) => !/^[1-9][0-9]*$/u.test(String(run?.id)))
  ) {
    throw new Error(`release priority record is invalid: ${path}`);
  }
  return record;
}
