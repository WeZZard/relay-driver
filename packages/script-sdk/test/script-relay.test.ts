/**
 * SCRIPT-01: per-language script-side SDK with recorded-call handle
 * semantics. The SDK runs inside a deployed/streamed script; every call is
 * individually admitted and journaled with the parent execution identity.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptRelay, HandleAlreadyUsedError } from "../src/script-relay.js";
import { RecordStore, type AdmissionEngine } from "@wezzard/relay-driver-remote-runtime";
import type { JournalRecord } from "@wezzard/relay-driver-core";

async function readActions(stateDir: string): Promise<JournalRecord[]> {
  const store = await RecordStore.create(stateDir);
  const { records } = await store.journalHistory();
  await store.close();
  return records.filter((r) => r.kind === "action-start");
}

test("recorded calls each get individual admission with parent execution identity", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "script-sdk-"));
  const relay = new ScriptRelay({ stateDir, parentExecutionId: "execution-script-1" });
  relay.observeCapture({ recording: true, segmentId: "seg-1" });

  const order: string[] = [];
  await relay.step({ id: "padding", title: "Adjust padding", expected: "preview changes" }, async (r) => {
    await r.recordedCall(async () => { order.push("openLayout"); return "layout-open"; }, { title: "open layout" });
    await r.recordedCall(async () => { order.push("drag"); return "dragged"; }, { title: "drag padding" });
  });

  assert.deepEqual(order, ["openLayout", "drag"]);
  const starts = await readActions(stateDir);
  const ours = starts.filter((r) => r.stepId === "padding");
  assert.equal(ours.length, 2);
  for (const r of ours) {
    assert.equal(r.executionId, "execution-script-1", "parent execution identity must be cited");
    assert.equal(r.state, "admitted");
  }
  // Journal carries per-call starts/completions, not one receipt for the script.
  const journal = await readFile(join(stateDir, "journal", "events.jsonl"), "utf8");
  const kinds = journal.trim().split("\n").map((l) => JSON.parse(l).kind);
  assert.equal(kinds.filter((k) => k === "action-start").length, 2);
  assert.equal(kinds.filter((k) => k === "action-completion").length, 2);
});

test("a used handle invoked again is refused without dispatching input", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "script-sdk-ref-"));
  const relay = new ScriptRelay({ stateDir, parentExecutionId: "execution-script-2" });
  relay.observeCapture({ recording: true, segmentId: "seg-1" });
  let ran = 0;
  await relay.recordedCall(() => { ran += 1; return "first"; });
  assert.equal(ran, 1);
  // The first call's action id is durable; invoking the same identity again
  // must refuse before running the callable.
  const store = await RecordStore.create(stateDir);
  const { records } = await store.journalHistory();
  await store.close();
  const usedId = records.find((r) => r.kind === "action-start")!.actionId!;
  const engineBox = relay as unknown as { engine: Promise<AdmissionEngine> };
  const engine = await engineBox.engine;
  await assert.rejects(
    () => engine.callWithHandle(usedId, { title: "retry" }, () => { ran += 1; return "again"; }),
    HandleAlreadyUsedError,
  );
  assert.equal(ran, 1, "second invocation must not run");
});

test("step context rides on each recorded call", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "script-sdk-ctx-"));
  const relay = new ScriptRelay({ stateDir, parentExecutionId: "execution-script-3" });
  relay.observeCapture({ recording: true, segmentId: "seg-1" });
  await relay.step({ id: "save", title: "Save changes", inputMode: "accessibility" }, async (r) => {
    await r.recordedCall(() => "ok");
  });
  const starts = await readActions(stateDir);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].title, "Save changes");
  assert.equal(starts[0].inputMode, "accessibility");
});

test("recordedCall snapshots params reach the journaled start (script-side passthrough)", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "script-sdk-snap-"));
  const relay = new ScriptRelay({
    stateDir,
    parentExecutionId: "execution-script-snap",
    snapshotCapture: async (outFile) => { const { writeFile } = await import("node:fs/promises"); await writeFile(outFile, "png"); },
  });
  relay.observeCapture({ recording: true, segmentId: "seg-snap" });

  await relay.step({ id: "typing", title: "Type text", expected: "text appears" }, async (r) => {
    await r.recordedCall(async () => "h", { title: "type h", snapshots: { afterIntervalMs: 300 } });
    await r.recordedCall(async () => "i", {
      title: "type i",
      snapshots: { group: { groupId: "grp-hi", phase: "last", afterIntervalMs: 800 } },
    });
  });

  const starts = await readActions(stateDir);
  const ours = starts.filter((r) => r.stepId === "typing");
  assert.equal(ours.length, 2);
  const single = ours.find((r) => r.title === "type h");
  assert.deepEqual((single as { snapshotPlan?: unknown }).snapshotPlan, {
    capturesBefore: true,
    capturesAfter: { afterIntervalMs: 300 },
    role: "single",
  });
  const grouped = ours.find((r) => r.title === "type i");
  const plan = (grouped as { snapshotPlan?: { role?: string; capturesAfter?: unknown; group?: { groupId?: string } } }).snapshotPlan;
  assert.equal(plan?.group?.groupId, "grp-hi");
  assert.equal(plan?.role, "last", "the phase travels as the plan role");
  assert.deepEqual(plan?.capturesAfter, { afterIntervalMs: 800 });
});
