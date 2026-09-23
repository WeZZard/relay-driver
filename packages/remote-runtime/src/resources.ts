/**
 * Resource budgets and live accounting (D19).
 *
 * Task storage budget and per-execution output caps with ATOMIC byte
 * reservations: a chunk is counted (committed + reserved) before it is
 * accepted, so two concurrent producers can never spend the same remaining
 * capacity. Refusal happens BEFORE ordinary use can consume the protected
 * shutdown allowance (R_stop). Relay-controlled buffers are strictly bounded
 * here; external processes (recorder, tool children) are observed and
 * reported, with their actual enforcement stated honestly — a watched
 * threshold is NOT an OS-enforced quota.
 *
 * Separate diagnostics are retained for: the limit reached, observed usage,
 * the configured threshold, and the resulting refusal/stop.
 */

import { statfs } from "node:fs/promises";

export interface ResourceBudgets {
  /** Total task storage budget in bytes (B_task). */
  taskStorageBytes: number;
  /** Protected shutdown allowance in bytes (R_stop) — never spent by ordinary work. */
  stopAllowanceBytes: number;
  /** Per-execution output cap in bytes. */
  perExecutionOutputBytes: number;
  /** Aggregate cap for all Relay-controlled buffers/queues in bytes. */
  relayBufferBytes: number;
  /** Environment free-space floor in bytes (H). */
  volumeFloorBytes: number;
  /** Volumes the task may write (for statfs sampling). */
  volumePaths: readonly string[];
  /** Maximum intended monitoring interval in ms (delta_poll). */
  pollIntervalMs: number;
}

export interface ResourceObservation {
  readonly atMonotonic: number;
  /** Committed + reserved task bytes. */
  readonly taskCommittedBytes: number;
  /** statfs available bytes on the primary volume (may be undefined if sampling failed). */
  readonly volumeAvailableBytes?: number;
  /** Sum of reserved-but-unwritten bytes. */
  readonly pendingBytes: number;
}

/** Why a reservation or admission was refused. */
export type ResourceRefusalKind =
  | "per-execution-output-cap"
  | "task-storage-cap"
  | "relay-buffer-cap"
  | "volume-capacity"
  | "shutdown-allowance";

export class ResourceRefusedError extends Error {
  constructor(
    readonly kind: ResourceRefusalKind,
    readonly diagnostic: string,
    /** Observed usage at refusal time. */
    readonly observation: ResourceObservation | undefined,
  ) {
    super(`resource limit reached (${kind}): ${diagnostic}`);
    this.name = "ResourceRefusedError";
  }
}

interface ExecutionAccount {
  committed: number;
  reserved: number;
}

export class ResourceManager {
  private taskCommitted = 0;
  private taskReserved = 0;
  private bufferCommitted = 0;
  private readonly executions = new Map<string, ExecutionAccount>();
  private stopped = false;
  private stopDiagnostic: string | undefined;
  private lastObservation: ResourceObservation | undefined;

  constructor(private readonly budgets: ResourceBudgets) {}

