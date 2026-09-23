/**
 * Dispatch-time snapshot evidence (SNAP-01/02/03).
 *
 * Contract (2026-09-11 snapshot-evidence decision):
 * - Before-snapshot: captured immediately BEFORE the input event dispatches.
 * - After-snapshot: captured EXACTLY `afterIntervalMs` after dispatch
 *   completion. The interval is REQUIRED, supplied by the agent per event
 *   (or per coalescing group); the runtime waits precisely that long — no
 *   settle detection, no defaults, no tool-side opinion about the screen.
 * - The before/after pair is the causal proof: after shows the effect,
 *   before establishes the baseline it is attributed against. Near-identical
 *   frames are acceptable; deduplication is never performed.
 * - Naming: `<seq>-<ISO8601Z>-<dispatch-identity>.png` — chronological
 *   prefix sorts files correctly and binds to journal records.
 * - Files are hashed at capture; capture start/complete times are recorded
 *   so provenance states what the image actually represents.
 * - Capture failure = journaled refusal (admission-time refusal for the
 *   before-snapshot; post-dispatch capture failure marks uncertainty).
 */

import { mkdir, stat, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { RecordStore } from "./record-store.js";

/** One dispatch-time capture with full provenance. */
export interface Snapshot {
  /** Package-relative file name (within the session's snapshots dir). */
  readonly fileName: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Monotonic ms at capture start (before the driver call). */
  readonly captureStartedAtMonotonic: number;
  /** Monotonic ms when the file was on disk and hashed. */
  readonly captureCompletedAtMonotonic: number;
  /** Wall-clock at capture start (ISO-8601). */
  readonly capturedAt: string;
  /** Role in the causal pair. */
  readonly role: "before" | "after";
  /** Declared interval the after-snapshot waited, when role === "after". */
  readonly declaredAfterIntervalMs?: number;
  /** Actual waited ms (may exceed declared by capture latency). */
  readonly actualWaitMs?: number;
}

/** Sender-declared text-entry coalescing group (SNAP-03). */
export interface CoalescingGroup {
  readonly groupId: string;
  /** Dispatch identity of the group (used for the shared pair's naming). */
  readonly dispatchIdentity: string;
}

/** Parameters for one event's snapshot evidence. */
export interface SnapshotParams {
  /**
   * REQUIRED for terminal events (no group): the after-snapshot waits
   * exactly this many ms after dispatch completion. Absence is a usage
   * refusal — the agent must decide the interval per event.
   */
  readonly afterIntervalMs?: number;
  /**
   * Sender-declared coalescing group: this event belongs to the group; the
   * group takes ONE before/after pair (before on the first member, after on
   * the last). Per-event `afterIntervalMs` is ignored for members (the
   * group's terminal event carries it via the group's afterIntervalMs).
   */
  readonly group?: {
    readonly groupId: string;
    /**
     * Only the FIRST member captures the before-snapshot; only the LAST
     * member captures the after-snapshot (with the group's interval).
     */
    readonly phase: "first" | "member" | "last";
    /** The group's after-snapshot interval (required on the last member). */
    readonly afterIntervalMs?: number;
  };
}

/** Captures a full-display PNG via the driver; returns the file path written. */
export type SnapshotCaptureFn = (outFile: string) => Promise<void>;

/** Identity bound into file names: journal seq + dispatch argv identity. */
export interface SnapshotIdentity {
  readonly journalSeq: number;
  readonly dispatchIdentity: string;
  readonly sessionId: string;
  readonly attemptId: string;
}

function isoStamp(d: Date): string {
  // 20260912T052233.184250Z — chronological, filesystem-safe.
  return d.toISOString().replace(/[-:]/g, "").replace(/\./g, ".").replace(/-$/, "Z");
}

export class SnapshotCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotCaptureError";
  }
}

/**
 * Snapshot evidence writer for one session. Files land under
 * `<stateRoot>/snapshots/<sessionId>/` and are referenced from action
 * records with hash-at-capture provenance.
 */
export class SnapshotStore {
  private seq = 0;

  constructor(
    private readonly capture: SnapshotCaptureFn,
    private readonly store: RecordStore,
    private readonly rootDir: string,
  ) {}

  get snapshotsDir(): string {
    return join(this.rootDir, "snapshots");
  }

  private fileNameFor(
    identity: SnapshotIdentity,
    role: "before" | "after",
    capturedAt: Date,
  ): string {
    // a000123-20260912T052233.184250Z-before-<dispatch-identity>.png
    const seqPart = `a${String(identity.journalSeq).padStart(6, "0")}`;
    const safeIdentity = identity.dispatchIdentity
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "event";
    return `${seqPart}-${isoStamp(capturedAt)}-${role}-${safeIdentity}.png`;
  }

  /** Capture one snapshot with provenance; hashes the file at capture. */
  async captureOne(
    identity: SnapshotIdentity,
    role: "before" | "after",
    declared: { afterIntervalMs?: number; waitStartMonotonic?: number } = {},
  ): Promise<Snapshot> {
    const dir = join(this.snapshotsDir, identity.sessionId);
    await mkdir(dir, { recursive: true });
    const captureStartedAtMonotonic = Date.now();
    const capturedAt = new Date(captureStartedAtMonotonic);
    const fileName = this.fileNameFor(identity, role, capturedAt);
    const tmpPath = join(dir, `.${fileName}.part`);
    const finalPath = join(dir, fileName);
    try {
      await this.capture(tmpPath);
      await rename(tmpPath, finalPath);
    } catch (err) {
      throw new SnapshotCaptureError(
        `screenshot capture failed for ${role}-snapshot: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const statInfo = await stat(finalPath);
    const sha256 = await hashFile(finalPath);
    const captureCompletedAtMonotonic = Date.now();
    return {
      fileName,
      sha256,
      bytes: statInfo.size,
      captureStartedAtMonotonic,
      captureCompletedAtMonotonic,
      capturedAt: capturedAt.toISOString(),
      role,
      declaredAfterIntervalMs: declared.afterIntervalMs,
      actualWaitMs:
        declared.waitStartMonotonic !== undefined
          ? captureStartedAtMonotonic - declared.waitStartMonotonic
          : undefined,
    };
  }

  /** Capture the before-snapshot for an event (journal seq must be pre-allocated). */
  async before(
    identity: SnapshotIdentity,
  ): Promise<Snapshot> {
    return this.captureOne(identity, "before");
  }

  /**
   * Wait exactly `afterIntervalMs` from `dispatchCompletedAtMonotonic`, then
   * capture the after-snapshot. The wait is exact per contract: no polling,
   * no stability detection.
   */
  async after(
    identity: SnapshotIdentity,
    dispatchCompletedAtMonotonic: number,
    afterIntervalMs: number,
  ): Promise<Snapshot> {
    const target = dispatchCompletedAtMonotonic + afterIntervalMs;
    const waitStartMonotonic = dispatchCompletedAtMonotonic;
    await waitUntil(target);
    return this.captureOne(
      identity,
      "after",
      { afterIntervalMs, waitStartMonotonic },
    );
  }

  nextSeq(): number {
    return ++this.seq;
  }

  setSeq(value: number): void {
    this.seq = Math.max(this.seq, value);
  }

  async close(): Promise<void> {
    // Files are closed by the capture integration per call; nothing held.
  }
}

function waitUntil(targetMonotonic: number): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      const remaining = targetMonotonic - Date.now();
      if (remaining <= 0) resolve();
      else setTimeout(tick, Math.min(remaining, 250));
    };
    tick();
  });
}

async function hashFile(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
