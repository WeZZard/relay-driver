/**
 * The action-handle admission engine (D15/D17) with dispatch-time snapshot
 * evidence (SNAP-01/02/03).
 *
 * `call` follows the accepted sequence: request admission, durably retain the
 * start, invoke the supplied callable exactly once, retain the completion,
 * and preserve the original value or exception. A refused admission never
 * invokes the callable. A second call on the same handle is refused without
 * dispatching input. Evidence-write failure disables further input session-
 * wide (D17) and is reported without masking the tool's own exception.
 *
 * Snapshot evidence (2026-09-11 decision): when the request supplies
 * snapshot params, a before-snapshot is captured immediately before the
 * callable dispatches and an after-snapshot is captured exactly
 * `afterIntervalMs` after dispatch completion. The interval is REQUIRED —
 * the agent decides it per event (or per coalescing group); the runtime
 * never guesses, polls, or defaults. A missing interval is a usage refusal
 * before any dispatch. For sender-declared coalescing groups, the group
 * takes ONE pair: the first member captures the before-snapshot, the last
 * member captures the after-snapshot; every member's record cites the pair.
 */

import { allocateId, formatId, type RecordId } from "@wezzard/relay-driver-core";
import type { RecordStore } from "./record-store.js";
import type { CaptureGate } from "./capture-gate.js";
import type { Snapshot, SnapshotParams, SnapshotStore, SnapshotIdentity } from "./snapshots.js";
import { SnapshotCaptureError } from "./snapshots.js";

export interface ActionParams {
  readonly stepId?: string;
  readonly title?: string;
  /** Interaction contract label (INPUT-02), carried on the action record. */
  readonly inputMode?: "ordinary" | "accessibility";
  /**
   * Parent execution identity (SCRIPT-01): when a deployed or streamed
   * script makes individual recorded calls, each action record cites the
   * script execution that produced it.
   */
  readonly parentExecutionId?: string;
  /**
   * Snapshot evidence params (SNAP-01/02/03). Absent = no snapshot evidence
   * for this action (non-display work: builds, scripts without GUI effect).
   * Present = the before/after pair contract applies.
   */
  readonly snapshots?: SnapshotParams;
  /** Stable identity for snapshot file naming (defaults to the title/step). */
  readonly dispatchIdentity?: string;
}

/** Refusal because capture is unavailable or the session is suspended. */
export class AdmissionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdmissionRefusedError";
  }
}

/** API misuse: invoking an already-invoked handle. Never dispatches input. */
export class HandleAlreadyUsedError extends Error {
  constructor(readonly actionId: string) {
    super(`action handle ${actionId} was already invoked; use a new handle for a deliberate retry`);
    this.name = "HandleAlreadyUsedError";
  }
}

/**
 * Evidence-retention failure. Preserves the tool outcome separately so the
 * caller's original exception/value is never masked (D17).
 */
export class EvidenceWriteError extends Error {
  constructor(
    readonly actionId: string,
    readonly toolOutcome: unknown,
    cause: unknown,
  ) {
    super(`evidence retention failed for action ${actionId}; input is disabled`, { cause });
    this.name = "EvidenceWriteError";
  }
}

/** Resolved snapshot plan for one action. */
interface SnapshotPlan {
  /** Capture the before-snapshot for this action. */
  readonly capturesBefore: boolean;
  /** Capture the after-snapshot for this action (with this interval). */
  readonly capturesAfter: false | { afterIntervalMs: number };
  /** When false, this action cites the group pair captured by its bookends. */
  readonly role: "single" | "first" | "member" | "last";
  readonly group?: { groupId: string };
}

export class AdmissionEngine {
  /** Set when any evidence write fails; input stays disabled for the session. */
  private evidenceFailed = false;
  private evidenceFailureDiagnostic: string | undefined;
  private lastSnapshots: Snapshot[] | undefined;

