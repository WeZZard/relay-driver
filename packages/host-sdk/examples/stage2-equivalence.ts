/**
 * Stage 2 proof (EXECUTION-01 / SCRIPT-01): run the same trajectory step
 * through direct SSH submission and uploaded JS/TS/Python scripts against
 * the real remote runtime on RELAY_SSH_HOST, then compare receipts.
 */

import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Relay, SshTransport } from "@wezzard/relay-driver-host-sdk";
import { requireTarget } from "./env.js";

const TARGET = requireTarget();
const REMOTE_ROOT = "/var/tmp/relay-driver-runtime";
const REMOTE_SCRIPTS = `/var/tmp/relay-driver-runtime/scripts`;
const SESSION_ID = process.env.RELAY_SESSION_ID ?? `session-stage2-${Date.now()}`;

async function main(): Promise<void> {
  const storeRoot = await mkdtemp(join(tmpdir(), "relay-stage2-"));
  const scriptDir = await mkdtemp(join(tmpdir(), "relay-stage2-scripts-"));
  const relay = Relay.open(storeRoot);
  relay.useTransport((options) => new SshTransport({ target: options.target, remoteRunner: `node ${REMOTE_ROOT}/receive.js` }));

  // D14: session identity persisted before connect.
  const session = await relay.start({
    target: TARGET,
    taskId: "task-stage2-equivalence",
    sessionId: SESSION_ID,
  });
  console.log("session:", session.sessionId);

  const step = { id: "step-1", title: "Echo the trajectory marker" };

  // Path A: direct SSH submission.
  const a = await session.exec(["echo", "trajectory-marker-42"], { step });
  console.log("exec receipt:", a.executionId, a.outcome.kind);

  // Paths B–D: uploaded JS, TS, Python — same marker, plus a loop and a
  // deliberate failure inside one script (SCRIPT-01 individual coverage).
  const scripts: Array<[string, "javascript" | "typescript" | "python", string]> = [
    ["step_success.js", "javascript", `
      const marker = 'trajectory-marker-42';
      let acc = '';
      for (let i = 0; i < 3; i++) acc += marker + ' ';
      console.log(acc.trim());
    `],
    ["step_success.ts", "typescript", `
      const marker: string = 'trajectory-marker-42';
      let acc: string = '';
      for (let i = 0; i < 3; i++) { acc += marker + ' '; }
      console.log(acc.trim());
    `],
    ["step_success.py", "python", `
marker = 'trajectory-marker-42'
acc = ''
for i in range(3):
    acc += marker + ' '
print(acc.strip())
    `],
  ];

  const receipts: Array<{ path: string; executionId: string; kind: string; stdout?: string }> = [
    { path: "exec", executionId: a.executionId, kind: a.outcome.kind, stdout: (a.outcome as any).stdoutTail },
  ];

  for (const [name, language, body] of scripts) {
    const localPath = join(scriptDir, name);
    await writeFile(localPath, body + "\n");
    const remotePath = `${REMOTE_SCRIPTS}/${SESSION_ID}/${name}`;
    const r = await session.runScript(localPath, remotePath, language, { step });
    console.log(`${language} receipt:`, r.executionId, r.outcome.kind);
    receipts.push({
      path: language,
      executionId: r.executionId,
      kind: r.outcome.kind,
      stdout: (r.outcome as any).stdoutTail,
    });
  }

  // Failure propagation: a script that exits nonzero (SCRIPT-01).
  const failPath = join(scriptDir, "step_fail.py");
  await writeFile(failPath, "import sys\nprint('about to fail')\nsys.exit(7)\n");
  const f = await session.runScript(failPath, `${REMOTE_SCRIPTS}/${SESSION_ID}/step_fail.py`, "python", {
    step: { id: "step-fail", title: "Deliberate failure" },
  });
  console.log("fail receipt:", f.executionId, f.outcome.kind, (f.outcome as any).exitStatus);

  // Handle semantics at the SDK boundary: second submission with the same
  // execution identity must not be possible (identity allocated internally).
  // Verify via the record store: no duplicate identity for the same argv.
  const executions = await relay.submissions.listExecutions(SESSION_ID);
  const ids = new Set(executions.map((e) => e.executionId));
  console.log("executions recorded:", executions.length, "unique:", ids.size);

  // Equivalence check: all four success paths produced the same marker output.
  const normalize = (s: string | undefined) => (s ?? "").split(/\s+/).filter((w) => w === "trajectory-marker-42").length;
  const markerCounts = receipts.map((r) => ({ path: r.path, markerCount: normalize(r.stdout) }));
  // exec echoes once; each script loops 3x and prints once. The SCRIPT-01
  // requirement is equivalent *semantics* (same marker observed, same
  // success/failure states), not identical output text.
  const allSucceeded = receipts.every((r) => r.kind === "completed");
  const allHaveMarker = markerCounts.every((m) => m.markerCount >= 1);
  console.log("equivalence (all completed, marker observed on every path):",
    allSucceeded && allHaveMarker ? "YES" : "NO", JSON.stringify(markerCounts));

  console.log(JSON.stringify({ receipts }, null, 2));
  await session.close();
}

main().then(
  () => process.exitCode = 0,
  (err) => {
    console.error("STAGE2 FAILED:", err);
    process.exitCode = 1;
  },
);
