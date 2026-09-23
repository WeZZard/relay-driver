import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Relay, type SessionTransport, type FramedRequest, type FramedResponse, type FinishResult } from "../src/index.js";

// Fixture sessions record a target string but never open a connection with
// it, so a fixed documentation placeholder (RFC 5737) is fine here.
const TARGET = "user@192.0.2.10";

function fakeTransport(responses: Map<string, FramedResponse>): SessionTransport {
  const sent: FramedRequest[] = [];
  return {
    async send(request) {
      sent.push(request);
      // Allow the test to install a response keyed by the now-known execution
      // id while the request is in flight.
      await new Promise((resolve) => setImmediate(resolve));
      return responses.get(request.executionId) ?? {
        executionId: request.executionId,
        outcome: { kind: "completed", exitStatus: { code: 0, signal: null } },
      };
    },
    async upload(_path, options) {
      return { scriptId: `script-${options.remotePath}`, path: options.remotePath };
    },
    async finish(_options): Promise<FinishResult> {
      return {
        manifestPath: "walkthrough.json",
        deliveryVerified: true,
        recording: "complete",
        execution: "passed",
      };
    },
    async close() {},
  };
}

test("start persists the session identity before connecting (D14)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-host-"));
  const relay = Relay.open(dir);
  // No transport registered: start must fail, but the identity must survive.
  await assert.rejects(
    relay.start({ target: TARGET, taskId: "task-1" }),
    /no transport configured/,
  );
  const sessions = await relay.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].state, "starting");
  assert.equal(sessions[0].taskId, "task-1");
});

test("exec persists the execution identity before transmission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-host-"));
  const relay = Relay.open(dir);
  await relay.submissions.saveSessionBeforeConnect({
    sessionId: "session-pre",
    taskId: "task-1",
    target: TARGET,
    createdAt: new Date().toISOString(),
    state: "active",
    executions: [],
  });
  const transport = fakeTransport(new Map());
  const session = await relay.attach("session-pre", transport);

  const result = await session.exec(["python3", "walkthrough.py"], {
    step: { id: "save", title: "Save the padding change" },
  });
  assert.equal(result.outcome.kind, "completed");

  const executions = await session.executions();
  assert.equal(executions.length, 1);
  assert.equal(executions[0].state, "completed");
  assert.deepEqual(executions[0].argv, ["python3", "walkthrough.py"]);
});

test("exec records uncertainty when the transport reports it, without replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-host-"));
  const relay = Relay.open(dir);
  await relay.submissions.saveSessionBeforeConnect({
    sessionId: "session-u",
    taskId: "task-1",
    target: TARGET,
    createdAt: new Date().toISOString(),
    state: "active",
    executions: [],
  });
  const responses = new Map<string, FramedResponse>();
  // A gate that holds the request in flight until the test installs the
  // uncertainty response keyed by the durably persisted execution id.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const base = fakeTransport(responses);
  const gatingTransport: SessionTransport = {
    ...base,
    async send(request: FramedRequest) {
      await gate;
      return responses.get(request.executionId) ?? {
        executionId: request.executionId,
        outcome: { kind: "completed", exitStatus: { code: 0, signal: null } },
      };
    },
  };
  const session = await relay.attach("session-u", gatingTransport);
  const execPromise = session.exec(["true"]);
  // The execution id is durably persisted before transmission; poll briefly
  // for it, then install an in-flight uncertainty response.
  let executionId: string | undefined;
  for (let i = 0; i < 100 && !executionId; i++) {
    executionId = (await relay.submissions.listExecutions("session-u"))[0]?.executionId;
    if (!executionId) await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(executionId, "execution id must be durably persisted before transmission");
  responses.set(executionId, {
    executionId,
    outcome: { kind: "uncertain", diagnostic: "transport closed after admission" },
  });
  release();
  const result = await execPromise;
  assert.equal(result.outcome.kind, "uncertain");

  const record = await relay.submissions.getExecution("session-u", executionId!);
  assert.equal(record?.state, "uncertain");
  // No resubmission: exactly one execution record exists.
  assert.equal((await relay.submissions.listExecutions("session-u")).length, 1);
});
