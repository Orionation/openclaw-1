import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { placementTurnOwner, type WorkerSessionPlacementIdentity } from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import {
  bindWorkerTurnOwner,
  getWorkerTurnExecutionIdentityCapability,
} from "./placement-turn-claim-events.js";

const SESSION: WorkerSessionPlacementIdentity = {
  sessionId: "session-placement-claim-close",
  agentId: "main",
  sessionKey: "agent:main:placement-claim-close",
};
let root: string;
let database: OpenClawStateDatabase;
let store: WorkerSessionPlacementStore;

beforeEach(async () => {
  root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "openclaw-placement-authority-"),
  );
  database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  store = createWorkerSessionPlacementStore({ database });
});
afterEach(async () => {
  await closeStateDatabaseForTest();
  await fs.rm(root, { recursive: true, force: true });
});
function advanceToActive(executionMode: "worker-turn" | "remote-exec" = "worker-turn") {
  return advancePlacementFixtureToActive(store, database, SESSION, executionMode);
}

it.each(["local", "worker-turn", "remote-exec"] as const)(
  "retains prepared %s claims across compatible transitions and metadata",
  async (mode) => {
    const active = mode === "local" ? undefined : advanceToActive(mode);
    const claim = store.claimTurn({
      ...SESSION,
      claimId: "claim-prepared-continuity",
      runId: "run-prepared-continuity",
      owner: active ? placementTurnOwner(active) : { kind: "local" },
    });
    const authority = await store.prepareTurnClaimAuthority(claim);
    try {
      if (active) {
        if (claim.owner.kind === "worker") {
          store.updateAckCursors({ claim, liveEvent: 2 });
          expect(authority.isCurrent()).toBe(true);
          store.startWorkspaceResultDrain(claim);
        } else {
          store.startDrain({
            sessionId: claim.sessionId,
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
            expectedGeneration: active.generation,
          });
        }
      } else {
        store.startDispatch(SESSION);
        expect(authority.isCurrent()).toBe(true);
        store.fail({ sessionId: claim.sessionId, recoveryError: "synthetic dispatch failure" });
      }
      expect(authority.isCurrent()).toBe(true);
    } finally {
      authority.release();
    }
  },
);

it("prepares a persisted failed remote-exec local claim without changing its release contract", async () => {
  const active = advanceToActive("remote-exec");
  const claim = store.claimTurn({
    ...SESSION,
    claimId: "claim-failed-remote-exec",
    runId: "run-failed-remote-exec",
    owner: placementTurnOwner(active),
  });
  // This persisted shape is accepted by the existing decoder, even though a new drain
  // must pass through reconciliation before failure.
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.prepare(`UPDATE worker_session_placements SET state = 'failed',
      recovery_error = 'previous worker failure', terminal_reason = 'previous worker failure',
      terminal_at_ms = 1 WHERE session_id = ?`).run(claim.sessionId);
    },
    { database },
  );
  const authority = await store.prepareTurnClaimAuthority(claim);
  try {
    expect(authority.isCurrent()).toBe(true);
    store.fail({ sessionId: claim.sessionId, recoveryError: "cleanup is still pending" });
    expect(authority.isCurrent()).toBe(true);
    store.releaseTurn(claim);
    expect(authority.isCurrent()).toBe(false);
  } finally {
    authority.release();
  }
});

it("rolls back claim fencing and never revives a retained approval after same-ID readmission", async () => {
  const active = advanceToActive();
  const input = {
    ...SESSION,
    claimId: "claim-reused-after-release",
    runId: "run-reused-after-release",
    owner: placementTurnOwner(active),
  };
  const claim = store.claimTurn(input);
  const instance = createOperationalRunInstanceRef(claim.runId);
  const delegated = claimAgentRunDelegatedAuthority(instance);
  await bindWorkerTurnOwner(store, claim, undefined, instance, SESSION, () => {});
  const capability = getWorkerTurnExecutionIdentityCapability(store, claim);
  if (!capability) {
    throw new Error("expected retained worker capability");
  }
  const validate = createAgentRuntimeApprovalAuthorityValidator(store);
  const identity = {
    kind: "agentRuntime" as const,
    ...SESSION,
    operationalRunInstance: instance,
    delegatedAuthority: { kind: "worker" as const, ...delegated, turnClaim: claim },
  };
  const closed = vi.fn();
  const unregister = store.registerTurnClaimClosedHandler(closed);
  try {
    expect(validate(identity)).toBe(true);
    expect(() =>
      runOpenClawStateWriteTransaction(
        () => {
          store.releaseTurn(claim);
          expect(validate(identity)).toBe(false);
          expect(closed).not.toHaveBeenCalled();
          throw new Error("roll back outer placement transaction");
        },
        { database },
      ),
    ).toThrow("roll back outer placement transaction");
    expect(validate(identity)).toBe(true);
    await expect(capability.run(() => "still current")).resolves.toBe("still current");
    expect(closed).not.toHaveBeenCalled();

    const replacement = runOpenClawStateWriteTransaction(
      () => {
        store.releaseTurn(claim);
        return store.claimTurn(input);
      },
      { database },
    );
    expect(closed).toHaveBeenCalledOnce();
    await bindWorkerTurnOwner(store, replacement, undefined, instance, SESSION, () => {});
    expect(validate({ ...identity })).toBe(false);
    await expect(capability.run(() => "stale")).rejects.toThrow("worker turn authority changed");
    const next = {
      ...identity,
      delegatedAuthority: { ...identity.delegatedAuthority, turnClaim: replacement },
    };
    expect(validate(next)).toBe(true);
    next.delegatedAuthority.turnClaim = { ...replacement, claimId: "another claim" };
    expect(validate(next)).toBe(false);
  } finally {
    unregister();
    releaseAgentRunDelegatedAuthority(delegated);
  }
});

