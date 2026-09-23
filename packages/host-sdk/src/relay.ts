/**
 * The host SDK session: start, attach, upload, exec, finish (D14).
 *
 * Identities are allocated and durably persisted BEFORE any transmission.
 * Reattachment reads existing records; uncertain outcomes are inspected, not
 * replayed. The transport is an injectable boundary so tests run without SSH
 * and the real SSH framing is added by the transport implementation.
 */

import { allocateId, formatId } from "@wezzard/relay-driver-core";
import {
  SubmissionStore,
  type SubmissionRecord,
  type ExecutionSubmission,
} from "./submission-store.js";

/**
 * The framed remote-execution request (plan: "Preserve commands and evidence
 * across the transport"): an argument vector plus working directory sent as
 * data — never reinterpreted through a remote shell.
 */
/** Snapshot evidence params (SNAP-01/02/03) — matches runtime SnapshotParams. */
export interface SnapshotsRequest {
  /**
   * REQUIRED (single events): after-snapshot waits exactly this many ms
   * after dispatch completion. Agent-supplied per event — the runtime never
   * guesses or defaults.
   */
  readonly afterIntervalMs?: number;
  /** Sender-declared text-entry coalescing group (SNAP-03). */
  readonly group?: {
    readonly groupId: string;
    readonly phase: "first" | "member" | "last";
    /** The group's after-snapshot interval (required on the last member). */
    readonly afterIntervalMs?: number;
  };
}

export interface FramedRequest {
  readonly kind: "exec" | "script" | "code";
  readonly executionId: string;
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly step?: StepDescription;
  /** Framing identity: binds remote records/journal to this session/attempt. */
  readonly sessionId?: string;
  readonly attemptId?: string;
  /** Snapshot evidence contract for this execution (SNAP-01/02/03). */
  readonly snapshots?: SnapshotsRequest;
  readonly remotePath?: string;
  readonly language?: ScriptRequest["language"];
  readonly scriptId?: string;
  readonly scriptSha256?: string;
  /** Streamed-code request payload (kind "code"). */
  readonly code?: string;
  readonly codeSha256?: string;
}

export interface StepDescription {
  readonly id: string;
  readonly title: string;
  readonly expected?: string;
  /**
   * Input mode for the interaction contract (INPUT-02): "ordinary" for
   * real pointer/keystroke interaction, "accessibility" for direct AX
   * activation/value-setting. Ordinary-interaction claims must not inherit
   * accessibility-mode evidence; the label travels with the record.
   */
  readonly inputMode?: "ordinary" | "accessibility";
}

export interface FramedResponse {
  readonly executionId: string;
  readonly outcome:
    | { readonly kind: "completed"; readonly exitStatus: { code: number | null; signal: string | null } }
    | { readonly kind: "uncertain"; readonly diagnostic: string }
    | { readonly kind: "refused"; readonly diagnostic: string };
}

/** Injectable transport: framed requests/responses over an attached session. */
export interface SessionTransport {
  send(request: FramedRequest): Promise<FramedResponse>;
  upload(path: string, options: { remotePath: string }): Promise<{ scriptId: string; path: string }>;
  finish(options: { downloadTo: string }): Promise<FinishResult>;
  close(): Promise<void>;
}

/** The scripted-code execution request (EXECUTION-01/SCRIPT-01). */
export interface ScriptRequest {
  readonly kind: "script";
  readonly executionId: string;
  /** Remote path of the deployed script (already uploaded via transport.upload). */
  readonly remotePath: string;
  /** Language runtime used to launch the script on the remote host. */
  readonly language: "javascript" | "typescript" | "python";
  /** Interpreter argv, e.g. ["node", "..."] or ["python3", "..."] — data, not a shell string. */
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly step?: StepDescription;
  /** Identity of the uploaded script artifact, linking receipt to deployment. */
  readonly scriptId: string;
  /** SHA-256 of the uploaded bytes; recorded before transmission. */
  readonly scriptSha256: string;
}

/**
 * The streamed-code execution request (EXECUTION-01): source code delivered
 * through the framed SSH request itself — no separate upload round-trip.
 * The runtime verifies the declared hash over the received bytes and runs
 * the code under the same admission, recording, and resource contracts as
 * an uploaded script. Streamed identity is as durable as uploaded identity.
 */
export interface StreamedCodeRequest {
  readonly kind: "code";
  readonly executionId: string;
  readonly language: "javascript" | "typescript" | "python";
  /** The source text itself, streamed inside the framed request. */
  readonly code: string;
  /** SHA-256 of the code text; verified remotely after receipt. */
  readonly codeSha256: string;
  readonly cwd?: string;
  readonly step?: StepDescription;
}

export interface FinishResult {
  readonly manifestPath: string;
  readonly deliveryVerified: boolean;
  readonly recording: "complete" | "incomplete";
  readonly execution: "passed" | "failed" | "uncertain";
}

