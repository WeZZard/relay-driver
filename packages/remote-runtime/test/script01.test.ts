/**
 * SCRIPT-01 unit layer: generated-code actions have individual coverage —
 * loops and conditionals create one handle per invocation, second dispatch
 * is refused, recovered handles cannot replay, deliberate retry gets a new
 * linked identity, failures propagate unmasked.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordStore, CaptureGate, AdmissionEngine, HandleAlreadyUsedError } from "../src/index.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "relay-script01-"));
  const store = await RecordStore.create(dir);
  const capture = new CaptureGate();
  capture.update({ recording: true, segmentId: "segment-s1", observedAtMonotonic: Date.now() });
  const sessionId = "session-script01";
  const attemptId = "attempt-script01";
  await store.putSession({ sessionId, taskId: "t", createdAt: new Date().toISOString(), state: "active", attempts: [attemptId] });
  await store.putAttempt({ attemptId, sessionId, state: "active", segments: ["segment-s1"] });
  const engine = new AdmissionEngine(store, capture, { sessionId, attemptId });
  return { store, capture, engine, sessionId, attemptId };
}

test("loops and conditionals: one handle per invocation, each individually recorded", async () => {
  const f = await fixture();
  const seen: string[] = [];
  // A generated-code loop: three iterations, each its own action handle.
  for (let i = 0; i < 3; i++) {
    const value = await f.engine.call({ stepId: `loop-${i}`, title: `Iter ${i}` }, () => `v${i}`);
    seen.push(value as string);
  }
  // A conditional branch: only the taken branch runs.
  const flag = true;
  if (flag) {
    await f.engine.call({ stepId: "branch-then", title: "Then branch" }, () => "then");
  } else {
    await f.engine.call({ stepId: "branch-else", title: "Else branch" }, () => "else");
  }
  assert.deepEqual(seen, ["v0", "v1", "v2"]);
  const history = await f.store.journalHistory();
  const starts = history.records.filter((r) => r.kind === "action-start");
  assert.equal(starts.length, 4, "loop iterations + taken branch, each with a start record");
  assert.equal(new Set(starts.map((r) => (r as { actionId: string }).actionId)).size, 4, "all distinct action identities");
  await f.store.close();
});

test("handle creation does not claim execution; second dispatch refused; replay impossible", async () => {
  const f = await fixture();
  const actionId = f.engine.allocateAction({ stepId: "s", title: "not yet run" });
  // Creation alone must not have written an execution claim: no start record.
  let history = await f.store.journalHistory();
  assert.equal(history.records.filter((r) => r.kind === "action-start").length, 0);

  let invocations = 0;
  await f.engine.callWithHandle(actionId, { stepId: "s" }, () => { invocations++; return "ok"; });
  assert.equal(invocations, 1);

  // A second call on the same handle must refuse BEFORE dispatching input.
  await assert.rejects(
    f.engine.callWithHandle(actionId, { stepId: "s" }, () => { invocations++; return "again"; }),
    HandleAlreadyUsedError,
  );
  assert.equal(invocations, 1, "callable never ran twice");

  // A recovered recorded handle cannot replay either (fresh engine, same store).
  const engine2 = new AdmissionEngine(f.store, f.capture, { sessionId: f.sessionId, attemptId: f.attemptId });
  await assert.rejects(
    engine2.callWithHandle(actionId, { stepId: "s" }, () => { invocations++; return "replay"; }),
    HandleAlreadyUsedError,
  );
  assert.equal(invocations, 1);
  await f.store.close();
});

test("deliberate retry after failure gets a new identity, original failure preserved", async () => {
  const f = await fixture();
  let attempts = 0;
  const first = f.engine.allocateAction({ stepId: "retry", title: "First try" });
  await assert.rejects(
    f.engine.callWithHandle(first, { stepId: "retry" }, () => {
      attempts++;
      throw new Error("transient UI miss");
    }),
    /transient UI miss/,
  );
  // Deliberate retry: NEW handle, linked by the same stepId.
  const second = f.engine.allocateAction({ stepId: "retry", title: "Retry" });
  assert.notEqual(first, second, "retry has its own identity");
  const value = await f.engine.callWithHandle(second, { stepId: "retry" }, () => { attempts++; return "recovered"; });
  assert.equal(value, "recovered");
  assert.equal(attempts, 2);

  // Both attempts are individually in the history with the original error.
  const history = await f.store.journalHistory();
  const completions = history.records.filter((r) => r.kind === "action-completion");
  const failure = completions.find((r) => (r as { toolOutcome?: { kind?: string } }).toolOutcome?.kind === "failure");
  assert.ok(failure, "original failure retained");
  assert.equal((failure as { toolOutcome: { error: { message: string } } }).toolOutcome.error.message, "transient UI miss");
  const starts = history.records.filter((r) => r.kind === "action-start");
  assert.equal(starts.length, 2, "two attempts, two start records");
  await f.store.close();
});

test("combined failure: backend exception is not masked by receipt bookkeeping", async () => {
  const f = await fixture();
  // The callable throws a rich error; the engine must rethrow it as-is.
  const backendError = new Error("SCStream teardown failed");
  (backendError as Error & { code: string }).code = "ESCSTREAM";
  await assert.rejects(
    f.engine.call({ stepId: "combo" }, () => { throw backendError; }),
    (err: unknown) => err === backendError || ((err as Error).message === "SCStream teardown failed" && (err as { code?: string }).code === "ESCSTREAM"),
  );
  await f.store.close();
});

test("CLI process interval is distinct from its inner actions", async () => {
  const f = await fixture();
  // One engine.call wraps the whole CLI process; inner steps are attributed
  // to the same action window via the journal's per-record timestamps.
  const cliActionId = f.engine.allocateAction({ stepId: "cli-run", title: "Run walkthrough.py" });
  await f.engine.callWithHandle(cliActionId, { stepId: "cli-run" }, async () => {
    // Simulate the process's inner actions journaled under the same session.
    await f.store.appendJournal({ kind: "action-start", sessionId: f.sessionId, attemptId: f.attemptId, stepId: "inner-click", actionId: "action-inner-1", state: "admitted" });
    await f.store.appendJournal({ kind: "action-completion", sessionId: f.sessionId, attemptId: f.attemptId, stepId: "inner-click", actionId: "action-inner-1", state: "recorded" });
    return "cli done";
  });
  const history = await f.store.journalHistory();
  const cliStart = history.records.find((r) => (r as { actionId?: string }).actionId === cliActionId && r.kind === "action-start");
  const innerStart = history.records.find((r) => (r as { actionId?: string }).actionId === "action-inner-1" && r.kind === "action-start");
  assert.ok(cliStart && innerStart);
  // Distinct identities: the CLI interval and the inner action are separate records.
  assert.notEqual((cliStart as { actionId: string }).actionId, (innerStart as { actionId: string }).actionId);
  // The CLI completion comes after the inner action's completion in journal order.
  const cliCompletionIdx = history.records.findIndex((r) => (r as { actionId?: string }).actionId === cliActionId && r.kind === "action-completion");
  const innerCompletionIdx = history.records.findIndex((r) => (r as { actionId?: string }).actionId === "action-inner-1" && r.kind === "action-completion");
  assert.ok(innerCompletionIdx < cliCompletionIdx, "inner action completes within the CLI interval");
  await f.store.close();
});
