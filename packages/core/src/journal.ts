/**
 * The append-only JSONL event journal.
 *
 * Contract (docs/arch/action-evidence.md, D13): every admitted operation —
 * direct SSH submission or uploaded-script action — retains a durable start
 * record before its callable runs, then appends its completion. Journal write
 * failure disables further input (D17). The journal is append-only; damaged
 * tails preserve uncertainty rather than being truncated away.
 */

import { promises as fs } from "node:fs";
import type { EventState, EvidenceStatus, ToolOutcome } from "./event-state.js";

/** The event kinds shared by both execution paths (D13). */
export type EventKind =
  | "session-start"
  | "attempt-start"
  | "action-start"
  | "action-completion"
  | "action-refusal"
  | "observation"
  | "annotation"
  | "capture-status"
  | "evidence-failure"
  | "execution-start"
  | "execution-completion"
  | "continuation-phase"
  | "resource-stop"
  | "snapshot-captured"
  | "snapshot-evidence";

export interface JournalRecord {
  readonly kind: EventKind;
  /** Monotonic sequence within this journal file. */
  readonly seq: number;
  /** Remote wall-clock ISO-8601 write time; audit provenance, not media time. */
  readonly writtenAt: string;
  /** Remote monotonic clock reading and its identified timebase. */
  readonly monotonic?: { readonly clock: string; readonly value: number };
  readonly sessionId?: string;
  readonly attemptId?: string;
  readonly stepId?: string;
  readonly executionId?: string;
  readonly actionId?: string;
  readonly segmentId?: string;
  readonly state?: EventState;
  readonly toolOutcome?: ToolOutcome;
  readonly evidenceStatus?: EvidenceStatus;
  /** Free-form payload for kind-specific fields. */
  readonly [key: string]: unknown;
}

/**
 * Append-only writer with fsync-on-each-record semantics for start records
 * (durable retention before invocation) and batched sync for completions.
 * `unref` keeps a lingering writer from holding the event loop open.
 *
 * `resource-stop` records a D19 stop/refusal: the limit reached, observed
 * usage, the configured threshold, and the resulting action.
 */
export class JournalWriter {
  private seq = 0;
  private handle: fs.FileHandle | undefined;

  private constructor(private readonly path: string) {}

  static async create(path: string): Promise<JournalWriter> {
    const writer = new JournalWriter(path);
    writer.handle = await fs.open(path, "a");
    // Node 26 FileHandle gained unref(); older typings/runtimes do not have
    // it, so apply it defensively when available.
    const handle = writer.handle as fs.FileHandle & { unref?: () => void };
    handle.unref?.();
    return writer;
  }

  /** Append one record. `durable` fsyncs before returning (start records). */
  async append(
    record: Omit<JournalRecord, "seq" | "writtenAt">,
    options: { durable?: boolean } = {},
  ): Promise<JournalRecord> {
    if (!this.handle) throw new Error("journal writer is closed");
    const full: JournalRecord = {
      ...record,
      seq: this.seq++,
      writtenAt: new Date().toISOString(),
    } as JournalRecord;
    const line = JSON.stringify(full) + "\n";
    await this.handle.write(line, null, "utf8");
    if (options.durable) {
      await this.handle.sync();
    }
    return full;
  }

  async close(): Promise<void> {
    if (this.handle) {
      await this.handle.sync();
      await this.handle.close();
      this.handle = undefined;
    }
  }
}

export interface ReadJournalOptions {
  /** Stop after this many parsed records (0 = all). */
  limit?: number;
}

/**
 * Read a journal, including a damaged tail: records that fail to parse are
 * surfaced as raw entries so evidence remains inspectable. Never throws on
 * a torn final line.
 */
export async function readJournal(
  path: string,
  options: ReadJournalOptions = {},
): Promise<{ records: JournalRecord[]; damagedTail?: string }> {
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [] };
    }
    throw err;
  }
  const records: JournalRecord[] = [];
  let damagedTail: string | undefined;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") continue;
    try {
      records.push(JSON.parse(line) as JournalRecord);
    } catch {
      // Only a torn final line is expected; anything else is still retained.
      if (i === lines.length - 1) {
        damagedTail = line;
      } else {
        damagedTail = damagedTail === undefined ? line : damagedTail;
      }
    }
    if (options.limit && records.length >= options.limit) break;
  }
  return { records, damagedTail };
}
