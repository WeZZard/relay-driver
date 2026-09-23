/**
 * Snapshot evidence contract tests (SNAP-01/02/03).
 *
 * Pinned behavior:
 * - before-snapshot at dispatch time, immediately before the callable;
 * - after-snapshot EXACTLY afterIntervalMs after dispatch completion — the
 *   interval is required and agent-supplied (no default, no settle logic);
 * - missing interval = admission refusal BEFORE dispatch (usage refusal);
 * - coalescing groups: first captures before, last captures after, members
 *   cite the group pair; membership is never inferred;
 * - naming: a<seq>-<ISO stamp>-<role>-<identity>.png, chronological;
 * - hash-at-capture provenance with capture start/complete times;
 * - capture failure after dispatch = journaled capture-status, action still
 *   completes; capture failure before dispatch = admission refusal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordStore, CaptureGate, AdmissionEngine, AdmissionRefusedError } from "../src/index.js";
import { SnapshotStore } from "../src/snapshots.js";

/** Fake capture: writes a deterministic PNG-ish payload per file. */
function fakeCapture(payloadFor: (path: string) => string) {
  return async (outFile: string): Promise<void> => {
    await writeFile(outFile, Buffer.from(payloadFor(outFile), "utf8"));
  };
}

async function harness(captureFn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "relay-snap-"));
  const store = await RecordStore.create(join(dir, "state"));
  const capture = new CaptureGate();
  capture.update({ recording: true, observedAtMonotonic: Date.now() });
  const snapshots = new SnapshotStore(
    async (out) => await captureFn(out),
    store,
    join(dir, "state"),
  );
  const engine = new AdmissionEngine(store, capture, { sessionId: "s1", attemptId: "a1" }, snapshots);
  return { dir, store, engine, snapshots, close: async () => await store.close() };
}

test("before-snapshot is captured at dispatch time, before the callable runs", async () => {
  // The callable asserts the before-snapshot FILE already exists on disk
  // when it starts running — dispatch happened after capture, not before.
  let beforeFileExistedWhenCallableRan: boolean | undefined;
  let beforeTmpPath: string | undefined;
  let callableRan = false;
  const { engine, store, close } = await harness(async (out) => {
    await writeFile(out, "png");
    if (out.includes("before")) beforeTmpPath = out;
    await new Promise((r) => setTimeout(r, 10));
    callableRan = true;
    void store;
  });
  try {
    await engine.call(
      { title: "click save", snapshots: { afterIntervalMs: 10 } },
      async () => {
        // The capture fn receives the .part temp path; by callable time the
        // store has renamed it to the final path. Reconstruct the final path
        // and assert it exists: capture completed before dispatch.
        if (beforeTmpPath) {
          const finalPath = join(dirname(beforeTmpPath), basename(beforeTmpPath).replace(/^\./, "").replace(/\.part$/, ""));
          beforeFileExistedWhenCallableRan = existsSync(finalPath);
        }
        return "ran";
      },
    );
    assert.equal(callableRan, true);
    assert.equal(beforeFileExistedWhenCallableRan, true,
      "before-snapshot file must exist on disk before the callable dispatches");
    const snaps = engine.actionSnapshots;
    assert.ok(snaps && snaps.length === 2, "one before + one after expected");
    assert.equal(snaps[0].role, "before");
    assert.equal(snaps[1].role, "after");
    // Journal ordering: the durable start precedes the before-capture.
    const history = await store.journalHistory();
    const start = history.records.find((r) => r.kind === "action-start");
    const beforeSnap = snaps[0];
    assert.ok(start && new Date(start.writtenAt).getTime() <= beforeSnap.captureStartedAtMonotonic + 5,
      "action-start must be durably retained before the before-snapshot capture starts");
  } finally {
    await close();
  }
});

