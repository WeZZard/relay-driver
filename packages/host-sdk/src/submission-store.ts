/**
 * The durable submission journal (D14).
 *
 * The host SDK saves session and request identities BEFORE transmission so a
 * replacement host process can reattach, enumerate executions, and inspect
 * outcomes without replaying uncertain input.
 */

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SubmissionRecord {
  readonly sessionId: string;
  readonly taskId: string;
  /** Remote target, e.g. "user@192.0.2.10". */
  readonly target: string;
  readonly createdAt: string;
  readonly state: "starting" | "active" | "uncertain" | "closed" | "startup-failed";
  /** Execution identities submitted under this session, in submission order. */
  executions: string[];
  diagnostic?: string;
}

export interface ExecutionSubmission {
  readonly executionId: string;
  readonly sessionId: string;
  /** The original argument vector, persisted before transmission. */
  readonly argv: readonly string[];
  readonly submittedAt: string;
  readonly state: "pending" | "admitted" | "completed" | "uncertain";
  outcome?: unknown;
  /** Deployed-script identity for scripted executions (SCRIPT-01). */
  readonly script?: {
    readonly scriptId: string;
    readonly remotePath: string;
    readonly language: "javascript" | "typescript" | "python";
    readonly sha256: string;
  };
}

/** Where the durable submission journal lives. */
export interface SubmissionStoreOptions {
  /** Directory for the host-side submission journal. */
  readonly rootDir: string;
}

export class SubmissionStore {
  constructor(private readonly options: SubmissionStoreOptions) {}

  private sessionPath(sessionId: string): string {
    return join(this.options.rootDir, "sessions", `${sessionId}.json`);
  }

  private executionPath(sessionId: string, executionId: string): string {
    return join(this.options.rootDir, "sessions", sessionId, `${executionId}.json`);
  }

  private async writeAtomic(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await rename(tmp, path);
  }

  private async read<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  /** Persist a session identity before connecting. */
  async saveSessionBeforeConnect(record: SubmissionRecord): Promise<void> {
    await this.writeAtomic(this.sessionPath(record.sessionId), record);
  }

  async getSession(sessionId: string): Promise<SubmissionRecord | undefined> {
    return this.read<SubmissionRecord>(this.sessionPath(sessionId));
  }

  /** List all locally journaled sessions for discovery/reattachment. */
  async listSessions(): Promise<SubmissionRecord[]> {
    const dir = join(this.options.rootDir, "sessions");
    try {
      const entries = await import("node:fs/promises").then((fs) => fs.readdir(dir));
      const sessions: SubmissionRecord[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const record = await this.read<SubmissionRecord>(join(dir, entry));
        if (record) sessions.push(record);
      }
      return sessions;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  /** Persist an execution identity before submitting the command. */
  async saveExecutionBeforeSubmit(record: ExecutionSubmission): Promise<void> {
    await this.writeAtomic(
      this.executionPath(record.sessionId, record.executionId),
      record,
    );
    const session = await this.getSession(record.sessionId);
    if (session && !session.executions.includes(record.executionId)) {
      await this.writeAtomic(this.sessionPath(record.sessionId), {
        ...session,
        executions: [...session.executions, record.executionId],
      });
    }
  }

  async getExecution(sessionId: string, executionId: string): Promise<ExecutionSubmission | undefined> {
    return this.read<ExecutionSubmission>(this.executionPath(sessionId, executionId));
  }

  async listExecutions(sessionId: string): Promise<ExecutionSubmission[]> {
    const session = await this.getSession(sessionId);
    if (!session) return [];
    const out: ExecutionSubmission[] = [];
    for (const executionId of session.executions) {
      const record = await this.getExecution(sessionId, executionId);
      if (record) out.push(record);
    }
    return out;
  }
}
