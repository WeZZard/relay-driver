/**
 * Script-side SDK (SCRIPT-01): recorded-call semantics for scripts deployed
 * or streamed to the remote. A script imports this module in-process, points
 * it at the runtime's record-store directory, and wraps each of its
 * individual tool calls. Every call goes through the same admission engine
 * (durable action-start before invocation, completion retention after, D15/
 * D17) as a directly submitted operation, and each record cites the script
 * execution as its parent identity. One receipt per call establishes
 * individual-action coverage; a receipt around the whole script cannot.
 */
import { RecordStore, SnapshotStore, CaptureGate, AdmissionEngine, AdmissionRefusedError, HandleAlreadyUsedError, EvidenceWriteError } from "@wezzard/relay-driver-remote-runtime";
import { join } from "node:path";

export interface StepDescription {
  readonly id: string;
  readonly title: string;
  readonly expected?: string;
  readonly inputMode?: "ordinary" | "accessibility";
}

export interface ScriptRelayOptions {
  /** Runtime state directory (the one receive.js uses: ROOT/state). */
  readonly stateDir: string;
  /** The script execution identity that owns these recorded calls. */
  readonly parentExecutionId: string;
  readonly sessionId?: string;
  readonly attemptId?: string;
  /**
   * Snapshot capture integration (SNAP-01/02): when supplied, recordedCall
   * snapshot requests are honored through a SnapshotStore rooted at
   * <stateDir>; when absent, snapshot requests are refused by the admission
   * engine ("no snapshot store configured") — never silently dropped.
   */
  readonly snapshotCapture?: (outFile: string) => Promise<void>;
}

export class ScriptRelay {
  private readonly engine: Promise<AdmissionEngine>;
  private readonly capture = new CaptureGate();

  constructor(private readonly options: ScriptRelayOptions) {
    this.engine = (async () => {
      const store = await RecordStore.create(join(options.stateDir));
      return new AdmissionEngine(
        store,
        this.capture,
        {
          sessionId: options.sessionId ?? "session-unframed",
          attemptId: options.attemptId ?? "attempt-unframed",
        },
        options.snapshotCapture
          ? new SnapshotStore(options.snapshotCapture, store, options.stateDir)
          : undefined,
      );
    })();
  }

  /**
   * Observe capture health before the first recorded call and after any
   * interruption (the same freshness contract the runtime applies). Inside
   * a deployed/streamed script the recorder is the runtime's own; the
   * script observes the recording state it was launched under.
   */
  observeCapture(health: { recording: boolean; segmentId?: string; diagnostic?: string }): void {
    this.capture.update({
      recording: health.recording,
      segmentId: health.segmentId,
      diagnostic: health.diagnostic,
      observedAtMonotonic: Date.now(),
    });
  }

  /** Report capture loss; disables input immediately (D15). */
  reportCaptureLoss(diagnostic: string): void {
    this.capture.reportLoss(diagnostic);
  }

  /**
   * Grouped narrative step: describe the step once and run its recorded
   * operations inside. The operations themselves each receive their own
   * admission and receipt; the step description supplies shared context.
   */
  async step<T>(description: StepDescription, body: (relay: ScriptRelay) => Promise<T> | T): Promise<T> {
    // The step description rides on each recorded call made within the body
    // so every receipt carries the shared narrative context.
    this.currentStep = description;
    try {
      return await body(this);
    } finally {
      this.currentStep = undefined;
    }
  }

  private currentStep: StepDescription | undefined;

  /**
   * Record one call: admission is requested, the start is durably retained,
   * the callable runs exactly once, the completion is retained, and the
   * original value or exception is preserved. A refused admission never
   * invokes the callable.
   */
  async recordedCall<T>(
    callable: () => Promise<T> | T,
    call?: {
      title?: string;
      inputMode?: "ordinary" | "accessibility";
      /** Snapshot evidence contract (SNAP-01/02/03): agent-supplied interval. */
      snapshots?: {
        afterIntervalMs?: number;
        group?: { groupId: string; phase: "first" | "member" | "last"; afterIntervalMs?: number };
      };
      dispatchIdentity?: string;
    },
  ): Promise<T> {
    const engine = await this.engine;
    const step = this.currentStep;
    return engine.call(
      {
        stepId: step?.id,
        title: call?.title ?? step?.title ?? "script recorded call",
        inputMode: call?.inputMode ?? step?.inputMode,
        parentExecutionId: this.options.parentExecutionId,
        snapshots: call?.snapshots,
        dispatchIdentity: call?.dispatchIdentity ?? call?.title ?? step?.title,
      },
      callable,
    );
  }
}

export { AdmissionRefusedError, HandleAlreadyUsedError, EvidenceWriteError };