test("after-snapshot waits exactly the declared interval after dispatch completion", async () => {
  const { engine, close } = await harness(async (out) => {
    await writeFile(out, "png");
  });
  try {
    const INTERVAL = 250;
    // Dispatch completion is captured by the callable itself (its last line
    // runs before the engine records dispatchCompletedAtMonotonic).
    let dispatchCompletedAt = 0;
    await engine.call(
      { title: "open dialog", snapshots: { afterIntervalMs: INTERVAL } },
      async () => {
        dispatchCompletedAt = Date.now();
        return "clicked";
      },
    );
    const snaps = engine.actionSnapshots!;
    const after = snaps.find((s) => s.role === "after")!;
    // Exact contract bounds: the capture starts no earlier than the declared
    // interval after dispatch completion, and no later than that interval
    // plus the capture path's own scheduling latency (timer + fs). The
    // actualWaitMs journal field equals captureStart - dispatchCompleted.
    const wait = after.actualWaitMs!;
    const CAPTURE_SCHEDULING_LATENCY = 120; // setTimeout tick + async fs; generous but deterministic
    assert.ok(wait >= INTERVAL, `wait ${wait}ms must be >= declared ${INTERVAL}ms`);
    assert.ok(wait <= INTERVAL + CAPTURE_SCHEDULING_LATENCY,
      `wait ${wait}ms must be <= declared ${INTERVAL}ms + ${CAPTURE_SCHEDULING_LATENCY}ms scheduling latency`);
    assert.equal(after.declaredAfterIntervalMs, INTERVAL);
    // Cross-check the wait against the callable-side dispatch completion.
    const waitFromCallable = after.captureStartedAtMonotonic - dispatchCompletedAt;
    assert.ok(waitFromCallable >= INTERVAL - 5 && waitFromCallable <= INTERVAL + CAPTURE_SCHEDULING_LATENCY,
      `capture start ${waitFromCallable}ms after callable-side dispatch completion violates the exact-wait contract`);
  } finally {
    await close();
  }
});

test("missing afterIntervalMs is a usage refusal before any dispatch (no default)", async () => {
  const { engine, close } = await harness(async (out) => {
    await writeFile(out, "png");
  });
  try {
    let dispatched = false;
    await assert.rejects(
      engine.call({ title: "no interval", snapshots: {} }, async () => {
        dispatched = true;
        return "x";
      }),
      (err: unknown) => err instanceof AdmissionRefusedError && /interval is required/.test(err.message),
    );
    assert.equal(dispatched, false, "callable must never run on usage refusal");
  } finally {
    await close();
  }
});

test("coalescing group: one pair per group, per-keystroke events cite it", async () => {
  const { engine, store, close } = await harness(async (out) => {
    await writeFile(out, "png");
  });
  try {
    const group = { groupId: "grp-text-hello" };
    // First member: captures before.
    await engine.call(
      { title: "type H", snapshots: { group: { ...group, phase: "first" } } },
      async () => "H",
    );
    const firstSnaps = engine.actionSnapshots!;
    assert.equal(firstSnaps.length, 1);
    assert.equal(firstSnaps[0].role, "before");
    // Interior member: captures nothing, cites the group.
    await engine.call(
      { title: "type e", snapshots: { group: { ...group, phase: "member" } } },
      async () => "e",
    );
    assert.ok(!engine.actionSnapshots || engine.actionSnapshots.length === 0,
      "member captures nothing itself");
    // Last member: captures after with the group interval.
    await engine.call(
      {
        title: "type llo",
        snapshots: { group: { ...group, phase: "last", afterIntervalMs: 120 } },
      },
      async () => "llo",
    );
    const lastSnaps = engine.actionSnapshots!;
    assert.equal(lastSnaps.length, 1);
    assert.equal(lastSnaps[0].role, "after");
    assert.equal(lastSnaps[0].declaredAfterIntervalMs, 120);
    // Journal: every keystroke event references the group identity.
    const history = await store.journalHistory();
    const groupRefs = history.records.filter(
      (r) => (r as { groupId?: string }).groupId === group.groupId,
    );
    assert.ok(groupRefs.length >= 3, "all three members journal with the group id");
  } finally {
    await close();
  }
});

