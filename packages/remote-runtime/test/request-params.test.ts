/**
 * Unit tests for framed-request snapshot-param normalization (gap #3).
 * These were previously inlined in receive.ts with zero direct coverage.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { snapshotsParamsOf } from "../src/request-params.js";

test("no snapshots on request or step yields undefined", () => {
  assert.equal(snapshotsParamsOf({}), undefined);
  assert.equal(snapshotsParamsOf({ snapshots: undefined }), undefined);
  assert.equal(snapshotsParamsOf({ step: { title: "click" } }), undefined);
  assert.equal(snapshotsParamsOf({ snapshots: null }), undefined);
});

test("request.snapshots is the primary source", () => {
  const p = snapshotsParamsOf({ snapshots: { afterIntervalMs: 700 } });
  assert.deepEqual(p, { afterIntervalMs: 700 });
});

test("request.step.snapshots is the step-level fallback", () => {
  const p = snapshotsParamsOf({
    step: { title: "click", snapshots: { afterIntervalMs: 250 } },
  });
  assert.deepEqual(p, { afterIntervalMs: 250 });
});

test("request.snapshots wins over request.step.snapshots", () => {
  const p = snapshotsParamsOf({
    snapshots: { afterIntervalMs: 1 },
    step: { snapshots: { afterIntervalMs: 2 } },
  });
  assert.deepEqual(p, { afterIntervalMs: 1 });
});

test("non-numeric afterIntervalMs is dropped, not coerced", () => {
  // A string interval must not survive as a number (the admission engine's
  // refusal logic keys on the field's absence, not its type).
  const p = snapshotsParamsOf({ snapshots: { afterIntervalMs: "700" } });
  assert.deepEqual(p, {});
  assert.equal(p!.afterIntervalMs, undefined);
});

test("group: missing phase normalizes to member", () => {
  const p = snapshotsParamsOf({
    snapshots: { group: { groupId: "grp-hello" } },
  });
  assert.ok(p?.group);
  assert.equal(p.group.phase, "member");
  assert.equal(p.group.groupId, "grp-hello");
  assert.equal(p.group.afterIntervalMs, undefined);
});

test("group: explicit phases pass through", () => {
  for (const phase of ["first", "member", "last"] as const) {
    const p = snapshotsParamsOf({
      snapshots: { group: { groupId: "g", phase } },
    });
    assert.equal(p?.group?.phase, phase);
  }
});

test("group: last member carries the group interval", () => {
  const p = snapshotsParamsOf({
    snapshots: { group: { groupId: "g", phase: "last", afterIntervalMs: 900 } },
  });
  assert.deepEqual(p?.group, { groupId: "g", phase: "last", afterIntervalMs: 900 });
});

test("group: non-numeric group interval dropped", () => {
  const p = snapshotsParamsOf({
    snapshots: { group: { groupId: "g", phase: "last", afterIntervalMs: "900" } },
  });
  assert.ok(p?.group);
  assert.equal(p.group.afterIntervalMs, undefined);
});

test("group without groupId is not a group", () => {
  const p = snapshotsParamsOf({ snapshots: { group: { phase: "first" } } });
  assert.equal(p?.group, undefined);
});

test("terminal event with interval + no group passes through intact", () => {
  const p = snapshotsParamsOf({
    snapshots: { afterIntervalMs: 1200, group: undefined },
  });
  assert.deepEqual(p, { afterIntervalMs: 1200 });
});