export interface StartOptions {
  /** e.g. "user@192.0.2.10" */
  readonly target: string;
  /** Inherited task identity from the governing environment workflow (D2). */
  readonly taskId: string;
  /** Optional explicit session id (used on reattachment). */
  readonly sessionId?: string;
}

export interface UploadResult {
  readonly scriptId: string;
  readonly path: string;
}

export interface ExecOptions {
  readonly step?: StepDescription;
  readonly cwd?: string;
  /** Snapshot evidence contract (SNAP-01/02/03). */
  readonly snapshots?: SnapshotsRequest;
}

export interface RunScriptOptions {
  readonly step?: StepDescription;
  readonly cwd?: string;
  /** Extra interpreter arguments inserted before the script path. */
  readonly interpreterArgs?: readonly string[];
  /** Snapshot evidence contract (SNAP-01/02/03). */
  readonly snapshots?: SnapshotsRequest;
}

export interface ExecResult {
  readonly executionId: string;
  readonly outcome: FramedResponse["outcome"];
}

export class Relay {
  private constructor(
    private readonly store: SubmissionStore,
    private transportFactory?: (options: StartOptions) => Promise<SessionTransport>,
  ) {}

  /** Create a Relay host client with its durable submission journal root. */
  static open(storeRootDir: string): Relay {
    return new Relay(new SubmissionStore({ rootDir: storeRootDir }));
  }

  /** Register the transport used by start(); e.g. (o) => new SshTransport(o). */
  useTransport(factory: (options: StartOptions) => Promise<SessionTransport> | SessionTransport): void {
    this.transportFactory = async (options) => await factory(options);
  }

  get submissions(): SubmissionStore {
    return this.store;
  }

  /**
   * Start a new walkthrough session. The session identity is durably saved
   * before any connection attempt so a startup failure after acquiring
   * remote resources remains discoverable (D14).
   */
  async start(options: StartOptions): Promise<Session> {
    const sessionId = options.sessionId ?? formatId(allocateId("session"));
    const record: SubmissionRecord = {
      sessionId,
      taskId: options.taskId,
      target: options.target,
      createdAt: new Date().toISOString(),
      state: "starting",
      executions: [],
    };
    await this.store.saveSessionBeforeConnect(record);
    const transport = await this.connect(options);
    await this.markState(sessionId, "active");
    return new Session(sessionId, transport, this.store);
  }

  /**
   * Reattach to an existing session through its durable identity. Reads the
   * existing record; never resubmits uncertain input.
   */
  async attach(sessionId: string, transport: SessionTransport): Promise<Session> {
    const record = await this.store.getSession(sessionId);
    if (!record) {
      throw new Error(`no durable submission record for session ${sessionId}`);
    }
    return new Session(sessionId, transport, this.store);
  }

  /** List locally journaled sessions (discovery for replacement processes). */
  async listSessions(): Promise<SubmissionRecord[]> {
    return this.store.listSessions();
  }

  private async connect(options: StartOptions): Promise<SessionTransport> {
    if (!this.transportFactory) {
      throw new Error(
        "no transport configured: call relay.useTransport(...) (e.g. () => new SshTransport({ target }))",
      );
    }
    return this.transportFactory(options);
  }

  private async markState(sessionId: string, state: SubmissionRecord["state"]): Promise<void> {
    const record = await this.store.getSession(sessionId);
    if (record) {
      const updated: SubmissionRecord = { ...record, state };
      await this.store.saveSessionBeforeConnect(updated);
    }
  }
}

export class Session {
  constructor(
    readonly sessionId: string,
    private readonly transport: SessionTransport,
    private readonly store: SubmissionStore,
  ) {}

  /**
   * Upload a script into the assigned task directory. Upload completion is
   * separate from execution; the script identity is preserved with the
   * execution evidence.
   */
  async upload(localPath: string, remotePath: string): Promise<UploadResult> {
    return this.transport.upload(localPath, { remotePath });
  }

  /**
   * Submit a framed execution request. The execution identity is durably
   * persisted before transmission; a transport loss leaves the submission
   * inspectable as uncertain, never replayed.
   */
  async exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    const executionId = formatId(allocateId("execution"));
    const submission: ExecutionSubmission = {
      executionId,
      sessionId: this.sessionId,
      argv,
      submittedAt: new Date().toISOString(),
      state: "pending",
    };
    await this.store.saveExecutionBeforeSubmit(submission);

    const response = await this.transport.send({
      sessionId: this.sessionId,
      attemptId: "attempt-1",
      kind: "exec",
      executionId,
      argv,
      cwd: options.cwd,
      step: options.step,
      snapshots: options.snapshots,
    });

