// Materializes the pinned Chokidar closure while the package lifecycle owns the source.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const STAGE = ".artifacts/package-chokidar-bundle";

async function identity(file) {
  try {
    const stat = await fs.lstat(file, { bigint: true });
    return {
      device: String(stat.dev),
      inode: String(stat.ino),
      kind: stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "other",
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function files(root, relative = "") {
  const result = {};
  for (const entry of (
    await fs.readdir(path.join(root, relative), { withFileTypes: true })
  ).toSorted((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, await files(root, name));
    } else if (entry.isFile()) {
      result[name] = createHash("sha256")
        .update(await fs.readFile(path.join(root, name)))
        .digest("hex");
    } else {
      throw new Error("Chokidar package staging requires regular files and directories");
    }
  }
  return result;
}

async function copyPackage(source, destination) {
  await fs.cp(source, destination, {
    recursive: true,
    filter: async (file) => {
      if (path.relative(source, file).split(path.sep)[0] === "node_modules") {
        return false;
      }
      const stat = await fs.lstat(file);
      if (!stat.isFile() && !stat.isDirectory()) {
        throw new Error("Chokidar package staging refuses linked package contents");
      }
      return true;
    },
  });
}

/** Restore only this lifecycle's module slot; preserve receipts on unknown changes. */
export async function restorePackageChokidarBundle(cwd = process.cwd()) {
  const stage = path.join(cwd, STAGE);
  if (!(await identity(stage))) {
    return false;
  }
  const receipt = JSON.parse(await fs.readFile(path.join(stage, "receipt.json"), "utf8"));
  const target = path.join(cwd, "node_modules/chokidar");
  const backup = path.join(stage, "original");
  const prepared = path.join(stage, "prepared");
  const remainingPrepared = await identity(prepared);
  if (
    remainingPrepared &&
    receipt.prepared &&
    (!isDeepStrictEqual(remainingPrepared, receipt.prepared) ||
      !isDeepStrictEqual(await files(prepared), receipt.files))
  ) {
    throw new Error("Chokidar prepared bundle changed; retaining package recovery state");
  }
  const original = await identity(backup);
  if (original) {
    if (!isDeepStrictEqual(original, receipt.original)) {
      throw new Error("Chokidar package backup changed; retaining package recovery state");
    }
    if (await identity(target)) {
      if (
        !isDeepStrictEqual(await identity(target), receipt.prepared) ||
        !isDeepStrictEqual(await files(target), receipt.files) ||
        remainingPrepared
      ) {
        throw new Error("Chokidar staged bundle changed; retaining package recovery state");
      }
      await fs.rename(target, prepared);
    }
    await fs.rename(backup, target);
  } else if (!isDeepStrictEqual(await identity(target), receipt.original)) {
    throw new Error("Chokidar original module slot changed; retaining package recovery state");
  }
  await fs.rm(stage, { recursive: true });
  return true;
}

/** Called after the docs-map lifecycle lock, before either npm or pnpm packs. */
export async function preparePackageChokidarBundle(cwdInput, onStageAcquired) {
  const cwd = cwdInput === undefined ? process.cwd() : cwdInput;
  const manifest = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"));
  const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies;
  if (!Array.isArray(bundled) || !bundled.includes("chokidar")) {
    return false;
  }
  const target = path.join(cwd, "node_modules/chokidar");
  const source = await fs.realpath(target);
  const chokidar = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
  const readdirpRoot = path.dirname(
    createRequire(path.join(source, "package.json")).resolve("readdirp"),
  );
  const readdirp = JSON.parse(await fs.readFile(path.join(readdirpRoot, "package.json"), "utf8"));
  // This is the pinned two-package delivery contract, not a second dependency resolver.
  if (
    manifest.dependencies?.chokidar !== "5.0.0" ||
    chokidar.name !== "chokidar" ||
    chokidar.version !== "5.0.0" ||
    !isDeepStrictEqual(chokidar.dependencies, { readdirp: "^5.0.0" }) ||
    Object.keys(chokidar.optionalDependencies ?? {}).length ||
    readdirp.name !== "readdirp" ||
    !/^5\.\d+\.\d+$/u.test(readdirp.version) ||
    Object.keys(readdirp.dependencies ?? {}).length ||
    Object.keys(readdirp.optionalDependencies ?? {}).length
  ) {
    throw new Error("Chokidar bundled dependency closure no longer matches its pinned contract");
  }
  const stage = path.join(cwd, STAGE);
  await fs.mkdir(path.dirname(stage), { recursive: true });
  // Exclusive ownership also protects direct fixture calls outside the outer pack lock.
  try {
    await fs.mkdir(stage);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw Object.assign(new Error("Chokidar package bundle staging is already active"), {
        code: "PACKAGE_CHOKIDAR_BUNDLE_ACTIVE",
      });
    }
    throw error;
  }
  let originalMoved = false;
  try {
    onStageAcquired?.();
    const receiptPath = path.join(stage, "receipt.json");
    const receipt = { original: await identity(target), prepared: null, files: null };
    await fs.writeFile(receiptPath, JSON.stringify(receipt), { flag: "wx" });
    const prepared = path.join(stage, "prepared");
    await copyPackage(source, prepared);
    await copyPackage(readdirpRoot, path.join(prepared, "node_modules/readdirp"));
    receipt.prepared = await identity(prepared);
    receipt.files = await files(prepared);
    await fs.writeFile(receiptPath, JSON.stringify(receipt));
    // Never modify the installed package behind a pnpm link. Retain its original
    // slot intact and restore it after packing, including interrupted-pack recovery.
    await fs.rename(target, path.join(stage, "original"));
    originalMoved = true;
    await fs.rename(prepared, target);
    return true;
  } catch (error) {
    try {
      // Before the slot moves, only this invocation's scratch changed. A failed
      // receipt write cannot be parsed by postpack, so roll it back directly.
      if (!originalMoved) {
        await fs.rm(stage, { recursive: true });
      } else {
        await restorePackageChokidarBundle(cwd);
      }
    } catch (restoreError) {
      throw packageStagingRestoreError(error, restoreError);
    }
    throw error;
  }
}

function packageStagingRestoreError(error, restoreError) {
  return new AggregateError(
    [error, restoreError],
    "Chokidar package staging could not restore its source",
    { cause: error },
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "prepare") {
      await preparePackageChokidarBundle();
    } else if (process.argv[2] === "restore") {
      await restorePackageChokidarBundle();
    } else {
      throw new Error("Usage: node scripts/package-chokidar-bundle.mjs <prepare|restore>");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[package-chokidar-bundle] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
