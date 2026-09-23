/**
 * Explicit continuation (D16).
 *
 * One operation coordinates: finalize the interrupted attempt, create a
 * related attempt, start capture, establish fresh timing/readiness, and only
 * then admit input. Each phase is recorded so an interrupted continuation is
 * recoverable without duplicate attempts. Old attempt handles stay refused.
 */

import { allocateId, formatId } from "@wezzard/relay-driver-core";
import type { RecordStore, AttemptRecord } from "./record-store.js";
import type { CaptureGate } from "./capture-gate.js";

export type ContinuationPhase =
  | "not-started"
  | "finalizing-interrupted"
  | "allocating-attempt"
  | "starting-capture"
  | "establishing-readiness"
  | "ready";

export class Continuation {
  private phase: ContinuationPhase = "not-started";

  private constructor(
    private readonly store: RecordStore,
    private readonly capture: CaptureGate,
    readonly sessionId: string,
    readonly interruptedAttemptId: string,
    readonly newAttemptId: string,
  ) {}

  static async begin(
    store: RecordStore,
    capture: CaptureGate,
    sessionId: string,
    interruptedAttemptId: string,
    reason: string,
  ): Promise<Continuation> {
    const session = await store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const interrupted = await store.getAttempt(interruptedAttemptId);
    if (!interrupted) throw new Error(`unknown attempt ${interruptedAttemptId}`);

    const attemptId = formatId(allocateId("attempt"));
    await store.appendJournal({
      kind: "continuation-phase",
      sessionId,
      attemptId,
      state: "admitted",
      phase: "allocating-attempt",
      diagnostic: reason,
      continuesAttemptId: interruptedAttemptId,
    });

    const attempt: AttemptRecord = {
      attemptId,
      sessionId,
      continuesAttemptId: interruptedAttemptId,
      state: "preparing",
      segments: [],
    };
    await store.putAttempt(attempt);
    await store.appendJournal(
      { kind: "attempt-start", sessionId, attemptId, state: "admitted" },
      { durable: true },
    );

    const continuation = new Continuation(
      store,
      capture,
      sessionId,
      interruptedAttemptId,
      attemptId,
    );
    continuation.phase = "allocating-attempt";
    return continuation;
  }

  /** Finalize the interrupted attempt so its evidence is retained. */
  async finalizeInterrupted(): Promise<void> {
    this.phase = "finalizing-interrupted";
    const interrupted = await this.store.getAttempt(this.interruptedAttemptId);
    if (interrupted && interrupted.state !== "retained") {
      await this.store.putAttempt({ ...interrupted, state: "retained" });
      await this.store.appendJournal({
        kind: "continuation-phase",
        sessionId: this.sessionId,
        attemptId: this.interruptedAttemptId,
        state: "recorded",
        phase: "finalizing-interrupted",
      });
    }
  }

  /**
   * Establish fresh capture readiness. The actual recorder start is supplied
   * by the capture integration; this records the phase and gates input until
   * the gate reports healthy recording again.
   */
  async establishReadiness(startCapture: () => Promise<{ segmentId: string }>): Promise<void> {
    this.phase = "starting-capture";
    await this.store.appendJournal({
      kind: "continuation-phase",
      sessionId: this.sessionId,
      attemptId: this.newAttemptId,
      state: "admitted",
      phase: "starting-capture",
    });
    const { segmentId } = await startCapture();
    const attempt = await this.store.getAttempt(this.newAttemptId);
    if (attempt) {
      await this.store.putAttempt({
        ...attempt,
        state: "active",
        segments: [...attempt.segments, segmentId],
      });
    }
    this.phase = "establishing-readiness";
    await this.store.appendJournal({
      kind: "continuation-phase",
      sessionId: this.sessionId,
      attemptId: this.newAttemptId,
      state: "admitted",
      phase: "establishing-readiness",
      segmentId,
    });
    this.phase = "ready";
  }

  get currentPhase(): ContinuationPhase {
    return this.phase;
  }
}