test("group last member without interval is a usage refusal", async () => {
  const { engine, close } = await harness(async (out) => {
    await writeFile(out, "png");
  });
  try {
    await assert.rejects(
      engine.call(
        { title: "type x", snapshots: { group: { groupId: "g1", phase: "last" } } },
        async () => "x",
      ),
      (err: unknown) =>
        err instanceof AdmissionRefusedError && /interval is required on the last member/.test(err.message),
    );
  } finally {
    await close();
  }
});

test("capture failure before dispatch refuses admission and journals the refusal", async () => {
  const { engine, close } = await harness(async () => {
    throw new Error("display capture unavailable");
  });
  try {
    let dispatched = false;
    await assert.rejects(
      engine.call({ title: "click", snapshots: { afterIntervalMs: 50 } }, async () => {
        dispatched = true;
        return "x";
      }),
      (err: unknown) => err instanceof AdmissionRefusedError && /screenshot capture failed/.test(err.message),
    );
    assert.equal(dispatched, false);
  } finally {
    await close();
  }
});

test("capture failure after dispatch is journaled capture-status; action still completes", async () => {
  const { dir, store, close } = await harness(async (out) => {
    await writeFile(out, "png");
  });
  try {
    // One engine; its capture fn succeeds for the before-snapshot (call 1)
    // and fails for the after-snapshot (call 2). No casts, no dead logic.
    let calls = 0;
    const failing = async (out: string) => {
      calls++;
      if (calls === 2) throw new Error("screen locked");
      await writeFile(out, "png");
    };
    const gate = new CaptureGate();
    gate.update({ recording: true, observedAtMonotonic: Date.now() });
    const engine2 = new AdmissionEngine(
      store,
      gate,
      { sessionId: "s2", attemptId: "a2" },
      new SnapshotStore(failing, store, join(dir, "state")),
    );
    const result = await engine2.call(
      { title: "click", snapshots: { afterIntervalMs: 10 } },
      async () => "ok",
    );
    assert.equal(result, "ok", "the action itself still completes");
    const history = await store.journalHistory();
    const captureStatus = history.records.find((r) => r.kind === "capture-status");
    assert.ok(captureStatus, "capture-status journaled for the failed after-snapshot");
    // The action record retains only the before ref — the missing after is
    // explicit evidence, never fabricated.
    const action = await store.getAction(
      (history.records.find((r) => r.kind === "snapshot-evidence") as { actionId: string }).actionId,
    );
    assert.ok(action);
    assert.ok(action.snapshots && action.snapshots.length === 1);
    assert.equal(action.snapshots![0].role, "before");
  } finally {
    await close();
  }
});

test("snapshot file names sort chronologically and bind to journal seq", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-snap-"));
  const store = await RecordStore.create(join(dir, "state"));
  try {
    const gate = new CaptureGate();
    gate.update({ recording: true, observedAtMonotonic: Date.now() });
    const snapshots = new SnapshotStore(
      async (out) => await writeFile(out, "png"),
      store,
      join(dir, "state"),
    );
    const engine = new AdmissionEngine(store, gate, { sessionId: "s3", attemptId: "a3" }, snapshots);
    await engine.call({ title: "Click Save", snapshots: { afterIntervalMs: 5 } }, async () => "ok");
    const sessionDir = join(dir, "state", "snapshots", "s3");
    const files = (await readdir(sessionDir)).filter((f) => f.endsWith(".png")).sort();
    assert.equal(files.length, 2);
    // a<seq>-<timestamp>-<role>-<identity>.png
    assert.match(files[0], /^a\d{6}-\d{8}T\d{6}\.\d+Z-before-click-save\.png$/);
    assert.match(files[1], /^a\d{6}-\d{8}T\d{6}\.\d+Z-after-click-save\.png$/);
    // Hash provenance recorded and verifiable.
    const snaps = engine.actionSnapshots!;
    for (const s of snaps) {
      const bytes = await readFile(join(sessionDir, s.fileName));
      const { createHash } = await import("node:crypto");
      assert.equal(createHash("sha256").update(bytes).digest("hex"), s.sha256);
      const st = await stat(join(sessionDir, s.fileName));
      assert.equal(st.size, s.bytes);
    }
    void dir;
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
