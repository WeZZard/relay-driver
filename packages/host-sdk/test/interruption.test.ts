/**
 * Stage 3, EXECUTION-01 interruption layer: transport delay, disconnect after
 * admission, missing completion records, startup failure after resource
 * acquisition — in BOTH paths (exec and uploaded script), with recovery from
 * a replacement host, no replay, and unshifted event times.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Relay, type SessionTransport, type FramedRequest, type FramedResponse } from "../src/index.js";
import type { SubmissionRecord } from "../src/submission-store.js";

type SendBehavior = (request: FramedRequest) => Promise<FramedResponse>;

/**
 * A transport whose send behavior is swappable mid-test. The Session captures
 * the transport instance at start(), so tests mutate `behavior` rather than
 * re-registering the factory.
 */
class SwitchableTransport implements SessionTransport {
  behavior: SendBehavior = async (request) => ({
    executionId: request.executionId,
    outcome: { kind: "completed", exitStatus: { code: 0, signal: null } },
  });
  readonly started: FramedRequest[] = [];

  async send(request: FramedRequest): Promise<FramedResponse> {
    this.started.push(request);
    return this.behavior(request);
  }

  async upload(path: string, options: { remotePath: string }): Promise<{ scriptId: string; path: string }> {
    return { scriptId: `script-${options.remotePath}`, path: options.remotePath };
  }
  async finish(): Promise<never> {
    throw new Error("finish is Stage 4");
  }
  async close(): Promise<void> {}
}

const disconnect: SendBehavior = async () => {
  throw new Error("connection lost mid-flight");
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "relay-exec01-"));
  const relay = Relay.open(dir);
  const scriptDir = await mkdtemp(join(tmpdir(), "relay-exec01-scripts-"));
  return { relay, dir, scriptDir };
}

test("exec path: disconnect after admission yields uncertainty, no replay on recovery from replacement host", async () => {
  const f = await fixture();
  const transport = new SwitchableTransport();
  f.relay.useTransport(() => transport);
  const session = await f.relay.start({ target: "t", taskId: "task", sessionId: "session-x" });
  const healthy = await session.exec(["echo", "ok"]);
  assert.equal(healthy.outcome.kind, "completed");

  // Disconnect: the remote admitted the work, then the connection died.
  transport.behavior = disconnect;
  await assert.rejects(session.exec(["echo", "interrupted"]), /connection lost/);

  // Exactly one execution record for the interrupted submission: it stays
  // pending (durable pre-transmission), resolved by inspection — never
  // silently replayed or resubmitted under a second identity.
  const executions = await f.relay.submissions.listExecutions("session-x");
  const interrupted = executions.find((e) => e.argv?.includes("interrupted"));
  assert.ok(interrupted);
  assert.equal(interrupted.state, "pending", "record stays pending; outcome resolved by inspection, not replay");
  assert.equal(
    executions.filter((e) => e.argv?.includes("interrupted")).length,
    1,
    "no resubmission created a second identity",
  );

  // Recovery from a replacement host: attach (not start) reads the record.
  const replacement = new SwitchableTransport();
  const recovered = await f.relay.attach("session-x", replacement);
  const still = await recovered.executions();
  assert.equal(still.find((e) => e.executionId === interrupted.executionId)?.state, "pending");
  // Attaching did not transmit anything (no replay).
  assert.equal(replacement.started.length, 0, "reattachment performs zero transmission");
  await session.close();
});

test("script path: same disconnect semantics, script identity retained in the uncertain record", async () => {
  const f = await fixture();
  const local = join(f.scriptDir, "s3.js");
  await writeFile(local, "console.log('stage3');\n");
  const transport = new SwitchableTransport();
  transport.behavior = disconnect; // disconnect at send; upload already happened
  f.relay.useTransport(() => transport);
  const session = await f.relay.start({ target: "t", taskId: "task", sessionId: "session-s3" });
  await assert.rejects(
    session.runScript(local, "/var/tmp/s3.js", "javascript"),
    /connection lost/,
  );
  const executions = await f.relay.submissions.listExecutions("session-s3");
  assert.equal(executions.length, 1);
  assert.equal(executions[0].state, "pending");
  assert.equal(executions[0].script?.language, "javascript", "script identity survives the disconnect");
  assert.equal(executions[0].script?.remotePath, "/var/tmp/s3.js");
  await session.close();
});

test("transport delay does not shift event times to host request times", async () => {
  const f = await fixture();
  const DELAY_MS = 250;
  const transport = new SwitchableTransport();
  transport.behavior = async (request) => {
    await new Promise((r) => setTimeout(r, DELAY_MS));
    return {
      executionId: request.executionId,
      outcome: { kind: "completed", exitStatus: { code: 0, signal: null } },
    };
  };
  f.relay.useTransport(() => transport);
  const session = await f.relay.start({ target: "t", taskId: "task", sessionId: "session-delay" });
  const before = Date.now();
  await session.exec(["echo", "delayed"]);
  const wallWithDelay = Date.now() - before;
  // The submission record's submittedAt was written BEFORE transmission.
  const executions = await f.relay.submissions.listExecutions("session-delay");
  const submittedAt = Date.parse(executions[0].submittedAt);
  assert.ok(submittedAt <= before + 50, "submittedAt reflects submission time, not response time");
  assert.ok(wallWithDelay >= DELAY_MS, "delay actually observed on the transport");
  await session.close();
});

test("startup failure after resource acquisition stays discoverable (D14)", async () => {
  const f = await fixture();
  // start() saves the session BEFORE connect; connect fails (e.g. remote
  // unreachable after the runtime staged resources).
  f.relay.useTransport(() => {
    throw new Error("remote staging succeeded but receiver failed to start");
  });
  await assert.rejects(
    f.relay.start({ target: "t", taskId: "task-startup-fail", sessionId: "session-startup-fail" }),
    /receiver failed to start/,
  );
  // Discovery from a replacement host process: the session record exists.
  const sessions = await f.relay.listSessions();
  const record = sessions.find((s: SubmissionRecord) => s.sessionId === "session-startup-fail");
  assert.ok(record, "durable session record survives startup failure");
  assert.equal(record?.state, "starting", "state shows it never became active");
  // Reattach inspects; no resubmission happens.
  const replacement = new SwitchableTransport();
  const recovered = await f.relay.attach("session-startup-fail", replacement);
  assert.equal((await recovered.executions()).length, 0);
  assert.equal(replacement.started.length, 0);
});