  constructor(
    private readonly store: RecordStore,
    private readonly capture: CaptureGate,
    private readonly ids: {
      sessionId: string;
      attemptId: string;
    },
    private readonly snapshotStore?: SnapshotStore,
  ) {}

  /** Why input is currently disabled, or undefined when admission is possible. */
  refusalReason(): string | undefined {
    if (this.evidenceFailed) {
      return `evidence retention previously failed: ${this.evidenceFailureDiagnostic}`;
    }
    return this.capture.checkAdmission();
  }

  get evidenceFailure(): string | undefined {
    return this.evidenceFailureDiagnostic;
  }

  /** Snapshot evidence captured during the most recent call(). */
  get actionSnapshots(): readonly Snapshot[] | undefined {
    return this.lastSnapshots;
  }

  allocateAction(params: ActionParams): string {
    const id: RecordId = allocateId("action");
    const actionId = formatId(id);
    // Creation establishes identity and intent only — no execution claim.
    // This is synchronous intent allocation; the durable start happens in call().
    return actionId;
  }

  /**
   * The full call sequence for one backend invocation. The callable runs in
   * the caller's process; admission and retention happen here.
   */
  async call<T>(params: ActionParams, callable: () => Promise<T> | T): Promise<T> {
    const actionId = this.allocateAction(params);
    return this.callWithHandle(actionId, params, callable);
  }

  /**
   * Resolve the snapshot plan for the params, or undefined when the action
   * carries no snapshot evidence. Throws AdmissionRefusedError on contract
   * violations — a missing required interval is a usage refusal BEFORE any
   * dispatch (never an uncertain run).
   */
  private resolveSnapshotPlan(params: ActionParams, actionId: string): SnapshotPlan | undefined {
    const p = params.snapshots;
    if (!p) return undefined;
    if (!this.snapshotStore) {
      throw new AdmissionRefusedError(
        "snapshots requested but this engine has no snapshot store configured",
      );
    }
    const identity = this.dispatchIdentityOf(actionId, params);
    if (p.group) {
      const groupId = p.group.groupId;
      if (!groupId) {
        throw new AdmissionRefusedError("coalescing group declared without groupId");
      }
      switch (p.group.phase) {
        case "first":
          // First member: captures before; the after belongs to the last.
          return { capturesBefore: true, capturesAfter: false, role: "first", group: { groupId } };
        case "member":
          // Interior member: cites the group pair; captures nothing.
          return { capturesBefore: false, capturesAfter: false, role: "member", group: { groupId } };
        case "last": {
          const interval = p.group.afterIntervalMs ?? p.afterIntervalMs;
          if (typeof interval !== "number" || !Number.isFinite(interval) || interval < 0) {
            throw new AdmissionRefusedError(
              `coalescing group ${groupId}: after-snapshot interval is required on the last member (agent-supplied per the snapshot contract)`,
            );
          }
          return {
            capturesBefore: false,
            capturesAfter: { afterIntervalMs: interval },
            role: "last",
            group: { groupId },
          };
        }
        default:
          throw new AdmissionRefusedError(`coalescing group phase must be first|member|last, got: ${String(p.group.phase)}`);
      }
      void identity;
    }
    // Single (non-group) event: interval REQUIRED, no default (SNAP-02).
    if (typeof p.afterIntervalMs !== "number" || !Number.isFinite(p.afterIntervalMs) || p.afterIntervalMs < 0) {
      throw new AdmissionRefusedError(
        "after-snapshot interval is required: supply afterIntervalMs (agent-supplied per the snapshot contract; the runtime never guesses)",
      );
    }
    return {
      capturesBefore: true,
      capturesAfter: { afterIntervalMs: p.afterIntervalMs },
      role: "single",
    };
  }

  private dispatchIdentityOf(actionId: string, params: ActionParams): string {
    if (params.dispatchIdentity) return params.dispatchIdentity;
    if (params.title) return params.title;
    if (params.stepId) return params.stepId;
    return actionId;
  }

