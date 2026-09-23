/**
 * Request-shape normalization for framed requests (SNAP-02/03).
 *
 * Extracted from receive.ts so the request-shape contract is unit-testable
 * without spinning up the full receive loop. The receive loop imports this
 * module; tsconfig.receive.json bundles it into dist-root receive.js.
 */
import type { SnapshotParams } from "./snapshots.js";

/**
 * Extract the snapshot params from a framed request (SNAP-02/03): the
 * REQUIRED agent-supplied afterIntervalMs and the optional sender-declared
 * coalescing group. Requests carrying step snapshots without an interval or
 * group declaration are refused by the admission engine before dispatch.
 */
export function snapshotsParamsOf(request: any): SnapshotParams | undefined {
  const s = request.snapshots ?? request.step?.snapshots;
  if (!s) return undefined;
  // The framed request may drop optional fields; normalize to the runtime shape.
  const out: {
    afterIntervalMs?: number;
    group?: { groupId: string; phase: "first" | "member" | "last"; afterIntervalMs?: number };
  } = {};
  if (typeof s.afterIntervalMs === "number") out.afterIntervalMs = s.afterIntervalMs;
  if (s.group && typeof s.group.groupId === "string") {
    out.group = {
      groupId: s.group.groupId,
      phase: (s.group.phase ?? "member") as "first" | "member" | "last",
      afterIntervalMs: typeof s.group.afterIntervalMs === "number" ? s.group.afterIntervalMs : undefined,
    };
  }
  return out;
}
