/**
 * EXECUTION-01 / SCRIPT-01 unit layer: the same action, observation, and
 * failure sequence through direct submission (exec) and uploaded scripts
 * (JS/TS/Python) must produce equivalent receipts — original arguments,
 * deployed script identity, parent identity, preserved failure outcomes —
 * and handle semantics must hold on every path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Relay, type SessionTransport, type FramedRequest, type FramedResponse, type FinishResult } from "../src/index.js";

// Fixture sessions record a target string but never open a connection with
// it, so a fixed documentation placeholder (RFC 5737) is fine here.
const TARGET = "user@192.0.2.10";

interface RecordedCall {
  readonly request: FramedRequest;
  readonly uploadCalls: number;
}

function scriptAwareTransport(
  responses: Map<string, FramedResponse>,
  calls: FramedRequest[],
  uploads: Array<{ localPath: string; remotePath: string; scriptId: string }>,
): SessionTransport {
  return {
    async send(request) {
      calls.push(request);
      return responses.get(request.executionId) ?? {
        executionId: request.executionId,
        outcome: { kind: "completed", exitStatus: { code: 0, signal: null } },
      };
    },
    async upload(localPath, options) {
      uploads.push({ localPath, remotePath: options.remotePath, scriptId: `script-${uploads.length}` });
      return { scriptId: `script-${uploads.length - 1}`, path: options.remotePath };
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

async function setup(): Promise<{ dir: string; relay: Relay; sessionDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "relay-equiv-"));
  const sessionDir = join(dir, "scripts");
  await mkdir(sessionDir, { recursive: true });
  const relay = Relay.open(dir);
  await relay.submissions.saveSessionBeforeConnect({
    sessionId: "session-equiv",
    taskId: "task-stage2",
    target: TARGET,
    createdAt: new Date().toISOString(),
    state: "active",
    executions: [],
  });
  return { dir, relay, sessionDir };
}

test("exec and uploaded JS/TS/Python scripts produce equivalent receipts (EXECUTION-01)", async () => {
  const { relay, sessionDir } = await setup();
  const calls: FramedRequest[] = [];
  const uploads: Array<{ localPath: string; remotePath: string; scriptId: string }> = [];
  const session = await relay.attach("session-equiv", scriptAwareTransport(new Map(), calls, uploads));

  // Path A: direct SSH submission.
  const execResult = await session.exec(["echo", "walkthrough-step"]);

  // Paths B–D: the same step as uploaded JS, TS, and Python scripts.
  const scripts: Array<{ name: string; language: "javascript" | "typescript" | "python"; body: string }> = [
    { name: "step.js", language: "javascript", body: "console.log('walkthrough-step');\n" },
    { name: "step.ts", language: "typescript", body: "const msg: string = 'walkthrough-step';\nconsole.log(msg);\n" },
    { name: "step.py", language: "python", body: "print('walkthrough-step')\n" },
  ];
  const results = [execResult];
  for (const script of scripts) {
    const localPath = join(sessionDir, script.name);
    await writeFile(localPath, script.body);
    const result = await session.runScript(localPath, `task/scripts/${script.name}`, script.language);
    results.push(result);
  }

  // Every path yields a completed receipt with its own execution identity.
  for (const r of results) {
    assert.equal(r.outcome.kind, "completed");
    assert.match(r.executionId, /^execution-/);
  }
  const ids = new Set(results.map((r) => r.executionId));
  assert.equal(ids.size, 4, "each path has an individual receipt identity");

  // Script receipts carry deployed-script identity + content hash + parent.
  const executions = await relay.submissions.listExecutions("session-equiv");
  assert.equal(executions.length, 4);
  const [execReceipt, ...scriptReceipts] = executions;
  assert.equal(execReceipt.argv[0], "echo");
  assert.equal(execReceipt.script, undefined);
  assert.equal(execReceipt.sessionId, "session-equiv", "parent execution identity");

  for (const receipt of scriptReceipts) {
    assert.ok(receipt.script, "script receipt carries deployed script identity");
    assert.match(receipt.script!.sha256, /^[0-9a-f]{64}$/);
    assert.ok(receipt.script!.scriptId);
    assert.equal(receipt.sessionId, "session-equiv");
    // Original interpreter argv is preserved, pointing at the deployed path.
    assert.ok(receipt.argv.at(-1)!.endsWith(receipt.script!.remotePath.split("/").pop()!));
  }
  // The three uploads happened exactly once each, before execution.
  assert.equal(uploads.length, 3);
  // Requests carry the script identity and hash over the wire.
  const scriptRequests = calls.filter((c) => c.kind === "script");
  assert.equal(scriptRequests.length, 3);
  for (const request of scriptRequests) {
    assert.ok(request.scriptId && request.scriptSha256);
  }
});

test("failure outcomes are preserved identically across paths (EXECUTION-01)", async () => {
  const { relay, sessionDir } = await setup();
  const responses = new Map<string, FramedResponse>();
  const failing: FramedResponse = {
    executionId: "",
    outcome: { kind: "completed", exitStatus: { code: 3, signal: null } },
  };
  // A failing exit status is still a completed receipt (the process ran);
  // a transport-reported failure is uncertainty. Preserve both faithfully.
  const session = await relay.attach("session-equiv", {
    ...scriptAwareTransport(responses, [], []),
    async send(request) {
      return {
        executionId: request.executionId,
        outcome:
          request.kind === "exec"
            ? { kind: "completed", exitStatus: { code: 3, signal: null } }
            : { kind: "completed", exitStatus: { code: 1, signal: null } },
      };
    },
  });

  const execResult = await session.exec(["false"]);
  const localPath = join(sessionDir, "fail.js");
  await writeFile(localPath, "process.exit(1);\n");
  const scriptResult = await session.runScript(localPath, "task/scripts/fail.js", "javascript");

  const execRecord = await relay.submissions.getExecution("session-equiv", execResult.executionId);
  const scriptRecord = await relay.submissions.getExecution("session-equiv", scriptResult.executionId);
  assert.equal(execRecord?.state, "completed");
  assert.equal(scriptRecord?.state, "completed");
  assert.equal((execRecord?.outcome as { exitStatus: { code: number } }).exitStatus.code, 3);
  assert.equal((scriptRecord?.outcome as { exitStatus: { code: number } }).exitStatus.code, 1);
  void responses; void failing;
});

test("transport loss during script execution records uncertainty without replay (D14)", async () => {
  const { relay, sessionDir } = await setup();
  const session = await relay.attach("session-equiv", {
    ...scriptAwareTransport(new Map(), [], []),
    async send(request) {
      return { executionId: request.executionId, outcome: { kind: "uncertain", diagnostic: "ssh closed mid-run" } };
    },
  });
  const localPath = join(sessionDir, "lost.py");
  await writeFile(localPath, "print('never confirmed')\n");
  const result = await session.runScript(localPath, "task/scripts/lost.py", "python");
  assert.equal(result.outcome.kind, "uncertain");
  const record = await relay.submissions.getExecution("session-equiv", result.executionId);
  assert.equal(record?.state, "uncertain");
  // No resubmission on inspection.
  assert.equal((await relay.submissions.listExecutions("session-equiv")).length, 1);
});
