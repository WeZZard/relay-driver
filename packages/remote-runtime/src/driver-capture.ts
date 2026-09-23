/**
 * Driver-side display capture (SNAP-01/02): the capture fn handed to the
 * SnapshotStore by receive.ts. Extracted from receive.ts so the error
 * contract is unit-testable without the driver.
 */
import { SnapshotCaptureError } from "./snapshots.js";

/** Minimal shape of a cua-driver tool call result. */
export interface CuaCallResult {
  readonly ok: boolean;
  readonly raw?: { stderr?: string };
  /** Driver tool response; capture only keys on screenshot_file_path. */
  readonly value?: { screenshot_file_path?: string } & Record<string, unknown>;
}

export type CuaCallFn = (tool: string, argsJson: string) => Promise<CuaCallResult>;

/**
 * Capture a full-display PNG to the given file via the driver.
 *
 * Error contract (pinned by tests): a failed driver call throws
 * SnapshotCaptureError with message `display capture unavailable: <detail>`
 * (detail = trimmed driver stderr, or "driver call failed"); a successful
 * call that returns no screenshot_file_path throws SnapshotCaptureError
 * with message `display capture returned no screenshot_file_path`.
 */
export async function captureDisplayToFile(outFile: string, cuaCall: CuaCallFn): Promise<void> {
  const result = await cuaCall(
    "get_desktop_state",
    JSON.stringify({ screenshot_out_file: outFile }),
  );
  if (!result.ok) {
    const detail = result.raw?.stderr?.trim() ?? "driver call failed";
    throw new SnapshotCaptureError(`display capture unavailable: ${detail}`);
  }
  const path = result.value?.screenshot_file_path;
  if (!path) {
    throw new SnapshotCaptureError("display capture returned no screenshot_file_path");
  }
}
