/**
 * Snapshot lifecycle failures (D26).
 *
 * Failure paths must leave whole, closed evidence: a failed capture leaves
 * no unfinished `.part` original behind.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordStore } from "../src/index.js";
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
