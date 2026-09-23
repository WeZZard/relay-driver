/**
 * Unit tests for the driver-side display-capture error contract (gap #3
 * follow-up): SnapshotCaptureError message shapes thrown by the capture fn
 * the SnapshotStore invokes, pinned verbatim.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { captureDisplayToFile } from "../src/driver-capture.js";
import { SnapshotCaptureError } from "../src/snapshots.js";

test("failed driver call -> SnapshotCaptureError 'display capture unavailable: <trimmed stderr>'", async () => {
  let thrown: unknown;
  try {
    await captureDisplayToFile("/tmp/out.png", async () => ({
      ok: false,
      raw: { stderr: "  protected_resource_scope_invalid  \n" },
    }));
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown instanceof SnapshotCaptureError, "must be a SnapshotCaptureError");
  assert.equal(
    (thrown as SnapshotCaptureError).message,
    "display capture unavailable: protected_resource_scope_invalid",
  );
});

test("failed driver call without stderr uses the 'driver call failed' detail", async () => {
  let thrown: unknown;
  try {
    await captureDisplayToFile("/tmp/out.png", async () => ({ ok: false }));
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown instanceof SnapshotCaptureError);
  assert.equal((thrown as SnapshotCaptureError).message, "display capture unavailable: driver call failed");
});

test("successful call without screenshot_file_path is a pinned SnapshotCaptureError", async () => {
  let thrown: unknown;
  try {
    await captureDisplayToFile("/tmp/out.png", async () => ({
      ok: true,
      value: { screen_width: 1920 },
    }));
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown instanceof SnapshotCaptureError);
  assert.equal(
    (thrown as SnapshotCaptureError).message,
    "display capture returned no screenshot_file_path",
  );
});

test("successful call with a screenshot_file_path resolves without throwing", async () => {
  await assert.doesNotReject(
    captureDisplayToFile("/tmp/out.png", async () => ({
      ok: true,
      value: { screenshot_file_path: "/tmp/out.png" },
    })),
  );
});
