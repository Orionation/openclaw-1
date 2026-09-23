import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { coerceErrorMessage } from "./error-format.mts";
import {
  collectPatchedMcpArtifactErrors,
  PATCHED_MCP_CLI,
  PATCHED_MCP_NAME,
  PATCHED_MCP_VERSION,
} from "./package-bundled-mcp.mts";
import { collectPackageDistImportErrors } from "./package-dist-imports.mjs";
import { isRecord } from "./record-shared.mjs";

type BundledPackage = {
  entries: ReadonlySet<string>;
  files: string[];
  name: string;
  packageRoot: string;
  readText: (relativePath: string) => string;
};
const PATCHED_CHOKIDAR_VERSION = "5.0.0";
// npm does not apply pnpm patches. The package must carry these same runtime/types.
const PATCHED_CHOKIDAR_HASHES = new Map([
  ["LICENSE", "bdfd5e0edb6089e6586c8f15e6a86fab83ffbeeda3b3b7b33734ccb8c5906965"],
  ["index.js", "4d1669ff207e874eb6185b8a4f04c1e694120b9eaf6723ddea1be7ce5583b164"],
  ["handler.js", "d1d80133c592fcd65bfb1dc388f82d24686183614f09317f7e1638166be03a44"],
  ["index.d.ts", "105e04c02915b6f670233d32f00dec3c0d1641d6830a0bb54b96253c977800c5"],
  ["handler.d.ts", "33bafd9ba9f80f375177184a07386bd7d3026de13d3b3ae60cc20bedf6f00fe2"],
]);
// Strict Docker artifacts bundle this private runtime rather than resolving it
// from npm. Keep the concrete load-bearing entries explicit instead of
// reimplementing Node's conditional package-exports resolver here.
const REQUIRED_BUNDLED_WORKSPACE_RUNTIME_ENTRIES = new Map([
  [
    "@openclaw/ai",
    [
      { specifier: "@openclaw/ai", entry: "dist/index.mjs" },
      { specifier: "@openclaw/ai/providers", entry: "dist/providers.mjs" },
      {
        specifier: "@openclaw/ai/transports",
        entry: "dist/transports.mjs",
        whenExported: "./transports",
      },
      {
        specifier: "@openclaw/ai/internal/openai-completions-compat",
        entry: "dist/internal/openai-completions-compat.mjs",
        whenExported: "./internal/openai-completions-compat",
      },
      {
        specifier: "@openclaw/ai/internal/openai-responses-payload-policy",
        entry: "dist/internal/openai-responses-payload-policy.mjs",
        whenExported: "./internal/openai-responses-payload-policy",
      },
      {
        specifier: "@openclaw/ai/internal/runtime",
        entry: "dist/internal/runtime.mjs",
      },
      {
        specifier: "@openclaw/ai/internal/tool-schema",
        entry: "dist/internal/tool-schema.mjs",
        whenExported: "./internal/tool-schema",
      },
    ],
  ],
]);

function listBundleDependencies(packageJson: unknown): string[] {
  if (!isRecord(packageJson)) {
    return [];
  }
  if (packageJson.bundleDependencies === true || packageJson.bundledDependencies === true) {
    return Object.keys(isRecord(packageJson.dependencies) ? packageJson.dependencies : {});
  }
  const bundleDependencies = Array.isArray(packageJson.bundleDependencies)
    ? packageJson.bundleDependencies
    : packageJson.bundledDependencies;
  return Array.isArray(bundleDependencies)
    ? bundleDependencies.filter((name): name is string => typeof name === "string")
    : [];
}