it("rejects a prepared reader reply after an identical claim was released and readmitted", async () => {
  const active = advanceToActive();
  const input = {
    ...SESSION,
    claimId: "claim-delayed-preparation",
    runId: "run-delayed-preparation",
    owner: placementTurnOwner(active),
  };
  const claim = store.claimTurn(input);
  const read = store.readProjection.bind(store);
  const observed = createDeferredCore();
  const resume = createDeferredCore();
  vi.spyOn(store, "readProjection").mockImplementationOnce(async (...args) => {
    const result = await read(...args);
    observed.resolve();
    await resume.promise;
    return result;
  });
  const preparing = store.prepareTurnClaimAuthority(claim);
  try {
    await observed.promise;
    store.releaseTurn(claim);
    const replacement = store.claimTurn(input);
    resume.resolve();
    await expect(preparing).rejects.toThrow("turn claim authority changed");
    const current = await store.prepareTurnClaimAuthority(replacement);
    expect(current.isCurrent()).toBe(true);
    current.release();
  } finally {
    resume.resolve();
    await Promise.allSettled([preparing]);
  }
});

it("does not publish an execution owner when its final authority check fails", async () => {
  const active = advanceToActive();
  const claim = store.claimTurn({
    ...SESSION,
    claimId: "claim-failed-binding",
    runId: "run-failed-binding",
    owner: placementTurnOwner(active),
  });
  const instance = createOperationalRunInstanceRef(claim.runId);
  const delegated = claimAgentRunDelegatedAuthority(instance);
  const assertActive = vi
    .fn()
    .mockImplementationOnce(() => {})
    .mockImplementation(() => {
      throw new Error("run closed during binding");
    });
  try {
    await expect(
      bindWorkerTurnOwner(store, claim, undefined, instance, SESSION, assertActive),
    ).rejects.toThrow("run closed during binding");
    expect(getWorkerTurnExecutionIdentityCapability(store, claim)).toBeUndefined();
  } finally {
    releaseAgentRunDelegatedAuthority(delegated);
  }
});

it("keeps authority revoked when COMMIT succeeds but its outcome is lost", async () => {
  const active = advanceToActive();
  const claim = store.claimTurn({
    ...SESSION,
    claimId: "claim-lost-commit",
    runId: "run-lost-commit",
    owner: placementTurnOwner(active),
  });
  const authority = await store.prepareTurnClaimAuthority(claim);
  const exec = database.db.exec.bind(database.db);
  const failure = new Error("synthetic lost placement COMMIT outcome");
  const intercepted = vi.spyOn(database.db, "exec").mockImplementation((sql) => {
    exec(sql);
    if (sql === "COMMIT") {
      throw failure;
    }
  });
  try {
    expect(() => store.releaseTurn(claim)).toThrow(failure);
    expect(authority.isCurrent()).toBe(false);
    const persisted = new DatabaseSync(database.path, { readOnly: true });
    try {
      expect(
        persisted
          .prepare("SELECT turn_claim_id FROM worker_session_placements WHERE session_id = ?")
          .get(claim.sessionId),
      ).toMatchObject({ turn_claim_id: null });
    } finally {
      persisted.close();
    }
  } finally {
    intercepted.mockRestore();
    authority.release();
  }
});

it("shares claim revocation across facades while restart clearing leaves worker claims live", async () => {
  const active = advanceToActive();
  const worker = store.claimTurn({
    ...SESSION,
    claimId: "claim-shared-facade",
    runId: "run-shared-facade",
    owner: placementTurnOwner(active),
  });
  const local = store.claimTurn({
    sessionId: "session-local-restart",
    agentId: "main",
    sessionKey: "agent:main:local-restart",
    claimId: "claim-local-restart",
    runId: "run-local-restart",
    owner: { kind: "local" },
  });
  const workerAuthority = await store.prepareTurnClaimAuthority(worker);
  const localAuthority = await store.prepareTurnClaimAuthority(local);
  const alias = path.join(root, "placement-alias.sqlite");
  await fs.symlink(database.path, alias);
  const facade = createWorkerSessionPlacementStore({
    database: openOpenClawStateDatabase({ path: alias }),
  });
  try {
    expect(facade.clearLocalTurnClaimsAfterRestart()).toBe(1);
    expect(localAuthority.isCurrent()).toBe(false);
    expect(workerAuthority.isCurrent()).toBe(true);
    facade.authorizeWorkerTurnTools(worker, ["sessions_send"]);
    expect(workerAuthority.isCurrent()).toBe(true);
    facade.releaseTurn(worker);
    expect(workerAuthority.isCurrent()).toBe(false);
  } finally {
    workerAuthority.release();
    localAuthority.release();
  }
});

it("does not adopt an identical claim from a replacement database", async () => {
  const active = advanceToActive();
  const input = {
    ...SESSION,
    claimId: "claim-replaced-database",
    runId: "run-replaced-database",
    owner: placementTurnOwner(active),
  };
  const original = store.claimTurn(input);
  const authority = await store.prepareTurnClaimAuthority(original);
  const pathname = database.path;
  await closeStateDatabaseForTest();
  await fs.rename(pathname, `${pathname}.retired`);
  database = openOpenClawStateDatabase({ path: pathname });
  store = createWorkerSessionPlacementStore({ database });
  const replacementPlacement = advanceToActive();
  const replacement = store.claimTurn({
    ...input,
    owner: placementTurnOwner(replacementPlacement),
  });
  const next = await store.prepareTurnClaimAuthority(replacement);
  try {
    expect(replacement).toEqual(original);
    expect(authority.isCurrent()).toBe(false);
    expect(next.isCurrent()).toBe(true);
  } finally {
    authority.release();
    next.release();
  }
});
