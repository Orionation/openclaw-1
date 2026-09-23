import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ChokidarOptions } from "chokidar";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fixture = fileURLToPath(new URL("./chokidar-native-namespace.fixture.mjs", import.meta.url));
const namespaceOptions = { nativeWatchNamespace: {} } satisfies ChokidarOptions;

it.each([
  "sharing",
  "synthetic-child",
  "synthetic-child-nonpersistent",
  "synthetic-child-nonpersistent-default",
  "reentrant-handoff",
  "retired-callbacks",
  "retired-callbacks-default",
  "delayed-eperm",
  "delayed-eperm-default",
  "nonpersistent-polling",
  "polling-returned-disposer",
  "directory-close-default",
  "directory-close-namespace",
  "directory-close-nonpersistent",
  "directory-close-polling",
  "file-add-close",
  "relative-unwatch",
  "symlink-unwatch",
])("preserves the real Chokidar native ownership contract: %s", (scenario) => {
  expect(namespaceOptions.nativeWatchNamespace).toEqual({});
  const result = spawnSync(process.execPath, [fixture, require.resolve("chokidar"), scenario], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    scenario,
    passed: true,
    nativeCloseEventsJoined: true,
    pollingStopEventsJoined: true,
  });
});
