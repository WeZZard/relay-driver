/**
 * The durable record store for sessions, attempts, executions, and actions.
 *
 * Contract (D14/D15, docs/arch/sessions.md):
 * - Start records are durably retained BEFORE the callable runs.
 * - Recovered records are inspected; replay never happens.
 * - Every action keeps its parent execution identity.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  JournalWriter,
  readJournal,
  type JournalRecord,
  type EventState,
} from "@wezzard/relay-driver-core";

export interface ActionRecord {
  readonly actionId: string;
  readonly sessionId: string;
  readonly attemptId: string;
  readonly stepId?: string;
  readonly executionId?: string;
  state: EventState;
  /** Set when the start record was durably retained. */
  startRetainedAt?: string;
  toolOutcome?: unknown;
  evidenceStatus?: "retained" | "failed" | "unconfirmed" | "not-applicable";
  title?: string;
  /** Interaction contract label (INPUT-02): ordinary vs accessibility input. */
  inputMode?: "ordinary" | "accessibility";
  /** Snapshot evidence references (SNAP-01/02/03), when captured. */
  snapshots?: SnapshotRef[];
  /** "single" | "first" | "member" | "last" — pair-citation role. */
  snapshotRole?: string;
  /** Coalescing group identity when this event belongs to one (SNAP-03). */
  groupId?: string;
}

/** Reference to one dispatch-time snapshot file with hash-at-capture. */
export interface SnapshotRef {
  readonly fileName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly role: "before" | "after";
  readonly capturedAt: string;
  readonly declaredAfterIntervalMs?: number;
  readonly actualWaitMs?: number;
}

export interface ExecutionRecord {
  readonly executionId: string;
  readonly sessionId: string;
  readonly attemptId: string;
  state: EventState;
  /** The original submitted argument vector, when direct submission. */
  argv?: readonly string[];
  /** Deployed script identity, when script execution. */
  scriptId?: string;
  exitStatus?: { code: number | null; signal: string | null };
}

export interface SessionRecord {
  readonly sessionId: string;
  readonly taskId: string;
  createdAt: string;
  state: "preparing" | "active" | "suspended" | "finalizing" | "retained";
  attempts: string[];
}

export interface AttemptRecord {
  readonly attemptId: string;
  readonly sessionId: string;
  /** Identity of the attempt this one continues, when a continuation. */
  continuesAttemptId?: string;
  state: "preparing" | "active" | "suspended" | "finalizing" | "retained";
  segments: string[];
}

/**
 * A write-ahead store: JSON state files mutated atomically (write + rename),
 * plus the append-only journal for the event history itself.
 */
export class RecordStore {
  private journal: JournalWriter | undefined;

  private constructor(private readonly rootDir: string) {}

  static async create(rootDir: string): Promise<RecordStore> {
    await mkdir(join(rootDir, "records"), { recursive: true });
    await mkdir(join(rootDir, "journal"), { recursive: true });
    const store = new RecordStore(rootDir);
    store.journal = await JournalWriter.create(join(rootDir, "journal", "events.jsonl"));
    return store;
  }

  private recordPath(kind: string, id: string): string {
    return join(this.rootDir, "records", kind, `${id}.json`);
  }

  private async writeRecord(kind: string, id: string, record: unknown): Promise<void> {
    const path = this.recordPath(kind, id);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
    await rename(tmp, path); // atomic on POSIX
  }

  private async readRecord<T>(kind: string, id: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.recordPath(kind, id), "utf8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async appendJournal(
    record: Omit<JournalRecord, "seq" | "writtenAt">,
    options: { durable?: boolean } = {},
  ): Promise<JournalRecord> {
    if (!this.journal) throw new Error("store is closed");
    return this.journal.append(record, options);
  }

  // ---- sessions / attempts / executions ----

  async putSession(session: SessionRecord): Promise<void> {
    await this.writeRecord("session", session.sessionId, session);
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    return this.readRecord<SessionRecord>("session", sessionId);
  }

  async putAttempt(attempt: AttemptRecord): Promise<void> {
    await this.writeRecord("attempt", attempt.attemptId, attempt);
  }

  async getAttempt(attemptId: string): Promise<AttemptRecord | undefined> {
    return this.readRecord<AttemptRecord>("attempt", attemptId);
  }

  async putExecution(execution: ExecutionRecord): Promise<void> {
    await this.writeRecord("execution", execution.executionId, execution);
  }

