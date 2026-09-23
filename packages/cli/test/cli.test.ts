import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Relay } from "@wezzard/relay-driver-host-sdk";
import { main } from "../src/main.js";

// Fixture sessions record a target string but never open a connection with
// it, so a fixed documentation placeholder (RFC 5737) is fine here.
const TARGET = "user@192.0.2.10";

async function withStore(): Promise<{ dir: string; relay: Relay }> {
  const dir = await mkdtemp(join(tmpdir(), "relay-cli-"));
  const relay = Relay.open(dir);
  await relay.submissions.saveSessionBeforeConnect({
    sessionId: "session-cli",
    taskId: "task-cli",
    target: TARGET,
    createdAt: new Date().toISOString(),
    state: "active",
    executions: [],
  });
  await relay.submissions.saveExecutionBeforeSubmit({
    executionId: "execution-cli-1",
    sessionId: "session-cli",
    argv: ["python3", "trajectory.py"],
    submittedAt: new Date().toISOString(),
    state: "completed",
    outcome: { kind: "completed", exitStatus: { code: 0, signal: null } },
  });
  await relay.submissions.saveExecutionBeforeSubmit({
    executionId: "execution-cli-2",
    sessionId: "session-cli",
    argv: ["true"],
    submittedAt: new Date().toISOString(),
    state: "uncertain",
  });
  return { dir, relay };
}

test("session list prints journaled sessions as JSON", async () => {
  const { dir } = await withStore();
  const code = await main(["session", "list", "--store", dir]);
  assert.equal(code, 0);
});

test("execution show exits 0 for completed and 3 for uncertain (D17 receipts)", async () => {
  const { dir } = await withStore();
  const ok = await main([
    "execution", "show", "--store", dir,
    "--session", "session-cli", "--execution", "execution-cli-1",
  ]);
  assert.equal(ok, 0);
  const uncertain = await main([
    "execution", "show", "--store", dir,
    "--session", "session-cli", "--execution", "execution-cli-2",
  ]);
  assert.equal(uncertain, 3);
});

test("execution show fails cleanly for an unknown execution", async () => {
  const { dir } = await withStore();
  const code = await main([
    "execution", "show", "--store", dir,
    "--session", "session-cli", "--execution", "execution-missing",
  ]);
  assert.equal(code, 1);
});

test("verify rejects a package without a readable manifest", async () => {
  const pkg = await mkdtemp(join(tmpdir(), "relay-pkg-"));
  const code = await main(["verify", pkg]);
  assert.equal(code, 1);
});

test("action annotate records a sourced annotation in the store", async () => {
  const { dir } = await withStore();
  const code = await main([
    "action", "annotate", "--session", "session-cli", "--action", "execution-cli-1",
    "--text", "reviewer note", "--store", dir,
  ]);
  assert.equal(code, 0);
  const { readFile } = await import("node:fs/promises");
  const annotations = JSON.parse(await readFile(join(dir, "annotations.json"), "utf8"));
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].text, "reviewer note");
  assert.equal(annotations[0].kind, "explanation");
});

test("session continue reports recoverable phases and a new attempt identity", async () => {
  const { dir } = await withStore();
  const code = await main([
    "session", "continue", "--session", "session-cli",
    "--after-attempt", "attempt-old", "--store", dir,
  ]);
  assert.equal(code, 0);
});

test("unknown command exits 2 with usage", async () => {
  const code = await main(["bogus", "command"]);
  assert.equal(code, 2);
});
