/**
 * Unit tests for the CLI snapshot-flag mapping (gap #5).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { snapshotsRequestFromOptions } from "../src/snapshot-flags.js";

test("--after-interval alone maps to the single-event form", () => {
  assert.deepEqual(snapshotsRequestFromOptions("800", undefined, undefined), {
    afterIntervalMs: 800,
  });
});

test("--group-id + --group-phase + interval maps to the group form with the interval in the group", () => {
  assert.deepEqual(
    snapshotsRequestFromOptions("900", "grp-hello", "last"),
    { group: { groupId: "grp-hello", phase: "last", afterIntervalMs: 900 } },
  );
});

test("--group-id without phase defaults to member", () => {
  assert.deepEqual(
    snapshotsRequestFromOptions(undefined, "grp-hello", undefined),
    { group: { groupId: "grp-hello", phase: "member", afterIntervalMs: undefined } },
  );
});

test("neither flag maps to undefined (no snapshot evidence requested)", () => {
  assert.equal(snapshotsRequestFromOptions(undefined, undefined, undefined), undefined);
});

test("group member with interval: interval lives inside the group", () => {
  const r = snapshotsRequestFromOptions("700", "grp-hello", "first");
  assert.deepEqual(r, {
    group: { groupId: "grp-hello", phase: "first", afterIntervalMs: 700 },
  });
  assert.equal((r as { afterIntervalMs?: number }).afterIntervalMs, undefined,
    "top-level afterIntervalMs must not appear on the group form");
});

test("phase passthrough for first/member/last", () => {
  for (const phase of ["first", "member", "last"]) {
    const r = snapshotsRequestFromOptions(undefined, "g", phase);
    assert.deepEqual(r, { group: { groupId: "g", phase, afterIntervalMs: undefined } });
  }
});
