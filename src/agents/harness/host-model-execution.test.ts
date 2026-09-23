import { expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import { getRegisteredAgentHarness, registerAgentHarness } from "./registry.js";
import { runAgentHarnessAttempt } from "./selection.js";
import { createHarnessAttemptParams } from "./selection.test-support.js";

it("rejects restricted native inference before invoking a harness without exact model-policy support", async () => {
  const cfg = { agents: { defaults: { model: "fixture/a" } } };
  const source = createAdmittedRunOperatorAuthority({
    profileId: "native-unaware-fixture",
    scopes: ["operator.write"],
    assertCurrent: () => {},
    modelPolicy: prepareOperatorModelPolicy({ cfg, policy: {}, manifestPlugins: [] }),
  });
  const admission = prepareSystemAgentRunAdmission(
    cfg,
    "native-unaware",
    "main",
    "test",
    undefined,
    source,
  );
  const runAttempt = vi.fn(async () => {
    throw new Error("unsupported harness must not execute");
  });
  const registrySnapshot = captureActivePluginRegistrySnapshot();
  try {
    setActivePluginRegistry(createEmptyPluginRegistry());
    registerAgentHarness(
      {
        id: "fixture",
        label: "Fixture",
        supports: () => ({ supported: true }),
        runAttempt,
      },
      { ownerPluginId: "fixture" },
    );
    const registration = getRegisteredAgentHarness("fixture");
    if (!registration) {
      throw new Error("missing registered fixture harness");
    }
    await expect(
      runAgentHarnessAttempt(
        createHarnessAttemptParams(await admission.admit("plugin-harness", "fixture"), cfg),
        {
          auth: "native",
          modelRef: { provider: "fixture", model: "a" },
          assertCurrent: async () => {},
          harness: registration.harness,
        },
      ),
    ).rejects.toThrow("cannot enforce your operator role's model policy");
    expect(runAttempt).not.toHaveBeenCalled();
  } finally {
    admission.close();
    restoreActivePluginRegistrySnapshot(registrySnapshot);
  }
});

it.each([
  ["foreground", false],
  ["foreground", true],
  ["retained", false],
  ["retained", true],
] as const)(
  "retains native model bindings across foreground closure (%s owner, initial policy: %s)",
  async (owner, initialPolicy) => {
    const cfg = {
      agents: { defaults: { model: { primary: "fixture/a", fallbacks: ["fixture/b"] } } },
    };
    let policy = initialPolicy
      ? prepareOperatorModelPolicy({ cfg, policy: {}, manifestPlugins: [] })
      : undefined;
    const listeners = new Set<() => void>();
    const sourceAbort = new AbortController();
    let retainedSources = 0;
    const source = createAdmittedRunOperatorAuthority({
      profileId: "native-model-fixture",
      scopes: ["operator.write"],
      signal: sourceAbort.signal,
      assertCurrent: () => {},
      retain: () => {
        retainedSources += 1;
        return () => {
          retainedSources -= 1;
        };
      },
      get modelPolicy() {
        return policy;
      },
      onModelPolicyChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const admission = prepareSystemAgentRunAdmission(
      cfg,
      "native-model-execution",
      "main",
      "test",
      undefined,
      source,
    );
    const host = createAgentHarnessHostCapabilities({
      attempt: {
        admittedRunContext: await admission.admit("plugin-harness", "fixture"),
        runId: "native-model-execution",
        agentId: "main",
      },
      pluginId: "fixture",
    });
    const bindings: Array<
      NonNullable<ReturnType<NonNullable<typeof host.capabilities.bindModelExecution>>>
    > = [];
    const retained = owner === "retained" ? host.capabilities.retainSourceAuthority?.() : undefined;
    const siblingSource =
      owner === "retained" ? host.capabilities.retainSourceAuthority?.() : undefined;
    try {
      const bindFromHost = host.capabilities.bindModelExecution;
      const bind = owner === "retained" ? retained?.bindModelExecution : bindFromHost;
      if (!bind || !bindFromHost) {
        throw new Error("missing host model execution capability");
      }
      if (owner === "retained") {
        if (!siblingSource?.bindModelExecution) {
          throw new Error("missing independently retained model execution capability");
        }
        expect(retained?.modelPolicyRequired).toBe(initialPolicy);
        host.close();
        admission.close();
      }
      if (initialPolicy) {
        expect(() => bind({ provider: "fixture", model: "denied" })).toThrow(
          "operator role cannot use this model",
        );
      }
      const acquire = (model: string, bindModel = bind) => {
        const binding = bindModel({ provider: "fixture", model });
        if (!binding) {
          throw new Error("missing operator model execution binding");
        }
        bindings.push(binding);
        return binding;
      };
      const a = acquire("a");
      const b = acquire("b");
      const current = acquire("b");
      const outsideDefaults = initialPolicy ? undefined : acquire("denied");
      const sibling = siblingSource?.bindModelExecution
        ? acquire("b", siblingSource.bindModelExecution)
        : undefined;

      host.close();
      admission.close();
      expect(retainedSources).toBe(bindings.length + (retained ? 2 : 0));
      for (const binding of bindings) {
        expect(binding.signal.aborted).toBe(false);
        expect(binding.assertCurrent).not.toThrow();
      }
      expect(() => bindFromHost({ provider: "fixture", model: "b" })).toThrow("no longer active");

      policy = prepareOperatorModelPolicy({ cfg, policy: {}, manifestPlugins: [] });
      for (const listener of listeners) {
        listener();
      }
      if (outsideDefaults) {
        expect(outsideDefaults.signal.aborted).toBe(true);
        expect(outsideDefaults.assertCurrent).toThrow("operator role cannot use this model");
      }
      if (retained) {
        expect(retained.modelPolicyRequired).toBe(true);
      }
      expect(a.assertCurrent).not.toThrow();
      expect(b.assertCurrent).not.toThrow();

      policy = prepareOperatorModelPolicy({
        cfg,
        policy: { deny: ["fixture/a"] },
        manifestPlugins: [],
      });
      for (const listener of listeners) {
        listener();
      }
      expect(a.signal.aborted).toBe(true);
      expect(a.assertCurrent).toThrow("operator role cannot use this model");
      expect(b.signal.aborted).toBe(false);
      expect(b.assertCurrent).not.toThrow();
      expect(sourceAbort.signal.aborted).toBe(false);
      expect(source.assertCurrent).not.toThrow();
      if (retained) {
        expect(() => bind({ provider: "fixture", model: "a" })).toThrow(
          "operator role cannot use this model",
        );
      }

      policy = undefined;
      for (const listener of listeners) {
        listener();
      }
      expect(a.assertCurrent).toThrow("operator role cannot use this model");
      expect(b.assertCurrent).not.toThrow();
      a.release();
      b.release();
      outsideDefaults?.release();
      expect(b.signal.aborted).toBe(false);
      expect(b.assertCurrent).toThrow("no longer active");
      expect(current.assertCurrent).not.toThrow();

      if (retained && sibling) {
        expect(retained.modelPolicyRequired).toBe(false);
        retained.release();
        expect(current.signal.aborted).toBe(true);
        expect(current.assertCurrent).toThrow("no longer active");
        expect(() => retained.modelPolicyRequired).toThrow("no longer active");
        expect(() => bind({ provider: "fixture", model: "b" })).toThrow("no longer active");
        expect(sibling.signal.aborted).toBe(false);
        expect(sibling.assertCurrent).not.toThrow();
        expect(sourceAbort.signal.aborted).toBe(false);
        current.release();
      }
      const active = sibling ?? current;
      sourceAbort.abort(new Error("operator source revoked"));
      expect(active.signal.aborted).toBe(true);
      expect(active.assertCurrent).toThrow("operator source revoked");
      active.release();
      expect(active.assertCurrent).toThrow("no longer active");
      retained?.release();
      siblingSource?.release();
      expect(listeners.size).toBe(0);
      expect(retainedSources).toBe(0);
    } finally {
      for (const binding of bindings) {
        binding.release();
      }
      retained?.release();
      siblingSource?.release();
      host.close();
      admission.close();
    }
  },
);