  /** B_work minus safety: the bytes ordinary work may still spend. */
  get ordinaryWorkHeadroomBytes(): number {
    const budgetHeadroom = this.budgets.taskStorageBytes - (this.taskCommitted + this.taskReserved);
    return budgetHeadroom - this.budgets.stopAllowanceBytes;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get stopReason(): string | undefined {
    return this.stopDiagnostic;
  }

  /** Current observation (last sampled; callers should ensure freshness). */
  get lastSample(): ResourceObservation | undefined {
    return this.lastObservation;
  }

  /**
   * Atomic reservation against the per-execution output cap and the task
   * budget. Either the whole chunk is reserved or nothing changes. Refuses
   * before the next chunk would enter the shutdown allowance.
   */
  reserveOutput(executionId: string, chunkBytes: number, threshold = this.budgets.perExecutionOutputBytes): void {
    this.assertNotStopped();
    const account = this.executions.get(executionId) ?? { committed: 0, reserved: 0 };
    const totalForExecution = account.committed + account.reserved + chunkBytes;
    if (totalForExecution > threshold) {
      throw new ResourceRefusedError(
        "per-execution-output-cap",
        `execution ${executionId} output would reach ${totalForExecution} bytes; cap is ${threshold}`,
        this.lastObservation,
      );
    }
    const taskTotal = this.taskCommitted + this.taskReserved + chunkBytes;
    if (taskTotal > this.budgets.taskStorageBytes - this.budgets.stopAllowanceBytes) {
      throw new ResourceRefusedError(
        "shutdown-allowance",
        `task accounting would enter the protected shutdown allowance: ${taskTotal} bytes with stop allowance ${this.budgets.stopAllowanceBytes}`,
        this.lastObservation,
      );
    }
    this.executions.set(executionId, { ...account, reserved: account.reserved + chunkBytes });
    this.taskReserved += chunkBytes;
  }

  /** Commit a previously reserved chunk (bytes are now durably written). */
  commitReserved(executionId: string, chunkBytes: number): void {
    const account = this.executions.get(executionId);
    if (!account || account.reserved < chunkBytes) {
      throw new Error(`no matching reservation for execution ${executionId} (${chunkBytes} bytes)`);
    }
    this.executions.set(executionId, {
      committed: account.committed + chunkBytes,
      reserved: account.reserved - chunkBytes,
    });
    this.taskReserved -= chunkBytes;
    this.taskCommitted += chunkBytes;
  }

  /** Release a reservation without committing (e.g. the write failed). */
  releaseReservation(executionId: string, chunkBytes: number): void {
    const account = this.executions.get(executionId);
    if (!account || account.reserved < chunkBytes) return;
    this.executions.set(executionId, { ...account, reserved: account.reserved - chunkBytes });
    this.taskReserved -= chunkBytes;
  }

  /**
   * Reserve against the aggregate Relay buffer cap (queues, in-flight
   * frames). Strictly bounded: refuses before enqueue.
   */
  reserveBuffer(bytes: number, cap = this.budgets.relayBufferBytes): void {
    this.assertNotStopped();
    if (this.bufferCommitted + bytes > cap) {
      throw new ResourceRefusedError(
        "relay-buffer-cap",
        `relay buffers would reach ${this.bufferCommitted + bytes} bytes; cap is ${cap}`,
        this.lastObservation,
      );
    }
    this.bufferCommitted += bytes;
  }

  releaseBuffer(bytes: number): void {
    this.bufferCommitted = Math.max(0, this.bufferCommitted - bytes);
  }

  get bufferUsageBytes(): number {
    return this.bufferCommitted;
  }

  /**
   * Sample actual volume capacity. Refusal when available bytes minus
   * pending unallocated writes would enter H + R_stop.
   */
  async sampleVolume(): Promise<ResourceObservation> {
    const primary = this.budgets.volumePaths[0];
    let volumeAvailableBytes: number | undefined;
    if (primary) {
      try {
        const s = await statfs(primary);
        volumeAvailableBytes = Number(s.bavail) * Number(s.bsize);
      } catch {
        // Sampling failure is recorded as absent; staleness checks handle it.
      }
    }
    const observation: ResourceObservation = {
      atMonotonic: Date.now(),
      taskCommittedBytes: this.taskCommitted + this.taskReserved,
      pendingBytes: this.taskReserved,
      volumeAvailableBytes,
    };
    this.lastObservation = observation;
    return observation;
  }

  /**
   * Volume-capacity stop check: refuses when available bytes (less pending
   * unallocated writes) reach H + R_stop. Call periodically and before
   * admitting another action.
   */
  checkVolumeCapacity(observation: ResourceObservation = this.lastObservation ?? ({} as ResourceObservation)): void {
    this.assertNotStopped();
    const available = observation.volumeAvailableBytes;
    if (available === undefined) return; // no sample: staleness handled elsewhere
    const effective = available - observation.pendingBytes;
    const floor = this.budgets.volumeFloorBytes + this.budgets.stopAllowanceBytes;
    if (effective <= floor) {
      throw new ResourceRefusedError(
        "volume-capacity",
        `volume headroom ${effective} bytes would enter floor+stop (${floor} bytes)`,
        observation,
      );
    }
  }

  /**
   * Declare a stop: close input admission first, retain the diagnostic.
   * Owned work is cancelled by the caller (supervisor); evidence is retained
   * and the diagnostic stays in the protected allowance.
   */
  declareStop(diagnostic: string): void {
    this.stopped = true;
    this.stopDiagnostic = diagnostic;
  }

  private assertNotStopped(): void {
    if (this.stopped) {
      throw new ResourceRefusedError(
        "task-storage-cap",
        `resource stop already declared: ${this.stopDiagnostic ?? "unspecified"}`,
        this.lastObservation,
      );
    }
  }
}

/**
 * The remote supervisor: samples resources and capture health on an interval
 * INDEPENDENT of SSH and of the tool script's event loop (its own timer on
 * the runtime process, plus a monotonic task deadline). On any stop trigger
 * it closes admission first, records the diagnostic, and invokes the stop
 * callback so owned work is cancelled.
 */
export class Supervisor {
  private timer: NodeJS.Timeout | undefined;
  private lastFreshAt = 0;
  private stopped = false;

  constructor(
    private readonly resources: ResourceManager,
    private readonly config: {
      readonly deadlineAtMonotonic: number;
      readonly pollIntervalMs: number;
      readonly maxObservationAgeMs: number;
      readonly onSample: () => Promise<{ healthy: boolean; diagnostic?: string }>;
      readonly onStop: (diagnostic: string) => Promise<void> | void;
      readonly now?: () => number;
    },
  ) {}

  static start(resources: ResourceManager, options: ConstructorParameters<typeof Supervisor>[1]): Supervisor {
    const supervisor = new Supervisor(resources, options);
    supervisor.lastFreshAt = (options.now ?? Date.now)();
    supervisor.timer = setInterval(() => {
      void supervisor.tick();
    }, options.pollIntervalMs);
    supervisor.timer.unref?.();
    return supervisor;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const now = (this.config.now ?? Date.now)();
    try {
      // 1. Monotonic task deadline (independent of host connectivity).
      if (now >= this.config.deadlineAtMonotonic) {
        await this.stop("task deadline expired");
        return;
      }
      // 2. Sample resources + capture health through the injected observer.
      const sample = await this.config.onSample();
      if (!sample.healthy) {
        await this.stop(sample.diagnostic ?? "supervised health check failed");
        return;
      }
      this.resources.checkVolumeCapacity();
      if (this.resources.isStopped) {
        await this.stop(this.resources.stopReason ?? "resource manager stopped");
        return;
      }
      this.lastFreshAt = now;
    } catch (err) {
      await this.stop(err instanceof Error ? err.message : String(err));
    }
  }

  private async stop(diagnostic: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.resources.declareStop(diagnostic);
    // Close input admission first, then cancel owned work via the callback.
    await this.config.onStop(diagnostic);
  }

  /** Supervision freshness: stale observations refuse further input. */
  get isFresh(): boolean {
    const age = (this.config.now ?? Date.now)() - this.lastFreshAt;
    return age <= this.config.maxObservationAgeMs;
  }

  get stalenessDiagnostic(): string | undefined {
    return this.isFresh ? undefined : `supervision observations are stale (>${this.config.maxObservationAgeMs} ms)`;
  }

  stopWatching(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
}