function resolveBundledPackageSpecifiers(
  packageRoot: string,
  specifiers: string[],
): Record<string, string> | null {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const resolutions = {};
for (const specifier of JSON.parse(process.argv[1])) {
  try {
    resolutions[specifier] = import.meta.resolve(specifier);
  } catch {
    resolutions[specifier] = "";
  }
}
process.stdout.write(JSON.stringify(resolutions));`,
      JSON.stringify(specifiers),
    ],
    { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    return null;
  }
  try {
    return JSON.parse(result.stdout) as Record<string, string>;
  } catch {
    return null;
  }
}

function collectBundledPackageRuntimeErrors(
  { name, entries, files, packageRoot, readText }: BundledPackage,
  bundledPackageJson: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const packagePrefix = `node_modules/${name}/`;
  const packageExports = isRecord(bundledPackageJson.exports) ? bundledPackageJson.exports : {};
  // Trusted current-main harnesses validate frozen release targets. Require
  // post-cut runtime subpaths only when the candidate manifest owns them.
  const runtimeEntries = (REQUIRED_BUNDLED_WORKSPACE_RUNTIME_ENTRIES.get(name) ?? []).filter(
    ({ whenExported }) => !whenExported || Object.hasOwn(packageExports, whenExported),
  );
  const resolutions = resolveBundledPackageSpecifiers(
    packageRoot,
    runtimeEntries.map(({ specifier }) => specifier),
  );
  if (!resolutions) {
    errors.push(`bundled ${name} runtime specifier resolution failed`);
  }
  for (const { entry, specifier } of runtimeEntries) {
    if (!entries.has(`${packagePrefix}${entry}`)) {
      errors.push(`bundled ${name} is missing required runtime entry ${entry}`);
    }
    const resolvedUrl = resolutions?.[specifier] ?? "";
    if (!resolvedUrl) {
      errors.push(`bundled ${name} runtime specifier ${specifier} is not resolvable`);
      continue;
    }
    const expectedUrl = pathToFileURL(path.join(packageRoot, packagePrefix, entry)).href;
    if (resolvedUrl !== expectedUrl) {
      errors.push(
        `bundled ${name} runtime specifier ${specifier} resolves to ${resolvedUrl} instead of ${expectedUrl}`,
      );
    }
  }
  const bundledFiles = files
    .filter((file) => file.startsWith(packagePrefix))
    .map((file) => file.slice(packagePrefix.length));
  errors.push(
    ...collectPackageDistImportErrors({
      files: bundledFiles,
      readText: (file: string) => readText(`${packagePrefix}${file}`),
    }).map((error) => `bundled ${name} ${error}`),
  );
  return errors;
}

function collectPatchedMcpErrors(
  { entries, packageRoot, readText }: BundledPackage,
  manifest: Record<string, unknown>,
): string[] {
  const prefix = `node_modules/${PATCHED_MCP_NAME}/`;
  const errors = collectPatchedMcpArtifactErrors({
    manifest,
    files: new Set(
      [...entries]
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => entry.slice(prefix.length)),
    ),
    sha256: (file) =>
      createHash("sha256")
        .update(readText(`${prefix}${file}`))
        .digest("hex"),
  });
  const specifier = `${PATCHED_MCP_NAME}/${PATCHED_MCP_CLI}`;
  const resolved = resolveBundledPackageSpecifiers(packageRoot, [specifier]);
  if (
    resolved?.[specifier] !== pathToFileURL(path.join(packageRoot, prefix, PATCHED_MCP_CLI)).href
  ) {
    errors.push(`bundled ${PATCHED_MCP_NAME} CLI does not resolve inside its bundled package`);
  }
  return errors;
}

function collectPatchedChokidarErrors(
  { entries, packageRoot, readText }: BundledPackage,
  manifest: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const prefix = "node_modules/chokidar/";
  if (manifest.version !== PATCHED_CHOKIDAR_VERSION || manifest.type !== "module") {
    errors.push(`bundled chokidar must be ESM version ${PATCHED_CHOKIDAR_VERSION}`);
  }
  for (const [file, hash] of PATCHED_CHOKIDAR_HASHES) {
    if (!entries.has(prefix + file)) {
      errors.push(`bundled chokidar is missing required runtime entry ${file}`);
    } else if (
      createHash("sha256")
        .update(readText(prefix + file))
        .digest("hex") !== hash
    ) {
      errors.push(`bundled chokidar has unpatched or changed runtime entry ${file}`);
    }
  }
  const resolutions = resolveBundledPackageSpecifiers(packageRoot, [
    "chokidar",
    "chokidar/handler.js",
  ]);
  for (const [specifier, file] of [
    ["chokidar", "index.js"],
    ["chokidar/handler.js", "handler.js"],
  ] as const) {
    if (resolutions?.[specifier] !== pathToFileURL(path.join(packageRoot, prefix, file)).href) {
      errors.push(
        `bundled chokidar specifier ${specifier} does not resolve inside its bundled package`,
      );
    }
  }
  // Resolve from the importer, allowing npm's hoisted or pnpm's nested bundle layout.
  const readdirp = resolveBundledPackageSpecifiers(path.join(packageRoot, prefix), ["readdirp"]);
  const entry = readdirp?.readdirp;
  const relative = entry?.startsWith("file:")
    ? path.relative(packageRoot, fileURLToPath(entry)).replaceAll("\\", "/")
    : "";
  if (!relative.startsWith("node_modules/") || !entries.has(relative)) {
    errors.push("bundled chokidar dependency readdirp must resolve inside the package artifact");
    return errors;
  }
  const dependencyRoot = path.posix.dirname(relative);
  for (const file of ["package.json", "index.d.ts", "LICENSE"]) {
    if (!entries.has(`${dependencyRoot}/${file}`)) {
      errors.push(`bundled chokidar dependency readdirp is missing ${file}`);
    }
  }
  const dependencyManifest = `${dependencyRoot}/package.json`;
  if (entries.has(dependencyManifest)) {
    try {
      const dependency: unknown = JSON.parse(readText(dependencyManifest));
      if (!isRecord(dependency) || dependency.name !== "readdirp" || dependency.type !== "module") {
        errors.push("bundled chokidar dependency must be the readdirp ESM package");
      }
    } catch {
      errors.push("bundled chokidar dependency readdirp has an unreadable package.json");
    }
  }
  return errors;
}

export function collectBundledDependencyErrors({
  packageJson,
  requireBundledWorkspaceDeps = false,
  ...runtime
}: Omit<BundledPackage, "name"> & {
  packageJson: unknown;
  requireBundledWorkspaceDeps?: boolean;
}): string[] {
  if (!isRecord(packageJson)) {
    return [];
  }
  const errors: string[] = [];
  const dependencies = isRecord(packageJson.dependencies) ? packageJson.dependencies : {};
  const bundledDependencies = new Set(listBundleDependencies(packageJson));
  const required = new Map<string, string>([
    ["chokidar", "its patched native watcher ownership must reach npm consumers"],
    [PATCHED_MCP_NAME, "its patched runtime must not be replaced by the registry package"],
  ]);
  if (requireBundledWorkspaceDeps) {
    required.set("@openclaw/ai", "it is private to the OpenClaw workspace");
  }
  const names = new Set(bundledDependencies);
  for (const [name, reason] of required) {
    if (typeof dependencies[name] !== "string") {
      continue;
    }
    names.add(name);
    if (!bundledDependencies.has(name)) {
      errors.push(
        `package.json dependencies.${name} must be listed in bundleDependencies because ${reason}`,
      );
    }
  }
  if (
    typeof dependencies[PATCHED_MCP_NAME] === "string" &&
    dependencies[PATCHED_MCP_NAME] !== PATCHED_MCP_VERSION
  ) {
    errors.push(
      `package.json dependencies.${PATCHED_MCP_NAME} must be pinned to ${PATCHED_MCP_VERSION}`,
    );
  }
  if (
    typeof dependencies.chokidar === "string" &&
    dependencies.chokidar !== PATCHED_CHOKIDAR_VERSION
  ) {
    errors.push(`package.json dependencies.chokidar must be pinned to ${PATCHED_CHOKIDAR_VERSION}`);
  }
  for (const name of names) {
    const manifestPath = `node_modules/${name}/package.json`;
    if (!runtime.entries.has(manifestPath)) {
      errors.push(`package.json dependencies.${name} must be bundled in node_modules/${name}`);
      continue;
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(runtime.readText(manifestPath));
    } catch (error) {
      errors.push(`unreadable bundled ${name} package.json: ${coerceErrorMessage(error)}`);
      continue;
    }
    if (!isRecord(manifest) || manifest.name !== name) {
      errors.push(`bundled ${name} package.json must name ${name}`);
      continue;
    }
    const bundled = { ...runtime, name };
    if (name === PATCHED_MCP_NAME) {
      errors.push(...collectPatchedMcpErrors(bundled, manifest));
    } else if (name === "chokidar") {
      errors.push(...collectPatchedChokidarErrors(bundled, manifest));
    } else if (REQUIRED_BUNDLED_WORKSPACE_RUNTIME_ENTRIES.has(name)) {
      errors.push(...collectBundledPackageRuntimeErrors(bundled, manifest));
    }
  }
  return errors;
}
