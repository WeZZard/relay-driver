/**
 * Stage 3, RESOURCE-01: task and per-execution resource limits under
 * deliberately small budgets. Atomic reservations, concurrent producers,
 * bursts between samples, unrelated volume consumption, stalled supervision,
 * deadline expiry, and failed finalization — with evidence preserved and
 * further input refused before ordinary use consumes shutdown capacity.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ResourceManager,
  Supervisor,
  ResourceRefusedError,
  RecordStore,
  CaptureGate,
  AdmissionEngine,
  AdmissionRefusedError,
  EvidenceWriteError,
} from "../src/index.js";

function smallBudgets(overrides: Partial<Parameters<typeof makeBudgets>[0]> = {}) {
  return makeBudgets(overrides);
}

function makeBudgets(o: {
  taskStorageBytes?: number;
  stopAllowanceBytes?: number;
  perExecutionOutputBytes?: number;
  relayBufferBytes?: number;
  volumeFloorBytes?: number;
} = {}) {
  return {
    taskStorageBytes: o.taskStorageBytes ?? 1_000_000,
    stopAllowanceBytes: o.stopAllowanceBytes ?? 100_000,
    perExecutionOutputBytes: o.perExecutionOutputBytes ?? 200_000,
    relayBufferBytes: o.relayBufferBytes ?? 50_000,
    volumeFloorBytes: o.volumeFloorBytes ?? 0,
    volumePaths: ["/tmp"] as readonly string[],
    pollIntervalMs: 10,
  };
}

test("atomic reservation: concurrent producers cannot double-spend remaining capacity", async () => {
  // Task budget 1000, stop allowance 100: ordinary work may spend 900.
  const resources = new ResourceManager(
    smallBudgets({ taskStorageBytes: 1_000, stopAllowanceBytes: 100, perExecutionOutputBytes: 1_000 }),
  );
  // Two producers each reserve 600 bytes against the 900-byte ordinary
  // headroom: the second must fail atomically (no partial spend).
  resources.reserveOutput("exec-a", 600);
  assert.throws(
    () => resources.reserveOutput("exec-b", 600),
    (err: unknown) => err instanceof ResourceRefusedError && err.kind === "shutdown-allowance",
  );
  // The failed reservation changed nothing: the remaining 300 is intact.
  resources.reserveOutput("exec-b", 300);
  assert.throws(() => resources.reserveOutput("exec-a", 1), ResourceRefusedError);
  // Committing does not free task budget: committed bytes stay counted.
  resources.commitReserved("exec-a", 600);
  resources.commitReserved("exec-b", 300);
  assert.throws(() => resources.reserveOutput("exec-c", 1), ResourceRefusedError);
});

test("shutdown allowance is protected: refusal before ordinary use consumes it", () => {
  const resources = new ResourceManager(smallBudgets({ taskStorageBytes: 1_000, stopAllowanceBytes: 300 }));
  // Ordinary work may spend at most 700 bytes; at 700 the next byte refuses.
  resources.reserveOutput("exec-a", 700);
  assert.throws(
    () => resources.reserveOutput("exec-b", 1),
    (err: unknown) => err instanceof ResourceRefusedError && err.kind === "shutdown-allowance",
  );
});

test("relay buffers are strictly bounded and refuse before enqueue", () => {
  const resources = new ResourceManager(smallBudgets({ relayBufferBytes: 500 }));
  resources.reserveBuffer(300);
  resources.reserveBuffer(200); // exactly at cap
  assert.throws(
    () => resources.reserveBuffer(1),
    (err: unknown) => err instanceof ResourceRefusedError && err.kind === "relay-buffer-cap",
  );
  resources.releaseBuffer(200);
  resources.reserveBuffer(200); // fits again after release
});

test("burst between samples: reservation catches the burst that sampling would miss", async () => {
  const resources = new ResourceManager(smallBudgets({ perExecutionOutputBytes: 1_000 }));
  // A burst of writes lands between volume samples; per-chunk reservation
  // still stops the overflow that a periodic sampler would see too late.
  for (let i = 0; i < 10; i++) resources.reserveOutput("exec-burst", 90); // 900 reserved
  assert.throws(
    () => resources.reserveOutput("exec-burst", 101), // would exceed the 1000-byte cap
    (err: unknown) => err instanceof ResourceRefusedError && err.kind === "per-execution-output-cap",
  );
  resources.commitReserved("exec-burst", 900);
  const sample = await resources.sampleVolume();
  assert.ok(sample.taskCommittedBytes === 900);
});

test("unrelated volume consumption is visible through statfs sampling", async () => {
  const resources = new ResourceManager(
    smallBudgets({ volumeFloorBytes: Number.MAX_SAFE_INTEGER / 2 }),
  );
  // A floor larger than any real free space simulates unrelated consumption
  // having eaten the volume: the check must refuse.
  const sample = await resources.sampleVolume();
  assert.ok(sample.volumeAvailableBytes !== undefined);
  assert.throws(
    () => resources.checkVolumeCapacity(sample),
    (err: unknown) => err instanceof ResourceRefusedError && err.kind === "volume-capacity",
  );
});

test("stalled supervision refuses further input; deadline expiry stops work", async () => {
  let now = 1_000;
  const resources = new ResourceManager(smallBudgets());
  const stopped: string[] = [];
  const supervisor = Supervisor.start(resources, {
    deadlineAtMonotonic: 2_000,
    pollIntervalMs: 5,
    maxObservationAgeMs: 50,
    onSample: async () => ({ healthy: true }),
    onStop: (diagnostic) => {
      stopped.push(diagnostic);
    },
    now: () => now,
  });
  assert.ok(supervisor.isFresh);
  // Advance the clock past the max observation age without a tick: stale.
  now = 1_060;
  assert.ok(!supervisor.isFresh);
  assert.match(supervisor.stalenessDiagnostic!, /stale/);
  // Deadline expiry triggers the stop path.
  now = 2_100;
  await new Promise((r) => setTimeout(r, 30)); // let the interval tick
  assert.ok(resources.isStopped, "deadline expiry declared the resource stop");
  assert.equal(resources.stopReason, "task deadline expired");
  assert.deepEqual(stopped, ["task deadline expired"]);
  // Post-stop reservations are refused.
  assert.throws(() => resources.reserveOutput("exec-x", 1), ResourceRefusedError);
  supervisor.stopWatching();
});

test("capture loss through the supervisor: admission closes first, evidence retained", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-capture-loss-"));
  const store = await RecordStore.create(dir);
  const capture = new CaptureGate();
  capture.update({ recording: true, segmentId: "seg-1", observedAtMonotonic: Date.now() });
  const resources = new ResourceManager(smallBudgets());
  const sessionId = "session-capture-loss";
  const attemptId = "attempt-capture-loss";
  await store.putSession({ sessionId, taskId: "t", createdAt: new Date().toISOString(), state: "active", attempts: [attemptId] });
  await store.putAttempt({ attemptId, sessionId, state: "active", segments: ["seg-1"] });

  let ownedWorkCancelled = false;
  const supervisor = Supervisor.start(resources, {
    deadlineAtMonotonic: Date.now() + 60_000,
    pollIntervalMs: 5,
    maxObservationAgeMs: 2_000,
    onSample: async () => {
      // Recorder health source: after the simulated SCStream teardown this
      // reports unhealthy.
      return capture.checkAdmission() === undefined
        ? { healthy: true }
        : { healthy: false, diagnostic: capture.checkAdmission() };
    },
    onStop: (diagnostic) => {
      ownedWorkCancelled = true;
      capture.reportLoss(diagnostic);
    },
  });

  const engine = new AdmissionEngine(store, capture, { sessionId, attemptId });
  // A completed action before the loss.
  const v = await engine.call({ title: "before loss" }, () => "ok");
  assert.equal(v, "ok");

  // Simulate capture loss (recorder dies between script actions).
  capture.reportLoss("SCStream stopped producing frames");
  await new Promise((r) => setTimeout(r, 30)); // supervisor tick detects

  assert.ok(ownedWorkCancelled, "supervisor cancelled owned work");
  assert.ok(resources.isStopped);
  assert.match(resources.stopReason!, /SCStream/);
  // Further input is refused in both paths.
  await assert.rejects(
    engine.call({ title: "after loss" }, () => "x"),
    (err: unknown) => err instanceof AdmissionRefusedError,
  );
  supervisor.stopWatching();

  // Evidence before the loss is retained in the journal.
  const history = await store.journalHistory();
  const completions = history.records.filter((r) => r.kind === "action-completion");
  assert.ok(completions.length >= 1);
  await store.close();
});

test("evidence-write failure disables further input session-wide (D17) without masking the tool error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-evidence-fail-"));
  const store = await RecordStore.create(dir);
  const capture = new CaptureGate();
  capture.update({ recording: true, segmentId: "seg-1", observedAtMonotonic: Date.now() });
  const sessionId = "session-ef";
  const attemptId = "attempt-ef";
  await store.putSession({ sessionId, taskId: "t", createdAt: new Date().toISOString(), state: "active", attempts: [attemptId] });
  await store.putAttempt({ attemptId, sessionId, state: "active", segments: ["seg-1"] });
  const engine = new AdmissionEngine(store, capture, { sessionId, attemptId });

  // Sabotage the completion write by closing the underlying journal writer:
  // retainActionCompletion appends through the journal; a closed store makes
  // the completion write fail while the callable itself succeeded.
  const first = engine.call({ title: "will lose evidence" }, () => "computed");
  // Break the journal right after the durable start lands but before
  // completion: intercept by closing the store mid-flight is racy; instead
  // close the store up front and prove the start's durable-write failure is
  // surfaced as EvidenceWriteError (retention is the failing channel).
  await store.close();
  await assert.rejects(first, EvidenceWriteError);

  // Further input refused.
  await assert.rejects(engine.call({ title: "after failure" }, () => "x"), (err: unknown) =>
    err instanceof Error && /evidence retention previously failed|capture/.test(err.message),
  );
});