    const state =
      response.outcome.kind === "completed"
        ? "completed"
        : "uncertain";
    await this.store.saveExecutionBeforeSubmit({
      ...submission,
      state,
      outcome: response.outcome,
    });
    return { executionId, outcome: response.outcome };
  }

  /**
   * Upload then execute a script file. The execution identity, deployed
   * script identity, and content hash are durably persisted before
   * transmission; the same outcome states as exec() apply (D14/D17).
   */
  async runScript(
    localPath: string,
    remotePath: string,
    language: ScriptRequest["language"],
    options: RunScriptOptions = {},
  ): Promise<ExecResult> {
    const { createHash } = await import("node:crypto");
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(localPath);
    const scriptSha256 = createHash("sha256").update(bytes).digest("hex");

    const upload = await this.transport.upload(localPath, { remotePath });

    const executionId = formatId(allocateId("execution"));
    const interpreter =
      language === "python" ? "python3" : language === "typescript" ? "tsx" : "node";
    const argv = [interpreter, ...(options.interpreterArgs ?? []), remotePath];
    const submission: ExecutionSubmission = {
      executionId,
      sessionId: this.sessionId,
      argv,
      submittedAt: new Date().toISOString(),
      state: "pending",
      script: {
        scriptId: upload.scriptId,
        remotePath,
        language,
        sha256: scriptSha256,
      },
    };
    await this.store.saveExecutionBeforeSubmit(submission);

    const response = await this.transport.send({
      sessionId: this.sessionId,
      attemptId: "attempt-1",
      kind: "script",
      executionId,
      remotePath,
      language,
      argv,
      cwd: options.cwd,
      step: options.step,
      snapshots: options.snapshots,
      scriptId: upload.scriptId,
      scriptSha256,
    });

    const state =
      response.outcome.kind === "completed" ? "completed" : "uncertain";
    await this.store.saveExecutionBeforeSubmit({
      ...submission,
      state,
      outcome: response.outcome,
    });
    return { executionId, outcome: response.outcome };
  }

  /**
   * Stream source code through the framed request and execute it remotely
   * (EXECUTION-01). No upload round-trip: the code text itself is part of
   * the durable submission, hashed before transmission and verified on the
   * remote after receipt. Same outcome states as exec() (D14/D17).
   */
  async runCode(
    code: string,
    language: ScriptRequest["language"],
    options: RunScriptOptions = {},
  ): Promise<ExecResult> {
    const { createHash } = await import("node:crypto");
    const codeSha256 = createHash("sha256").update(code, "utf8").digest("hex");

    const executionId = formatId(allocateId("execution"));
    const interpreter =
      language === "python" ? "python3" : language === "typescript" ? "tsx" : "node";

    const submission: ExecutionSubmission = {
      executionId,
      sessionId: this.sessionId,
      argv: [interpreter, "<streamed-code>"],
      submittedAt: new Date().toISOString(),
      state: "pending",
      script: {
        scriptId: `code-${executionId}`,
        remotePath: "<streamed>",
        language,
        sha256: codeSha256,
      },
    };
    await this.store.saveExecutionBeforeSubmit(submission);

    const response = await this.transport.send({
      sessionId: this.sessionId,
      attemptId: "attempt-1",
      kind: "code",
      executionId,
      language,
      code,
      codeSha256,
      argv: [interpreter],
      cwd: options.cwd,
      step: options.step,
      snapshots: options.snapshots,
    });

    const state =
      response.outcome.kind === "completed" ? "completed" : "uncertain";
    await this.store.saveExecutionBeforeSubmit({
      ...submission,
      state,
      outcome: response.outcome,
    });
    return { executionId, outcome: response.outcome };
  }

  /**
   * Test/proof escape hatch: runCode with an explicitly wrong declared
   * hash, to demonstrate the remote hash-mismatch refusal. Not part of the
   * normal surface — normal callers use runCode, which computes the hash.
   */
  async runCodeWithHash(
    code: string,
    codeSha256: string,
    language: ScriptRequest["language"],
    options: RunScriptOptions = {},
  ): Promise<ExecResult> {
    const executionId = formatId(allocateId("execution"));
    const submission: ExecutionSubmission = {
      executionId,
      sessionId: this.sessionId,
      argv: [language, "<streamed-code>"],
      submittedAt: new Date().toISOString(),
      state: "pending",
      script: { scriptId: `code-${executionId}`, remotePath: "<streamed>", language, sha256: codeSha256 },
    };
    await this.store.saveExecutionBeforeSubmit(submission);
    const response = await this.transport.send({
      sessionId: this.sessionId,
      attemptId: "attempt-1",
      kind: "code", executionId, language, code, codeSha256,
      argv: [language === "python" ? "python3" : language === "typescript" ? "tsx" : "node"],
      cwd: options.cwd, step: options.step,
    });
    const state = response.outcome.kind === "completed" ? "completed" : "uncertain";
    await this.store.saveExecutionBeforeSubmit({ ...submission, state, outcome: response.outcome });
    return { executionId, outcome: response.outcome };
  }

  /** Enumerate executions submitted under this session (host-side view). */
  async executions(): Promise<ExecutionSubmission[]> {
    return this.store.listExecutions(this.sessionId);
  }

  /** Finalize capture, transfer the package, and validate host delivery. */
  async finish(options: { downloadTo: string }): Promise<FinishResult> {
    return this.transport.finish(options);
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
