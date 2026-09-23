/**
 * CLI snapshot-flag mapping (SNAP-02/03) as a pure helper.
 *
 * Extracted from main.ts's ssh command so the flag surface is unit-testable
 * without a transport. The CLI's --after-interval/--group-id/--group-phase
 * flags map onto the host-SDK SnapshotsRequest exactly once, here.
 */
import type { SnapshotsRequest } from "@wezzard/relay-driver-host-sdk";

export type GroupPhase = "first" | "member" | "last";

/**
 * Map CLI flag values to the SnapshotsRequest carried on the framed request.
 *
 * - --after-interval MS alone            → { afterIntervalMs: MS }
 * - --group-id ID [--group-phase PH]     → { group: { groupId: ID, phase: PH ?? "member", ... } }
 * - both                                 → group form, interval inside the group (the group's
 *                                          terminal member carries it)
 * - neither                              → undefined (no snapshot evidence requested)
 */
export function snapshotsRequestFromOptions(
  afterInterval: string | undefined,
  groupId: string | undefined,
  groupPhase: string | undefined,
): SnapshotsRequest | undefined {
  if (!afterInterval && !groupId) return undefined;
  return groupId
    ? {
        group: {
          groupId,
          phase: (groupPhase as GroupPhase | undefined) ?? "member",
          afterIntervalMs: afterInterval !== undefined ? Number(afterInterval) : undefined,
        },
      }
    : { afterIntervalMs: Number(afterInterval) };
}
