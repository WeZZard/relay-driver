import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RecordStore,
  CaptureGate,
  AdmissionEngine,
  AdmissionRefusedError,
  HandleAlreadyUsedError,
  EvidenceWriteError,
  Continuation,
} from "../src/index.js";

interface Fixture {
  store: RecordStore;
  capture: CaptureGate;
  engine: AdmissionEngine;
  sessionId: string;
  attemptId: string;
}

async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "relay-runtime-"));
  const store = await RecordStore.create(dir);
  const capture = new CaptureGate();
  capture.update({ recording: true, segmentId: "segment-x", observedAtMonotonic: Date.now() });
  const sessionId = "session-test";
  const attemptId = "attempt-test";
  await store.putSession({
    sessionId,
    taskId: "task-test",
    createdAt: new Date().toISOString(),
    state: "active",
    attempts: [attemptId],
  });
  await store.putAttempt({
    attemptId,
    sessionId,
    state: "active",
    segments: ["segment-x"],
  });
  const engine = new AdmissionEngine(store, capture, { sessionId, attemptId });
  return { store, capture, engine, sessionId, attemptId };
}

test("call invokes the callable once and preserves its value", async () => {
  const f = await fixture();
  let invocations = 0;
  const value = await f.engine.call({ stepId: "s1", title: "Click Save" }, () => {
    invocations++;
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(invocations, 1);
  await f.store.close();
});

test("start is durably retained before the callable runs", async () => {
  const f = await fixture();
  let sawState: string | undefined;
  await f.engine.call({ title: "probe" }, async () => {
    const history = await f.store.journalHistory();
    sawState = history.records.find((r) => r.kind === "action-start")?.state;
  });
  assert.equal(sawState, "admitted");
  const history = await f.store.journalHistory();
  const completion = history.records.find((r) => r.kind === "action-completion");
  assert.ok(completion);
  await f.store.close();
});

test("tool exception propagates unchanged; completion still recorded", async () => {
  const f = await fixture();
  const boom = new Error("backend failure");
  await assert.rejects(
    f.engine.call({ title: "fails" }, () => {
      throw boom;
    }),
    (err: unknown) => err === boom,
  );
  const history = await f.store.journalHistory();
  const completion = history.records.find((r) => r.kind === "action-completion");
  assert.equal((completion?.toolOutcome as { kind: string }).kind, "failure");
  await f.store.close();
});

test("second call on the same handle is refused without dispatching input", async () => {
  const f = await fixture();
  let invocations = 0;
  const callable = () => {
    invocations++;
    return "ok";
  };
  const handleId = f.engine.allocateAction({ title: "once" });
  await f.engine.callWithHandle(handleId, { title: "once" }, callable);
  await assert.rejects(
    f.engine.callWithHandle(handleId, { title: "once" }, callable),
    HandleAlreadyUsedError,
  );
  assert.equal(invocations, 1);
  await f.store.close();
});

test("capture loss refuses admission and never invokes the callable", async () => {
  const f = await fixture();
  f.capture.reportLoss("recorder exited unexpectedly");
  let invocations = 0;
  await assert.rejects(
    f.engine.call({ title: "after loss" }, () => {
      invocations++;
      return true;
    }),
    AdmissionRefusedError,
  );
  assert.equal(invocations, 0);
  await f.store.close();
});

test("evidence-write failure preserves the tool exception, disables further input (D17)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-runtime-"));
  const store = await RecordStore.create(dir);
  const capture = new CaptureGate();
  capture.update({ recording: true, segmentId: "seg", observedAtMonotonic: Date.now() });
  const engine = new AdmissionEngine(store, capture, {
    sessionId: "session-e",
    attemptId: "attempt-e",
  });

  // Corrupt the journal path so completion writes fail: close the writer then
  // replace the journal file with a directory to force append failure.
  await store.close();
  const fs = await import("node:fs/promises");
  const journalPath = join(dir, "journal", "events.jsonl");
  await fs.rm(journalPath);
  await fs.mkdir(journalPath);

  const boom = new Error("backend failure");
  let captured: unknown;
  try {
    await engine.call({ title: "combo" }, () => {
      throw boom;
    });
  } catch (err) {
    captured = err;
  }
  assert.ok(captured instanceof EvidenceWriteError);
  const comboOutcome = (captured as EvidenceWriteError).toolOutcome as { kind: string };
  assert.equal(comboOutcome.kind, "failure");

  // Further input is refused session-wide.
  await assert.rejects(
    engine.call({ title: "next" }, () => true),
    AdmissionRefusedError,
  );
});

test("continuation creates a related attempt and gates input until ready (D16)", async () => {
  const f = await fixture();
  f.capture.reportLoss("capture stopped during a drag");
  const continuation = await Continuation.begin(
    f.store,
    f.capture,
    f.sessionId,
    f.attemptId,
    "capture stopped",
  );
  await continuation.finalizeInterrupted();
  const interrupted = await f.store.getAttempt(f.attemptId);
  assert.equal(interrupted?.state, "retained");

  let segmentStarted = 0;
  await continuation.establishReadiness(async () => {
    segmentStarted++;
    f.capture.update({ recording: true, segmentId: "segment-y", observedAtMonotonic: Date.now() });
    return { segmentId: "segment-y" };
  });
  assert.equal(segmentStarted, 1);
  assert.equal(continuation.currentPhase, "ready");

  const newAttempt = await f.store.getAttempt(continuation.newAttemptId);
  assert.equal(newAttempt?.continuesAttemptId, f.attemptId);
  assert.deepEqual(newAttempt?.segments, ["segment-y"]);

  // Input works again after readiness.
  const value = await f.engine.call({ title: "after continuation" }, () => "ok");
  assert.equal(value, "ok");
  await f.store.close();
});
