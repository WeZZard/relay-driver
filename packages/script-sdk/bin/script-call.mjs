#!/usr/bin/env node
// Per-call admission runner for Python (and other non-JS) scripts (SCRIPT-01).
// Reads one JSON request from stdin:
//   { "stateDir": "...", "parentExecutionId": "...", "stepId": "...",
//     "title": "...", "inputMode": "...", "argv": ["..."], "cwd": "..." }
// Admits the call under the runtime's admission engine, runs argv, retains
// completion, and prints one JSON receipt to stdout. A refusal prints
// {"refused": true, "diagnostic": "..."} and exits 3 without running argv.
import { RecordStore, CaptureGate, AdmissionEngine, AdmissionRefusedError, EvidenceWriteError, resolveArgv } from "@wezzard/relay-driver-remote-runtime";

const request = JSON.parse(await new Promise((resolve, reject) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (data += c));
  process.stdin.on("end", () => resolve(data));
  process.stdin.on("error", reject);
}));

const store = await RecordStore.create(request.stateDir);
const capture = new CaptureGate();

if (request.observeRecording) {
  // Probe the recorder exactly as the runtime does, so the script's calls
  // observe fresh capture health rather than trusting a stale claim.
  const { spawn } = await import("node:child_process");
  const probe = await new Promise((resolve) => {
    const child = spawn("/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
      ["call", "get_recording_state", "--json", "{}"], {});
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(out));
  });
  let recording = false, diagnostic = "driver probe failed";
  if (probe) {
    try {
      const parsed = JSON.parse(probe);
      recording = !!parsed.recording;
      diagnostic = recording ? undefined : "driver reports recording disabled";
    } catch { /* keep failure diagnostic */ }
  }
  capture.update({ recording, diagnostic, observedAtMonotonic: Date.now() });
}

const engine = new AdmissionEngine(store, capture, {
  sessionId: request.sessionId ?? "session-unframed",
  attemptId: request.attemptId ?? "attempt-unframed",
});

try {
  const { resolved, env } = await resolveArgv(request.argv);
  const value = await engine.call(
    {
      stepId: request.stepId,
      title: request.title,
      inputMode: request.inputMode,
      parentExecutionId: request.parentExecutionId,
    },
    async () => {
      const { spawn } = await import("node:child_process");
      return await new Promise((resolve, reject) => {
        const child = spawn(resolved[0], resolved.slice(1), { cwd: request.cwd, env });
        let out = "", err = "";
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (err += c));
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ exitStatus: { code, signal }, stdout: out.slice(-2000), stderr: err.slice(-2000) }));
      });
    },
  );
  console.log(JSON.stringify({ ok: true, value }));
} catch (err) {
  if (err instanceof AdmissionRefusedError) {
    console.log(JSON.stringify({ refused: true, diagnostic: err.message }));
    process.exit(3);
  }
  console.log(JSON.stringify({ error: String(err) }));
  process.exit(1);
}
