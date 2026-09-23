import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNpmRunner } from "../../scripts/npm-runner.mts";
import {
  preparePackageChokidarBundle,
  restorePackageChokidarBundle,
} from "../../scripts/package-chokidar-bundle.mjs";
import { resolvePnpmRunner } from "../../scripts/pnpm-runner.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { listFilesRecursively, withTarball } from "./package-tarball-fixture.js";

const require = createRequire(import.meta.url);
const source = dirname(require.resolve("chokidar"));
const readdirp = dirname(createRequire(join(source, "package.json")).resolve("readdirp"));
const CHECK_SCRIPT = resolve("scripts/check-openclaw-package-tarball.mts");
const CONTRACT_FIXTURE = resolve("test/scripts/chokidar-native-namespace.fixture.mjs");
const BUNDLE_SCRIPT = resolve("scripts/package-chokidar-bundle.mjs");
const POSTPACK_SCRIPT = resolve("scripts/openclaw-postpack.mjs");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const packageJson = {
  files: ["dist"],
  dependencies: { chokidar: "5.0.0" },
  bundleDependencies: ["chokidar"],
};
const runtime = {
  "dist/index.js": "export {};\n",
  "dist/core.mjs": 'export { default } from "chokidar";\n',
  "dist/extensions/example/index.mjs": 'export { default } from "chokidar";\n',
};

function bytes(root: string) {
  return Object.fromEntries(
    listFilesRecursively(root)
      .filter((file) => !file.replaceAll("\\", "/").startsWith("node_modules/"))
      .toSorted()
      .map((file) => [
        file,
        createHash("sha256")
          .update(readFileSync(join(root, file)))
          .digest("hex"),
      ]),
  );
}

function check(tarball: string) {
  return spawnSync(process.execPath, [CHECK_SCRIPT, tarball], {
    encoding: "utf8",
    timeout: 20_000,
  });
}

function runLifecycle(packageRoot: string, script: string, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
}

function createBundleFixture() {
  const root = tempDirs.make("openclaw-chokidar-staging-");
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), JSON.stringify(packageJson));
  const target = join(root, "node_modules/chokidar");
  symlinkSync(source, target, "junction");
  return { root, target, stage: join(root, ".artifacts/package-chokidar-bundle") };
}

