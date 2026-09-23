import assert from "node:assert/strict";
import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [entry, scenario] = process.argv.slice(2);
const root = await promises.mkdtemp(path.join(os.tmpdir(), "chokidar-native-owner-"));
const originalWatch = fs.watch;
const originalWatchFile = fs.watchFile;
const originalUnwatchFile = fs.unwatchFile;
const originalOpen = promises.open;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalCwd = process.cwd();
const owners = [];
const handles = [];
const polling = new Set();
const pollingHandles = [];
const pending = [];
const releases = [];
let passed = false;
let nativeRescues = 0;
let pollingRescues = 0;
let scenarioError;
let returnedPollingClose;

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ownNative(watchedPath) {
  return (
    path.resolve(String(watchedPath)).startsWith(root + path.sep) ||
    path.resolve(String(watchedPath)) === root
  );
}

try {
  fs.watch = function (watchedPath, options, listener) {
    const native = originalWatch.call(this, watchedPath, options, listener);
    if (!ownNative(watchedPath)) return native;
    const closed = deferred();
    const close = native.close.bind(native);
    const record = {
      path: path.resolve(String(watchedPath)),
      native,
      listener,
      options,
      closes: 0,
      closed: closed.promise,
    };
    native.once("close", closed.resolve);
    native.close = () => {
      record.closes += 1;
      return close();
    };
    handles.push(record);
    return native;
  };
  fs.watchFile = function (watchedPath, ...args) {
    const watcher = originalWatchFile.call(this, watchedPath, ...args);
    if (ownNative(watchedPath)) {
      polling.add(String(watchedPath));
      if (!pollingHandles.some((record) => record.watcher === watcher)) {
        const stopped = deferred();
        const record = { watcher, stopped: stopped.promise, stops: 0 };
        watcher.once("stop", () => {
          record.stops += 1;
          stopped.resolve();
        });
        pollingHandles.push(record);
      }
    }
    return watcher;
  };
  fs.unwatchFile = function (watchedPath, ...args) {
    polling.delete(String(watchedPath));
    return originalUnwatchFile.call(this, watchedPath, ...args);
  };
  if (scenario.startsWith("delayed-eperm")) {
    // Exercise the Windows callback branch with real native handles on this host.
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
  }
  syncBuiltinESMExports();
  const { FSWatcher } = await import(pathToFileURL(entry).href);
  Object.defineProperty(process, "platform", originalPlatform);
  const namespace = {};
  function owner(options = {}) {
    const watcher = new FSWatcher({ ignoreInitial: true, atomic: false, ...options });
    const events = { changes: [], raw: [], errors: [] };
    watcher.on("raw", (...args) => events.raw.push(args));
    watcher.on("error", (error) => events.errors.push(error));
    owners.push(watcher);
    return {
      watcher,
      events,
      watch(file = root, listener = (value) => events.changes.push(value), closerPath = file) {
        return watcher._nodeFsHandler._watchWithNodeFs(file, listener, closerPath);
      },
    };
  }
  async function emitError(handle, error) {
    const listeners = handle.native.listeners("error");
    assert.equal(listeners.length, 1, "persistent native handle owns its error callback");
    await Promise.all(listeners.map((listener) => listener(error)));
  }
  const eio = Object.assign(new Error("controlled native watch failure"), { code: "EIO" });

  if (scenario === "sharing") {
    const defaults = [owner(), owner()];
    const family = [
      owner({ nativeWatchNamespace: namespace }),
      owner({ nativeWatchNamespace: namespace }),
    ];
    const independent = owner({ nativeWatchNamespace: {} });
    for (const item of [...defaults, ...family, independent]) item.watch();
    assert.equal(handles.length, 3);
    handles[1].listener("change", undefined);
    for (const item of family) {
      assert.equal(item.events.changes.length, 1);
      assert.equal(item.events.raw.length, 1);
      assert.deepEqual(item.events.errors, []);
    }
    for (const item of [...defaults, independent])
      assert.deepEqual(item.events, { changes: [], raw: [], errors: [] });
    await family[0].watcher.close();
    const replacement = owner({ nativeWatchNamespace: namespace });
    replacement.watch();
    assert.equal(handles.length, 3, "healthy same-family handoff keeps the native handle");
    await emitError(handles[1], eio);
    assert.deepEqual(family[0].events.errors, [], "retired subscriber receives no error");
    assert.deepEqual(family[1].events.errors, [eio]);
    assert.deepEqual(replacement.events.errors, [eio]);
    for (const item of [...defaults, independent]) assert.deepEqual(item.events.errors, []);
    await family[1].watcher.close();
    assert.equal(handles[1].closes, 0);
    await replacement.watcher.close();
    assert.equal(handles[1].closes, 1);
    const fresh = owner({ nativeWatchNamespace: namespace });
    fresh.watch();
    assert.equal(handles.length, 4, "final family close permits fresh native acquisition");
    assert.equal(handles[0].closes, 0, "independent default peer survives");
  } else if (scenario.startsWith("synthetic-child-nonpersistent")) {
    const selected = scenario.endsWith("-default") ? {} : { nativeWatchNamespace: namespace };
    const child = path.join(root, "child");
    await promises.writeFile(child, "fixture");
    const parent = owner({ ...selected, persistent: false });
    const dedicatedPeer = owner({ ...selected, persistent: false });
    const childOwner = owner(selected);
    const defaultChild = owner();
    const otherChild = owner({ nativeWatchNamespace: {} });
    parent.watch();
    dedicatedPeer.watch();
    childOwner.watch(child);
    defaultChild.watch(child);
    otherChild.watch(child);
    assert.equal(handles.length, scenario.endsWith("-default") ? 4 : 5);
    for (const handle of handles.slice(0, 2)) {
      assert.equal(handle.options.persistent, false);
      assert.equal(handle.native.listenerCount("error"), 0);
    }
    handles[0].listener("change", "child");
    assert.deepEqual(childOwner.events.changes, [child], "selected family receives child fallback");
    assert.deepEqual(defaultChild.events.changes, scenario.endsWith("-default") ? [child] : []);
    assert.deepEqual(otherChild.events.changes, []);
    assert.deepEqual(dedicatedPeer.events.changes, []);
    parent.watcher.on("raw", () => pending.push(parent.watcher.close()));
    handles[0].listener("change", "child");
    await Promise.all(pending);
    handles[0].listener("change", "child");
    assert.deepEqual(childOwner.events.changes, [child], "retired dedicated parent cannot forward");
    assert.deepEqual(defaultChild.events.changes, scenario.endsWith("-default") ? [child] : []);
    assert.deepEqual(otherChild.events.changes, []);
    assert.equal(handles[0].closes, 1);
    assert.equal(handles[1].closes, 0, "closing a dedicated parent preserves its peer");
  } else if (scenario === "synthetic-child") {
    const child = path.join(root, "child");
    await promises.writeFile(child, "fixture");
    const parent = owner({ nativeWatchNamespace: namespace });
    const childOwner = owner({ nativeWatchNamespace: namespace });
    const independent = owner();
    parent.watch();
    childOwner.watch(child);
    independent.watch(child);
    handles[0].listener("change", "child");
    assert.deepEqual(childOwner.events.changes, [child]);
    assert.deepEqual(independent.events.changes, []);
    parent.watcher.on("raw", () => {
      pending.push(parent.watcher.close());
    });
    handles[0].listener("change", "child");
    await Promise.all(pending);
    assert.equal(
      childOwner.events.changes.length,
      1,
      "retired root cannot synthesize a child event",
    );
  } else if (scenario === "reentrant-handoff") {
    const first = owner({ nativeWatchNamespace: namespace });
    const peer = owner({ nativeWatchNamespace: namespace });
    let replacement;
    first.watch(root, () => {
      pending.push(first.watcher.close());
      replacement = owner({ nativeWatchNamespace: namespace });
      replacement.watch();
    });
    peer.watch();
    handles[0].listener("change", undefined);
    await Promise.all(pending);
    assert.equal(handles.length, 1);
    assert.equal(peer.events.changes.length, 1);
    assert.equal(replacement.events.changes.length, 1);
    assert.equal(replacement.events.raw.length, 1);
  } else if (scenario.startsWith("retired-callbacks")) {
    const options = scenario.endsWith("-default") ? {} : { nativeWatchNamespace: namespace };
    const old = owner(options);
    old.watch();
    const stale = handles[0];
    await old.watcher.close();
    const fresh = owner(options);
    fresh.watch();
    stale.listener("change", undefined);
    await emitError(stale, eio);
    assert.deepEqual(fresh.events, { changes: [], raw: [], errors: [] });
    handles[1].listener("change", undefined);
    assert.equal(fresh.events.changes.length, 1);
    assert.equal(fresh.events.raw.length, 1);
  } else if (scenario.startsWith("delayed-eperm")) {
    const file = path.join(root, "file");
    await promises.writeFile(file, "fixture");
    const entered = deferred();
    const release = deferred();
    releases.push(release.resolve);
    promises.open = async (...args) => {
      const fd = await originalOpen(...args);
      entered.resolve();
      await release.promise;
      return fd;
    };
    syncBuiltinESMExports();
    const options = scenario.endsWith("-default") ? {} : { nativeWatchNamespace: namespace };
    const old = owner(options);
    old.watch(file);
    const error = emitError(
      handles[0],
      Object.assign(new Error("controlled EPERM"), { code: "EPERM" }),
    );
    pending.push(error);
    await entered.promise;
    await old.watcher.close();
    const fresh = owner(options);
    fresh.watch(file);
    release.resolve();
    await error;
    assert.deepEqual(fresh.events.errors, []);
    await emitError(handles[0], eio);
    assert.deepEqual(old.events.errors, []);
  } else if (scenario === "nonpersistent-polling") {
    const nonpersistent = [
      owner({ persistent: false, nativeWatchNamespace: namespace }),
      owner({ persistent: false, nativeWatchNamespace: namespace }),
    ];
    for (const item of nonpersistent) item.watch();
    assert.equal(handles.length, 2);
    assert.ok(
      handles.every(
        ({ options, native }) =>
          options.persistent === false && native.listenerCount("error") === 0,
      ),
    );
    const polled = [
      owner({ usePolling: true, nativeWatchNamespace: namespace }),
      owner({ usePolling: true, nativeWatchNamespace: {} }),
    ];
    for (const item of polled) item.watch();
    assert.equal(handles.length, 2);
    assert.equal(polling.size, 1);
    await polled[0].watcher.close();
    assert.equal(polling.size, 1);
    await polled[1].watcher.close();
    assert.equal(polling.size, 0);
  } else if (scenario === "polling-returned-disposer") {
    const first = owner({ usePolling: true });
    const dispose = first.watch();
    assert.equal(typeof dispose, "function");
    assert.equal(polling.size, 1);
    dispose();
    assert.equal(polling.size, 0);
    const replacement = owner({ usePolling: true, nativeWatchNamespace: namespace });
    replacement.watch();
    assert.equal(pollingHandles.length, 2);
    assert.equal(polling.size, 1);
    const [closed] = await Promise.allSettled([
      Promise.resolve().then(() => first.watcher.close()),
    ]);
    returnedPollingClose = {
      ownerClose: closed.status,
      replacementStillPolled: polling.has(root),
    };
    if (closed.status === "rejected") throw closed.reason;
    assert.equal(polling.size, 1, "retired disposer cannot stop its replacement");
    dispose();
    assert.equal(polling.size, 1, "repeated disposer cannot stop its replacement");
    await replacement.watcher.close();
    assert.equal(polling.size, 0);
  } else if (scenario.startsWith("directory-close-")) {
    const mode = scenario.slice("directory-close-".length);
    const options =
      mode === "default"
        ? {}
        : mode === "namespace"
          ? { nativeWatchNamespace: namespace }
          : mode === "polling"
            ? { usePolling: true }
            : { persistent: false };
    const { watcher, events } = owner(options);
    const handler = watcher._nodeFsHandler;
    const acquire = handler._watchWithNodeFs.bind(handler);
    const returned = deferred();
    const release = deferred();
    releases.push(release.resolve);
    const handleDirectory = handler._handleDir.bind(handler);
    handler._handleDir = async (...args) => {
      const closer = await handleDirectory(...args);
      returned.resolve();
      await release.promise;
      return closer;
    };
    const operation = handler._addToNodeFs(root, true, undefined, 0, "entry");
    pending.push(operation);
    await returned.promise;
    assert.deepEqual(events.errors, []);
    assert.equal(handles.length, mode === "polling" ? 0 : 1);
    assert.equal(polling.size, mode === "polling" ? 1 : 0);
    await watcher.close();
    assert.ok(handles.every((handle) => handle.closes === 1));
    assert.equal(polling.size, 0);
    release.resolve();
    await operation;
    // A closed owner cannot create a new registration, including direct rearm.
    assert.equal(
      acquire(root, () => {}),
      undefined,
    );
  } else if (scenario === "file-add-close") {
    const file = path.join(root, "file");
    await promises.writeFile(file, "fixture");
    const { watcher } = owner({ ignoreInitial: false });
    watcher.on("add", () => {
      pending.push(watcher.close());
    });
    await watcher._nodeFsHandler._addToNodeFs(file, false, undefined, 0);
    await Promise.all(pending);
    assert.equal(handles.length, 1);
    assert.equal(handles[0].closes, 1);
  } else if (scenario === "relative-unwatch") {
    await promises.writeFile(path.join(root, "file"), "fixture");
    process.chdir(root);
    const { watcher } = owner();
    await watcher._nodeFsHandler._addToNodeFs("file", true, undefined, 0);
    assert.equal(handles.length, 1);
    watcher.unwatch("file");
    assert.equal(handles[0].closes, 1, "relative unwatch retains its logical close key");
  } else if (scenario === "symlink-unwatch") {
    const target = path.join(root, "target");
    const link = path.join(root, "link");
    await promises.writeFile(target, "fixture");
    await promises.symlink(target, link);
    const { watcher } = owner({ followSymlinks: false });
    await watcher._nodeFsHandler._addToNodeFs(link, true, undefined, 0);
    assert.equal(handles.length, 1);
    assert.equal(handles[0].path, root, "a symlink physically watches its parent");
    watcher.unwatch(link);
    assert.equal(handles[0].closes, 1, "unwatch uses the original logical symlink key");
  } else {
    throw new Error(`unknown fixture scenario ${scenario}`);
  }
  passed = true;
} catch (error) {
  scenarioError = error;
  throw error;
} finally {
  for (const release of releases) release();
  const settled = await Promise.allSettled(pending);
  const closed = await Promise.allSettled(
    owners.map((watcher) => Promise.resolve().then(() => watcher.close())),
  );
  // Rescue only task-owned native handles so a failed assertion cannot leak the child.
  nativeRescues = handles.filter((handle) => !handle.closes).length;
  pollingRescues = polling.size;
  for (const handle of handles) if (!handle.closes) handle.native.close();
  await Promise.all(handles.map((handle) => handle.closed));
  for (const watchedPath of polling) originalUnwatchFile(watchedPath);
  await Promise.all(pollingHandles.map((handle) => handle.stopped));
  fs.watch = originalWatch;
  fs.watchFile = originalWatchFile;
  fs.unwatchFile = originalUnwatchFile;
  promises.open = originalOpen;
  Object.defineProperty(process, "platform", originalPlatform);
  process.chdir(originalCwd);
  syncBuiltinESMExports();
  const failures = [...settled, ...closed].filter((result) => result.status === "rejected");
  if (!passed) {
    console.log(
      JSON.stringify({
        scenario,
        passed,
        nativeHandles: handles.length,
        nativeCloseEventsJoined: true,
        nativeRescues,
        pollingRescues,
        pollingHandles: pollingHandles.length,
        pollingStopEventsJoined: pollingHandles.every(({ stops }) => stops === 1),
        returnedPollingClose,
        cleanupErrors: failures.map(({ reason }) => ({
          name: reason.name,
          message: reason.message,
        })),
      }),
    );
  }
  // Preserve the causal error after joining cleanup; report secondary close failures above.
  if (failures.length && !scenarioError)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "fixture owner cleanup failed",
    );
  if (passed) {
    assert.equal(nativeRescues, 0, "successful owner cleanup must not need native rescue");
    assert.equal(pollingRescues, 0, "successful owner cleanup must not need polling rescue");
    await promises.rm(root, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify({
    scenario,
    passed,
    nativeHandles: handles.length,
    nativeCloseEventsJoined: true,
    nativeRescues,
    pollingRescues,
    pollingHandles: pollingHandles.length,
    pollingStopEventsJoined: pollingHandles.every(({ stops }) => stops === 1),
    returnedPollingClose,
  }),
);
