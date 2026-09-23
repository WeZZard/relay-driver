/**
 * Capture readiness gate — screenshot-capability based (SNAP-01).
 *
 * Contract (2026-09-11 snapshot-evidence decision): Relay Driver's built-in
 * evidence is per-event dispatch-time snapshot PAIRS. There is no continuous
 * recording requirement; admission depends on the ability to take a display
 * screenshot right now, not on an active recording segment. Video is an
 * application-level attachment and is never probed here.
 *
 * Evidence-write failure and capture loss immediately disable further input
 * (D17, D4). The gate consumes whatever capability source the capture
 * integration supplies.
 */

export interface CaptureHealth {
  /** True when a display screenshot can be captured right now. */
  readonly ready?: boolean;
  /**
   * @deprecated legacy field name from the recording era; use `ready`.
   * Accepted for back-compat; ignored when `ready` is present.
   */
  readonly recording?: boolean;
  /**
   * Capability-source identity (e.g. capture scope/display reported by the
   * driver). Evidence context only; admission no longer keys on segments.
   */
  readonly segmentId?: string;
  /** Human-readable diagnostic when not healthy. */
  readonly diagnostic?: string;
  /** When this observation was taken (remote monotonic ms). */
  readonly observedAtMonotonic: number;
}

/** Resolved readiness from a health observation (accepts the legacy name). */
function readinessOf(health: CaptureHealth): boolean {
  return health.ready ?? health.recording ?? false;
}

/** Maximum staleness of a capability observation before input must be refused. */
export const DEFAULT_MAX_HEALTH_AGE_MS = 2_000;

export class CaptureGate {
  private health: CaptureHealth | undefined;

  constructor(
    private readonly maxHealthAgeMs: number = DEFAULT_MAX_HEALTH_AGE_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Called by the capture integration (or its failure callback). */
  update(health: CaptureHealth): void {
    this.health = health;
  }

  /** Called when capture capability loss is detected; disables input immediately. */
  reportLoss(diagnostic: string): void {
    this.health = {
      ready: false,
      diagnostic,
      observedAtMonotonic: this.now(),
    };
  }

  /**
   * Admission check before each operation. Returns a refusal diagnostic when
   * input must not be dispatched; undefined when screenshot capability is ready.
   */
  checkAdmission(): string | undefined {
    const health = this.health;
    if (!health) return "capture health not yet observed";
    const age = this.now() - health.observedAtMonotonic;
    if (age > this.maxHealthAgeMs) {
      return `capture health observation is stale (${age} ms old)`;
    }
    if (!readinessOf(health)) {
      return `capture unavailable: ${health.diagnostic ?? "display screenshot capability not available"}`;
    }
    return undefined;
  }

  get currentSegmentId(): string | undefined {
    return this.health && readinessOf(this.health) ? this.health.segmentId : undefined;
  }
}
