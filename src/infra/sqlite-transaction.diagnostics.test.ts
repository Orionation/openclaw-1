import { afterEach, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { logSlowSqliteCoordinatorWait } from "./sqlite-transaction.js";

const previousConsole = loggingState.rawConsole;

afterEach(() => {
  vi.restoreAllMocks();
  loggingState.rawConsole = previousConsole;
  setLoggerOverride(null);
  resetLogger();
});

it("attributes a generic coordinator wait to its owning caller without tracing fast admission", () => {
  setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "json" });
  const warn = vi.fn();
  loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  const capture = vi.spyOn(Error, "captureStackTrace");
  const options = { databaseLabel: "synthetic.sqlite", operationLabel: "state.write" };
  logSlowSqliteCoordinatorWait(100, options);
  expect(capture).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();

  function finalizeSyntheticRun() {
    logSlowSqliteCoordinatorWait(600, options);
  }
  finalizeSyntheticRun();
  expect(warn).toHaveBeenCalledOnce();
  expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
    message: "slow SQLite coordinator lock wait",
    caller: expect.stringContaining("finalizeSyntheticRun"),
    database: "synthetic.sqlite",
    elapsedMs: 600,
    operation: "state.write",
    async: false,
  });
});

it("preserves coordinator admission when diagnostic stack capture fails", () => {
  vi.spyOn(Error, "captureStackTrace").mockImplementation(() => {
    throw new Error("Synthetic diagnostics failure");
  });
  expect(() =>
    logSlowSqliteCoordinatorWait(600, { operationLabel: "task.mutation" }),
  ).not.toThrow();
});
