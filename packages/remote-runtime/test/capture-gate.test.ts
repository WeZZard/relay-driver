/**
 * Unit tests for the CaptureGate's screenshot-capability semantics (gap #6,
 * SNAP-01): admission derives solely from capability health — never from
 * recording segments, and the refusal diagnostic is pinned so downstream
 * evidence text cannot drift silently.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CaptureGate } from "../src/capture-gate.js";

test("capability loss reports the exact pinned diagnostic", () => {
  const gate = new CaptureGate();
  gate.reportLoss("screen locked");
  assert.equal(gate.checkAdmission(), "capture unavailable: screen locked");
});

test("unhealthy observation without a diagnostic uses the pinned default", () => {
  const gate = new CaptureGate();
  gate.update({ ready: false, observedAtMonotonic: Date.now() });
  assert.equal(
    gate.checkAdmission(),
    "capture unavailable: display screenshot capability not available",
  );
});

test("ready capability admits input", () => {
  const gate = new CaptureGate();
  gate.update({ ready: true, observedAtMonotonic: Date.now() });
  assert.equal(gate.checkAdmission(), undefined);
});

test("legacy `recording` field name still admits and is overridden by `ready`", () => {
  const legacy = new CaptureGate();
  legacy.update({ recording: true, observedAtMonotonic: Date.now() });
  assert.equal(legacy.checkAdmission(), undefined, "back-compat: recording: true admits");
  const both = new CaptureGate();
  both.update({ ready: true, recording: false, observedAtMonotonic: Date.now() });
  assert.equal(both.checkAdmission(), undefined, "ready wins over recording");
  const legacyOff = new CaptureGate();
  legacyOff.update({ recording: false, observedAtMonotonic: Date.now() });
  assert.match(legacyOff.checkAdmission()!, /^capture unavailable: /);
});

test("admission derives ONLY from capability health, never from segment identity", () => {
  const gate = new CaptureGate();
  // A segmentId present with ready:false must NOT admit.
  gate.update({ ready: false, segmentId: "seg-1", observedAtMonotonic: Date.now() });
  assert.match(gate.checkAdmission()!, /^capture unavailable: /);
  // currentSegmentId is gated on readiness, not on segment presence.
  assert.equal(gate.currentSegmentId, undefined);
  gate.update({ ready: true, segmentId: "seg-2", observedAtMonotonic: Date.now() });
  assert.equal(gate.currentSegmentId, "seg-2");
  gate.update({ ready: true, observedAtMonotonic: Date.now() });
  assert.equal(gate.currentSegmentId, undefined);
});

test("stale capability observation refuses regardless of reported readiness", () => {
  const gate = new CaptureGate(50);
  gate.update({ ready: true, observedAtMonotonic: Date.now() - 51 });
  assert.match(gate.checkAdmission()!, /^capture health observation is stale/);
});

test("no observation yet refuses input outright", () => {
  const gate = new CaptureGate();
  assert.equal(gate.checkAdmission(), "capture health not yet observed");
});