  /** Call sequence for an existing handle identity. */
  async callWithHandle<T>(
    actionId: string,
    params: ActionParams,
    callable: () => Promise<T> | T,
  ): Promise<T> {
    if (this.evidenceFailed) {
      throw new AdmissionRefusedError(this.refusalReason()!);
    }
    const existing = await this.store.getAction(actionId);
    if (existing && existing.state !== "pending") {
      throw new HandleAlreadyUsedError(actionId);
    }
    const refusal = this.capture.checkAdmission();
    if (refusal) {
      await this.store.putAction({
        actionId,
        sessionId: this.ids.sessionId,
        attemptId: this.ids.attemptId,
        stepId: params.stepId,
        state: "refused",
        title: params.title,
        inputMode: params.inputMode,
        executionId: params.parentExecutionId,
        evidenceStatus: "not-applicable",
      });
      await this.store.appendJournal({
        kind: "action-refusal",
        sessionId: this.ids.sessionId,
        attemptId: this.ids.attemptId,
        actionId,
        state: "refused",
        diagnostic: refusal,
      });
      throw new AdmissionRefusedError(refusal);
    }

    // Snapshot plan resolution happens BEFORE the durable start: a missing
    // required interval is a usage refusal, not an uncertain run. The
    // refusal is journaled so the contract violation is durable evidence.
    let snapPlan: SnapshotPlan | undefined;
    try {
      snapPlan = this.resolveSnapshotPlan(params, actionId);
    } catch (err) {
      if (err instanceof AdmissionRefusedError) {
        await this.store.putAction({
          actionId,
          sessionId: this.ids.sessionId,
          attemptId: this.ids.attemptId,
          stepId: params.stepId,
          state: "refused",
          title: params.title,
          inputMode: params.inputMode,
          executionId: params.parentExecutionId,
          evidenceStatus: "not-applicable",
        });
        await this.store.appendJournal({
          kind: "action-refusal",
          sessionId: this.ids.sessionId,
          attemptId: this.ids.attemptId,
          actionId,
          state: "refused",
          diagnostic: err.message,
        });
      }
      throw err;
    }
    this.lastSnapshots = undefined;

    await this.store.putAction({
      actionId,
      sessionId: this.ids.sessionId,
      attemptId: this.ids.attemptId,
      stepId: params.stepId,
      state: "pending",
      title: params.title,
      inputMode: params.inputMode,
      executionId: params.parentExecutionId,
    });

    let toolOutcome: { kind: "success"; value: T } | { kind: "failure"; error: unknown };
    try {
      // Durable start retention happens BEFORE the callable runs.
      await this.store.retainActionStart({
        actionId,
        sessionId: this.ids.sessionId,
        attemptId: this.ids.attemptId,
        stepId: params.stepId,
        title: params.title,
        inputMode: params.inputMode,
        executionId: params.parentExecutionId,
        snapshots: snapPlan ? { plan: snapPlan } : undefined,
      });

      const snapshots: Snapshot[] = [];

      // Before-snapshot: immediately before dispatch (SNAP-02). Only the
      // single event or the group's first member captures it. Capture
      // failure BEFORE dispatch = admission refusal (never dispatch blind).
      if (snapPlan?.capturesBefore && this.snapshotStore) {
        const identity: SnapshotIdentity = {
          journalSeq: this.snapshotStore.nextSeq(),
          dispatchIdentity: this.dispatchIdentityOf(actionId, params),
          sessionId: this.ids.sessionId,
          attemptId: this.ids.attemptId,
        };
        let before: Snapshot;
        try {
          before = await this.snapshotStore.before(identity);
        } catch (err) {
          if (err instanceof SnapshotCaptureError) {
            throw new AdmissionRefusedError(err.message);
          }
          throw err;
        }
        snapshots.push(before);
        await this.store.appendJournal({
          kind: "snapshot-captured",
          sessionId: this.ids.sessionId,
          attemptId: this.ids.attemptId,
          actionId,
          state: "recorded",
          snapshot: before,
          group: snapPlan.group?.groupId,
        });
      }

      let value: T;
      try {
        value = await callable();
        toolOutcome = { kind: "success", value };
      } catch (err) {
        toolOutcome = { kind: "failure", error: err };
        value = undefined as unknown as T;
      }
      const dispatchCompletedAtMonotonic = Date.now();

      // After-snapshot: exactly the declared interval after dispatch
      // completion. On failure of the callable itself we still capture the
      // after-snapshot — the screen state after a failed action is evidence
      // (the refusal/failure path needs it as much as the success path).
      if (snapPlan?.capturesAfter && this.snapshotStore) {
        const identity: SnapshotIdentity = {
          journalSeq: this.snapshotStore.nextSeq(),
          dispatchIdentity: this.dispatchIdentityOf(actionId, params),
          sessionId: this.ids.sessionId,
          attemptId: this.ids.attemptId,
        };
        try {
          const after = await this.snapshotStore.after(
            identity,
            dispatchCompletedAtMonotonic,
            snapPlan.capturesAfter.afterIntervalMs,
          );
          snapshots.push(after);
          await this.store.appendJournal({
            kind: "snapshot-captured",
            sessionId: this.ids.sessionId,
            attemptId: this.ids.attemptId,
            actionId,
            state: "recorded",
            snapshot: after,
            group: snapPlan.group?.groupId,
          });
        } catch (err) {
          if (err instanceof SnapshotCaptureError) {
            // Capture failure after dispatch: journaled refusal state. The
            // action itself still completes/uncertains as the callable
            // determined; the missing after-snapshot is explicit evidence.
            const diag = err instanceof Error ? err.message : String(err);
            await this.store.appendJournal({
              kind: "capture-status",
              sessionId: this.ids.sessionId,
              attemptId: this.ids.attemptId,
              actionId,
              state: "incomplete",
              diagnostic: diag,
            }).catch(() => {});
          } else {
            throw err;
          }
        }
      }

      if (snapPlan) {
        this.lastSnapshots = snapshots;
        await this.store.retainActionSnapshots(actionId, snapshots, snapPlan);
      }
    } catch (err) {
      if (err instanceof AdmissionRefusedError || err instanceof EvidenceWriteError) {
        throw err;
      }
      toolOutcome = { kind: "failure", error: err };
    }

    try {
      await this.store.retainActionCompletion({
        actionId,
        toolOutcome: serializeOutcome(toolOutcome),
      });
    } catch (err) {
      // Evidence failure: disable further input immediately (D17).
      this.evidenceFailed = true;
      this.evidenceFailureDiagnostic = String(err);
      await this.store.appendJournal({
        kind: "evidence-failure",
        sessionId: this.ids.sessionId,
        attemptId: this.ids.attemptId,
        actionId,
        state: "incomplete",
        diagnostic: String(err),
      }).catch(() => {
        // The journal itself may be the failing channel; the in-memory flag
        // above still gates all further admission.
      });
      throw new EvidenceWriteError(actionId, toolOutcome, err);
    }

    if (toolOutcome.kind === "failure") {
      throw toolOutcome.error;
    }
    return toolOutcome.value;
  }
}

function serializeOutcome(outcome: unknown): unknown {
  if (outcome && typeof outcome === "object" && "kind" in (outcome as object)) {
    const o = outcome as { kind: string; value?: unknown; error?: unknown };
    if (o.kind === "success") return { kind: "success", value: describe(o.value) };
    if (o.kind === "failure") return { kind: "failure", error: describe(o.error) };
  }
  return describe(outcome);
}

function describe(value: unknown): unknown {
  if (value instanceof Error) {
    return { errorName: value.name, message: value.message };
  }
  return value;
}
