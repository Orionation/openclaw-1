import { afterEach, describe, expect, it, vi } from "vitest";
import { monitorPrFailure } from "../../scripts/ci-pr-fail-fast.mjs";

const repository = "openclaw/openclaw";
const headSha = "a".repeat(40);
const run = {
  id: 100,
  run_attempt: 1,
  workflow_id: 22,
  run_number: 500,
  event: "pull_request",
  path: ".github/workflows/ci.yml",
  status: "in_progress",
  head_sha: headSha,
  head_branch: "fixture",
  repository: { full_name: repository },
  head_repository: { full_name: repository },
};
const pull = {
  state: "open",
  draft: false,
  head: { sha: headSha, ref: "fixture", repo: { full_name: repository } },
  base: { repo: { full_name: repository } },
};
const job = (id: number, conclusion: string | null = "success", name = `row-${id}`) => ({
  id,
  run_id: 100,
  run_attempt: 1,
  name,
  conclusion,
  status: conclusion === null ? "in_progress" : "completed",
  completed_at: conclusion ? "2026-09-23T00:01:00Z" : null,
});

function fixture(
  options: {
    jobs?: ReturnType<typeof job>[];
    currentPull?: typeof pull;
    currentRun?: typeof run;
    laterRun?: typeof run;
    recentRuns?: (typeof run)[];
    postError?: boolean;
  } = {},
) {
  let runReads = 0;
  const events: string[] = [];
  const rows = options.jobs ?? [job(1), job(2), job(3, "failure"), job(4, null)];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const route = new URL(url).pathname.replace(`/repos/${repository}`, "");
    if (init?.method === "POST") {
      events.push(`POST ${route}`);
      if (options.postError) {
        throw new Error("simulated response loss");
      }
      return new Response(null, { status: 202 });
    }
    let body: unknown;
    if (route === "/actions/runs/100") {
      body =
        runReads++ > 0
          ? (options.laterRun ?? options.currentRun ?? run)
          : (options.currentRun ?? run);
    } else if (route === "/pulls/7") {
      body = options.currentPull ?? pull;
    } else if (route === "/actions/workflows/22/runs") {
      body = { workflow_runs: options.recentRuns ?? [run] };
    } else if (route === "/actions/runs/100/attempts/1/jobs") {
      const page = Number(new URL(url).searchParams.get("page"));
      body = { total_count: rows.length, jobs: rows.slice((page - 1) * 100, page * 100) };
    } else {
      throw new Error(`Unexpected API route: ${route}`);
    }
    return new Response(JSON.stringify(body));
  });
  vi.stubGlobal("fetch", fetchMock);
  const recordFailure = vi.fn((failed: { id: number; name: string }) => {
    events.push(`cause ${failed.id}`);
  });
  return {
    events,
    rows,
    fetchMock,
    recordFailure,
    monitor: (expectedJobCount = 4, runAttempt = 1) =>
      monitorPrFailure({
        repository,
        headSha,
        runId: 100,
        runAttempt,
        pullRequestNumber: 7,
        expectedJobCount,
        token: "synthetic-test-token",
        recordFailure,
      }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("PR failure monitor", () => {
  it("leaves partial reruns to native fail-fast without waiting for cached jobs", async () => {
    const f = fixture({ jobs: [job(3)] });
    expect(await f.monitor(100, 2)).toBe("retry");
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  });
  it("records the failed row before cancelling only its own attempt's run", async () => {
    const f = fixture({ jobs: [job(1), job(2), job(3, "failure"), job(4, "cancelled")] });
    expect(await f.monitor()).toBe("failure-cancelled");
    expect(f.recordFailure).toHaveBeenCalledWith({ id: 3, name: "row-3", runAttempt: 1 });
    expect(f.events).toEqual(["cause 3", "POST /actions/runs/100/cancel"]);
  });

  it("retains the failure cause when the cancellation response is lost, without retrying", async () => {
    const f = fixture({ postError: true });
    await expect(f.monitor()).rejects.toThrow("simulated response loss");
    expect(f.events).toEqual(["cause 3", "POST /actions/runs/100/cancel"]);
  });

  it.each(["push", "workflow_dispatch"])("never cancels a %s run", async (event) => {
    const f = fixture({ currentRun: { ...run, event } });
    await expect(f.monitor()).rejects.toThrow("identity changed");
    expect(f.events).toEqual([]);
  });

  it("never gives a fork run cancellation authority", async () => {
    const f = fixture({
      currentRun: { ...run, head_repository: { full_name: "contributor/openclaw" } },
    });
    await expect(f.monitor()).rejects.toThrow("identity changed");
    expect(f.events).toEqual([]);
  });

  it.each(["new head", "draft", "closed", "same-head newer run", "new attempt"])(
    "preserves superseding work (%s)",
    async (change) => {
      const f = fixture({
        currentPull: {
          ...pull,
          state: change === "closed" ? "closed" : "open",
          draft: change === "draft",
          head: { ...pull.head, sha: change === "new head" ? "b".repeat(40) : headSha },
        },
        recentRuns:
          change === "same-head newer run" ? [{ ...run, id: 101, run_number: 501 }] : [run],
        laterRun: change === "new attempt" ? { ...run, run_attempt: 2 } : run,
      });
      expect(await f.monitor()).toBe("superseded");
      expect(f.events).toEqual([]);
    },
  );

  it("does not record a failure for externally cancelled rows", async () => {
    const f = fixture({ jobs: [job(1), job(2), job(3, "cancelled")] });
    expect(await f.monitor()).toBe("externally-cancelled");
    expect(f.events).toEqual([]);
  });

  it("waits for all selected jobs to appear before declaring success", async () => {
    vi.useFakeTimers();
    const f = fixture({ jobs: [job(1), job(2)] });
    const monitor = f.monitor(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
    f.rows.push(job(3, "failure"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await monitor).toBe("failure-cancelled");
  });

  it("finds a failure beyond the first job page", async () => {
    const f = fixture({
      jobs: Array.from({ length: 101 }, (_, i) => job(i + 1, i === 100 ? "failure" : "success")),
    });
    expect(await f.monitor(101)).toBe("failure-cancelled");
    expect(f.recordFailure).toHaveBeenCalledWith({ id: 101, name: "row-101", runAttempt: 1 });
  });

  it("finishes a successful selected graph without waiting on its own gate", async () => {
    const f = fixture({
      jobs: [
        job(1),
        job(2),
        job(3),
        job(4, null, "pr-fail-fast"),
        job(5, null, "openclaw/ci-gate"),
      ],
    });
    expect(await f.monitor(3)).toBe("completed");
    expect(f.events).toEqual([]);
  });
});
