/**
 * Snapshot lifecycle failures (D26).
 *
 * Failure paths must leave whole, closed evidence: a failed capture leaves
 * no unfinished `.part` original behind, and an action refused after its
 * durable start is closed by a refusal record that does not claim input.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordStore, CaptureGate, AdmissionEngine, AdmissionRefusedError } from "../src/index.js";
import { SnapshotStore, SnapshotCaptureError, type SnapshotCaptureFn } from "../src/snapshots.js";

async function snapshotHarness(capture: SnapshotCaptureFn) {
  const dir = await mkdtemp(join(tmpdir(), "relay-snap-life-"));
  const stateDir = join(dir, "state");
  const store = await RecordStore.create(stateDir);
  const snapshots = new SnapshotStore(capture, store, stateDir);
  return { dir, stateDir, store, snapshots, close: async () => await store.close() };
}

test("a failed capture removes its .part file", async () => {
  const { stateDir, snapshots, close } = await snapshotHarness(async (out) => {
    // The driver wrote part of the image, then failed.
    await writeFile(out, "partial png bytes");
    throw new Error("display capture failed mid-write");
  });
  try {
    await assert.rejects(
      snapshots.before({ journalSeq: 1, dispatchIdentity: "click", sessionId: "s1", attemptId: "a1" }),
      (err: unknown) => err instanceof SnapshotCaptureError && /mid-write/.test(err.message),
    );
    const left = await readdir(join(stateDir, "snapshots", "s1"));
    assert.deepEqual(left.filter((name) => name.endsWith(".part")), [],
      `unfinished snapshot originals retained: ${left.join(", ")}`);
  } finally {
    await close();
  }
});

test("a refused before-capture closes the admitted action without claiming input", async () => {
  const { store, snapshots, close } = await snapshotHarness(async () => {
    throw new Error("display capture unavailable");
  });
  const capture = new CaptureGate();
  capture.update({ recording: true, observedAtMonotonic: Date.now() });
  const engine = new AdmissionEngine(store, capture, { sessionId: "s1", attemptId: "a1" }, snapshots);
  try {
    let dispatched = false;
    await assert.rejects(
      engine.call({ title: "click", snapshots: { afterIntervalMs: 50 } }, async () => {
        dispatched = true;
        return "x";
      }),
      (err: unknown) => err instanceof AdmissionRefusedError && /screenshot capture failed/.test(err.message),
    );
    assert.equal(dispatched, false, "the callable must not run when the before-snapshot fails");

    const { records } = await store.journalHistory();
    const start = records.find((r) => r.kind === "action-start");
    assert.ok(start?.actionId, "the durable start was retained before the capture");
    const closing = records.filter((r) => r.actionId === start.actionId && r.seq > start.seq);
    const refusal = closing.find((r) => r.kind === "action-refusal");
    assert.ok(refusal, `no record closes the admitted action; records after start: ${JSON.stringify(closing.map((r) => r.kind))}`);
    assert.equal(refusal.state, "refused");
    assert.equal(refusal.inputDispatched, false);
    assert.match(String(refusal.diagnostic), /screenshot capture failed/);
    assert.equal(closing.some((r) => r.kind === "action-completion"), false,
      "a refusal must not be recorded as a tool completion");

    const record = await store.getAction(start.actionId);
    assert.equal(record?.state, "refused");
    assert.equal(record?.toolOutcome, undefined);
  } finally {
    await close();
  }
});