  async getExecution(executionId: string): Promise<ExecutionRecord | undefined> {
    return this.readRecord<ExecutionRecord>("execution", executionId);
  }

  async putAction(action: ActionRecord): Promise<void> {
    await this.writeRecord("action", action.actionId, action);
  }

  async getAction(actionId: string): Promise<ActionRecord | undefined> {
    return this.readRecord<ActionRecord>("action", actionId);
  }

  /**
   * Durable start retention: the journal fsyncs the start record before the
   * callable may be invoked. Returns after the record is on disk.
   */
  async retainActionStart(params: {
    actionId: string;
    sessionId: string;
    attemptId: string;
    stepId?: string;
    executionId?: string;
    title?: string;
    inputMode?: "ordinary" | "accessibility";
    /** Snapshot plan resolved at admission (SNAP-01/02/03). */
    snapshots?: { plan: unknown };
  }): Promise<void> {
    const record = await this.getAction(params.actionId);
    if (!record) throw new Error(`unknown action ${params.actionId}`);
    if (record.state !== "pending") {
      throw new Error(`action ${params.actionId} is not pending (state: ${record.state})`);
    }
    const start = await this.appendJournal(
      {
        kind: "action-start",
        sessionId: params.sessionId,
        attemptId: params.attemptId,
        stepId: params.stepId,
        executionId: params.executionId,
        actionId: params.actionId,
        state: "admitted",
        title: params.title,
        inputMode: params.inputMode,
        snapshotPlan: params.snapshots?.plan,
      },
      { durable: true },
    );
    const updated: ActionRecord = {
      ...record,
      state: "admitted",
      startRetainedAt: start.writtenAt,
    };
    await this.putAction(updated);
  }

  /**
   * Retain the snapshot evidence references for one action (SNAP-02/03):
   * hashes-at-capture, file names, provenance, and for coalescing groups
   * the pair-citation layout. Journal record fsynced — snapshot references
   * are durable evidence, not prose.
   */
  async retainActionSnapshots(
    actionId: string,
    snapshots: readonly unknown[],
    plan: { role: string; group?: { groupId: string } },
  ): Promise<void> {
    const record = await this.getAction(actionId);
    if (!record) throw new Error(`unknown action ${actionId}`);
    await this.appendJournal({
      kind: "snapshot-evidence",
      sessionId: record.sessionId,
      attemptId: record.attemptId,
      actionId,
      state: "recorded",
      snapshots,
      snapshotRole: plan.role,
      groupId: plan.group?.groupId,
    });
    await this.putAction({
      ...record,
      snapshots: snapshots as SnapshotRef[],
      snapshotRole: plan.role,
      groupId: plan.group?.groupId,
    });
  }

  async retainActionCompletion(params: {
    actionId: string;
    toolOutcome: unknown;
  }): Promise<void> {
    const record = await this.getAction(params.actionId);
    if (!record) throw new Error(`unknown action ${params.actionId}`);
    if (record.state !== "admitted") {
      throw new Error(`action ${params.actionId} is not admitted (state: ${record.state})`);
    }
    await this.appendJournal({
      kind: "action-completion",
      sessionId: record.sessionId,
      attemptId: record.attemptId,
      executionId: record.executionId,
      actionId: record.actionId,
      state: "recorded",
      toolOutcome: params.toolOutcome,
    });
    await this.putAction({
      ...record,
      state: "recorded",
      toolOutcome: params.toolOutcome,
      evidenceStatus: "retained",
    });
  }

  /**
   * Mark an admitted action uncertain (process/transport lost before
   * completion). Never resolves the outcome; recovery may later find the
   * original record.
   */
  async markUncertain(actionId: string, diagnostic: string): Promise<void> {
    const record = await this.getAction(actionId);
    if (!record) throw new Error(`unknown action ${actionId}`);
    if (record.state !== "admitted") return;
    await this.appendJournal({
      kind: "action-completion",
      sessionId: record.sessionId,
      attemptId: record.attemptId,
      actionId: record.actionId,
      state: "uncertain",
      diagnostic,
    });
    await this.putAction({
      ...record,
      state: "uncertain",
      evidenceStatus: "unconfirmed",
    });
  }

  async journalHistory(): Promise<ReturnType<typeof readJournal>> {
    return readJournal(join(this.rootDir, "journal", "events.jsonl"));
  }

  async close(): Promise<void> {
    await this.journal?.close();
  }
}