function installSourceBundle(packageRoot: string) {
  const fixtureRoot = dirname(packageRoot);
  const overrides: Record<string, string> = {};
  for (const root of [source, readdirp]) {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    const npm = resolveNpmRunner({
      npmArgs: [
        "pack",
        "--offline",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        fixtureRoot,
      ],
    });
    const result = spawnSync(npm.command, npm.args, {
      cwd: root,
      encoding: "utf8",
      env: npm.env,
      shell: npm.shell,
      windowsVerbatimArguments: npm.windowsVerbatimArguments,
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    overrides[manifest.name] =
      `file:${join(fixtureRoot, `${manifest.name}-${manifest.version}.tgz`)}`;
  }
  writeFileSync(
    join(packageRoot, "pnpm-workspace.yaml"),
    JSON.stringify({ packages: ["."], autoInstallPeers: false, overrides }),
  );
  const pnpm = resolvePnpmRunner({
    cwd: packageRoot,
    pnpmArgs: [
      "install",
      "--offline",
      "--no-frozen-lockfile",
      "--ignore-scripts",
      "--package-import-method=copy",
      "--store-dir",
      join(fixtureRoot, "store"),
    ],
  });
  const result = spawnSync(pnpm.command, pnpm.args, {
    cwd: packageRoot,
    encoding: "utf8",
    shell: pnpm.shell,
    windowsVerbatimArguments: pnpm.windowsVerbatimArguments,
    timeout: 30_000,
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

describe("bundled Chokidar native ownership", () => {
  it.each(["npm", "pnpm"] as const)(
    "preserves patched bytes, transitive closure and namespace behavior through %s pack",
    (pack) => {
      const sourceBytes = bytes(source);
      const readdirpBytes = bytes(readdirp);
      let originalLink = "";
      withTarball(
        Object.keys(runtime),
        runtime,
        (tarball, root, packageRoot) => {
          // npm may omit postpack on failure. The same explicit recovery entrypoint
          // must restore the original install without following its pnpm link.
          const restored = runLifecycle(packageRoot, POSTPACK_SCRIPT);
          expect(restored.status, restored.stderr).toBe(0);
          expect(readlinkSync(join(packageRoot, "node_modules/chokidar"))).toBe(originalLink);
          expect(bytes(join(packageRoot, "node_modules/chokidar"))).toEqual(sourceBytes);
          expect(bytes(readdirp)).toEqual(readdirpBytes);
          expect(existsSync(join(packageRoot, ".artifacts/package-chokidar-bundle"))).toBe(false);
          const checked = check(tarball);
          expect(checked.status, checked.stderr).toBe(0);
          const consumer = join(root, "consumer");
          mkdirSync(consumer);
          writeFileSync(
            join(consumer, "package.json"),
            '{"name":"watcher-bundle-consumer","private":true}',
          );
          const npm = resolveNpmRunner({
            npmArgs: [
              "install",
              "--offline",
              "--ignore-scripts",
              "--omit=dev",
              "--omit=peer",
              "--legacy-peer-deps",
              "--no-audit",
              "--no-fund",
              "--cache",
              join(consumer, "cache"),
              tarball,
            ],
          });
          const installed = spawnSync(npm.command, npm.args, {
            cwd: consumer,
            encoding: "utf8",
            env: npm.env,
            shell: npm.shell,
            windowsVerbatimArguments: npm.windowsVerbatimArguments,
            timeout: 30_000,
          });
          expect(installed.status, installed.stderr).toBe(0);
          const installedPackage = join(consumer, "node_modules/openclaw");
          const consumerRequire = createRequire(join(installedPackage, "package.json"));
          const installedEntry = consumerRequire.resolve("chokidar");
          const installedRoot = dirname(installedEntry);
          expect(bytes(installedRoot)).toEqual(sourceBytes);
          const installedReaddirp = dirname(
            createRequire(join(installedRoot, "package.json")).resolve("readdirp"),
          );
          expect(bytes(installedReaddirp)).toEqual(readdirpBytes);
          const identity = spawnSync(
            process.execPath,
            [
              "--input-type=module",
              "--eval",
              `
        import assert from "node:assert/strict";
        import core from "./dist/core.mjs";
        import plugin from "./dist/extensions/example/index.mjs";
        assert.equal(core, plugin);
      `,
            ],
            { cwd: installedPackage, encoding: "utf8", timeout: 10_000 },
          );
          expect(identity.status, identity.stderr).toBe(0);
          for (const scenario of ["sharing", "retired-callbacks", "directory-close-namespace"]) {
            const contract = spawnSync(
              process.execPath,
              [CONTRACT_FIXTURE, installedEntry, scenario],
              { cwd: consumer, encoding: "utf8", timeout: 10_000 },
            );
            expect(contract.status, contract.stderr).toBe(0);
            expect(JSON.parse(contract.stdout)).toMatchObject({
              passed: true,
              nativeCloseEventsJoined: true,
            });
          }
        },
        undefined,
        {
          packageJson,
          pack,
          beforePack(packageRoot) {
            installSourceBundle(packageRoot);
            const target = join(packageRoot, "node_modules/chokidar");
            originalLink = readlinkSync(target);
            const prepared = runLifecycle(packageRoot, BUNDLE_SCRIPT, ["prepare"]);
            expect(prepared.status, prepared.stderr).toBe(0);
            expect(lstatSync(target).isSymbolicLink()).toBe(false);
            expect(bytes(target)).toEqual(sourceBytes);
            expect(bytes(join(target, "node_modules/readdirp"))).toEqual(readdirpBytes);
          },
        },
      );
    },
    60_000,
  );

  it("rejects a second staging owner without touching its receipt or original install", async () => {
    const { root, target, stage } = createBundleFixture();
    const originalLink = readlinkSync(target);
    await preparePackageChokidarBundle(root);
    const receipt = readFileSync(join(stage, "receipt.json"), "utf8");
    await expect(preparePackageChokidarBundle(root)).rejects.toMatchObject({
      code: "PACKAGE_CHOKIDAR_BUNDLE_ACTIVE",
    });
    expect(readFileSync(join(stage, "receipt.json"), "utf8")).toBe(receipt);
    expect(readlinkSync(join(stage, "original"))).toBe(originalLink);
    await restorePackageChokidarBundle(root);
    expect(readlinkSync(target)).toBe(originalLink);
    expect(existsSync(stage)).toBe(false);
  });

  it.each(["write", "partial-write"])(
    "releases its unmoved stage after receipt initialization fails at %s",
    async (failure) => {
      const { root, target, stage } = createBundleFixture();
      const originalLink = readlinkSync(target);
      const injected = Object.assign(new Error("injected receipt initialization failure"), {
        code: "EIO",
      });
      const acquired = vi.fn();
      const originalWrite = fs.writeFile;
      const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
        if (String(file) === join(stage, "receipt.json")) {
          if (failure === "partial-write") await originalWrite(file, "{", options);
          throw injected;
        }
        return originalWrite(file, data, options);
      });
      try {
        await expect(preparePackageChokidarBundle(root, acquired)).rejects.toBe(injected);
        expect(acquired).toHaveBeenCalledTimes(1);
        expect(readlinkSync(target)).toBe(originalLink);
        expect(existsSync(stage)).toBe(false);
      } finally {
        writeSpy.mockRestore();
      }
      // A later legitimate pack can acquire immediately; no manual receipt repair.
      await preparePackageChokidarBundle(root);
      await restorePackageChokidarBundle(root);
      expect(readlinkSync(target)).toBe(originalLink);
    },
  );

  it("retains an altered staged bundle for explicit postpack recovery", async () => {
    const { root, target, stage } = createBundleFixture();
    const originalLink = readlinkSync(target);
    await preparePackageChokidarBundle(root);
    const receipt = readFileSync(join(stage, "receipt.json"), "utf8");
    const runtimePath = join(target, "handler.js");
    const runtimeBytes = readFileSync(runtimePath);
    writeFileSync(runtimePath, "unexpected pack-time mutation\n");
    const rejected = runLifecycle(root, POSTPACK_SCRIPT);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("Chokidar staged bundle changed");
    expect(readFileSync(join(stage, "receipt.json"), "utf8")).toBe(receipt);
    expect(readlinkSync(join(stage, "original"))).toBe(originalLink);
    expect(readFileSync(runtimePath, "utf8")).toBe("unexpected pack-time mutation\n");
    writeFileSync(runtimePath, runtimeBytes);
    const restored = runLifecycle(root, POSTPACK_SCRIPT);
    expect(restored.status, restored.stderr).toBe(0);
    expect(readlinkSync(target)).toBe(originalLink);
    expect(existsSync(stage)).toBe(false);
  });

  it("refuses a replacement backup even when it links to the same dependency", async () => {
    const { root, target, stage } = createBundleFixture();
    await preparePackageChokidarBundle(root);
    const backup = join(stage, "original");
    const held = join(stage, "held-original");
    renameSync(backup, held);
    symlinkSync(source, backup, "junction");
    await expect(restorePackageChokidarBundle(root)).rejects.toThrow(
      "Chokidar package backup changed",
    );
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(existsSync(join(stage, "receipt.json"))).toBe(true);
    rmSync(backup);
    renameSync(held, backup);
    await restorePackageChokidarBundle(root);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(existsSync(stage)).toBe(false);
  });

  it.each([
    {
      name: "missing declaration",
      manifest: { dependencies: packageJson.dependencies },
      error: "must be listed in bundleDependencies",
    },
    {
      name: "missing bundle",
      manifest: packageJson,
      error: "must be bundled in node_modules/chokidar",
    },
    {
      name: "unpinned version",
      manifest: { ...packageJson, dependencies: { chokidar: "^5.0.0" } },
      error: "must be pinned to 5.0.0",
    },
  ])("rejects $name", ({ manifest, error }) => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": runtime["dist/index.js"] },
      (tarball) => {
        const result = check(tarball);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(error);
      },
      undefined,
      { packageJson: manifest },
    );
  });

  it.each([
    {
      target: "handler.js",
      action: "modify",
      error: "unpatched or changed runtime entry handler.js",
    },
    {
      target: "index.d.ts",
      action: "modify",
      error: "unpatched or changed runtime entry index.d.ts",
    },
    {
      target: "handler.d.ts",
      action: "remove",
      error: "missing required runtime entry handler.d.ts",
    },
    { target: "LICENSE", action: "remove", error: "missing required runtime entry LICENSE" },
    { target: "LICENSE", action: "modify", error: "unpatched or changed runtime entry LICENSE" },
    {
      target: "readdirp",
      action: "remove",
      error: "readdirp must resolve inside the package artifact",
    },
  ])("rejects $action of $target", ({ target, action, error }) => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": runtime["dist/index.js"] },
      (tarball) => {
        const result = check(tarball);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(error);
      },
      undefined,
      {
        packageJson,
        beforePack(root) {
          const bundle = join(root, "node_modules/chokidar");
          cpSync(source, bundle, {
            recursive: true,
            dereference: true,
            filter: (file) => !file.startsWith(join(source, "node_modules")),
          });
          cpSync(readdirp, join(root, "node_modules/readdirp"), {
            recursive: true,
            dereference: true,
          });
          const file =
            target === "readdirp" ? join(root, "node_modules/readdirp") : join(bundle, target);
          if (action === "remove") rmSync(file, { recursive: true });
          else writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from("\n")]));
        },
      },
    );
  });
});
