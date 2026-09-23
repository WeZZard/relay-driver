/**
 * Remote runtime receiver (deployed to the assigned machine at
 * /var/tmp/relay-driver-runtime/receive.js).
 *
 * Reads one framed request (JSON) from stdin, executes it under the runtime
 * contracts (durable record store, admission engine, capture gate, resource
 * supervision), and writes one framed response (JSON) to stdout. One request
 * per invocation: the SSH transport spawns `node receive.js` per request, so
 * transport loss maps to process loss and recovery is per-request.
 *
 * Supported request kinds:
 *   exec     — run an argv under the session (child process, timed, recorded)
 *   script   — run an uploaded JS/TS/Python script the same way
 *   sequence — run N argv steps, EACH under its own admission/engine.call,
 *              with a live D19 supervisor (resource sampling + capture
 *              health + monotonic deadline). Used for CAPTURE-01/RESOURCE-01
 *              proofs on the remote machine.
 *
 * The response is ALWAYS a single JSON object on stdout (even on internal
 * error), so the host can parse a receipt or mark uncertainty.
 */

import { SnapshotStore } from "./snapshots.js";
import { snapshotsParamsOf } from "./request-params.js";
import { captureDisplayToFile as captureDisplayToFileImpl } from "./driver-capture.js";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { RecordStore } from "./record-store.js";
import { CaptureGate } from "./capture-gate.js";
import { AdmissionEngine, AdmissionRefusedError } from "./admission.js";
import { ResourceManager, Supervisor } from "./resources.js";
import { resolveArgv } from "./argv.js";

const ROOT = process.env.RELAY_RUNTIME_ROOT || "/var/tmp/relay-driver-runtime";
const CUAD = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";

function emit(response: unknown) {
  process.stdout.write(JSON.stringify(response) + "\n");
}

async function readRequest(): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Run an argv with chunk-level output accounting against the resource manager (D19). */
function runArgv(
  argv: readonly string[],
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
  options: { timeoutMs?: number; resources?: ResourceManager; accountingKey?: string } = {},
): Promise<any> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const cap = 64 * 1024;
    let outputRefused = false;
    const reserveChunk = (bytes: number): boolean => {
      if (!options.resources) return true;
      try {
        options.resources.reserveOutput(options.accountingKey ?? argv.join(" "), bytes);
        options.resources.commitReserved(options.accountingKey ?? argv.join(" "), bytes);
        return true;
      } catch {
        return false;
      }
    };
    child.stdout.on("data", (c) => {
      if (stdout.length < cap) stdout += c;
      if (!reserveChunk((c as Buffer).length)) {
        // Per-execution output cap exceeded: stop the affected work (D19).
        outputRefused = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (c) => {
      if (stderr.length < cap) stderr += c;
      if (!reserveChunk((c as Buffer).length)) {
        outputRefused = true;
        child.kill("SIGKILL");
      }
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ exitStatus: { code: null, signal: "SIGKILL" }, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitStatus: { code: null, signal: null }, stdout, stderr: `${stderr}${err.message}`, spawnError: err.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitStatus: { code, signal },
        stdout,
        stderr,
        outputRefused,
        outputTruncated: stdout.length >= cap || stderr.length >= cap,
      });
    });
  });
}

/** Call a cua-driver tool through its CLI. Returns parsed JSON result. */
async function cuaCall(tool: string, argsJson: string, timeoutMs = 60_000): Promise<any> {
  const result = await runArgv([CUAD, "call", tool, "--json", argsJson], undefined, process.env, { timeoutMs });
  try {
    return { ok: true, value: JSON.parse(result.stdout), raw: result };
  } catch {
    return { ok: false, value: result, raw: result };
  }
}

/**
 * Snapshot capability probe (SNAP-01): capture readiness = the ability to
 * take a display screenshot right now. We probe by asking the driver for
 * the desktop state WITHOUT requesting a screenshot payload beyond a
 * capability confirmation — the cheapest full-display capture.
 */
async function observeCapture(capture: CaptureGate): Promise<{ ready: boolean }> {
  // Probe with a throwaway file target: the driver then returns the small
  // structured response instead of megabytes of inline base64 (which would
  // trip the child-output cap). A successful structured reply proves
  // display screenshot capability; failure means capture is unavailable.
  const probeFile = join(ROOT, ".capture-probe.png");
  const probe = await cuaCall("get_desktop_state", JSON.stringify({ screenshot_out_file: probeFile }));
  const ok = probe.ok && probe.value && typeof probe.value === "object" &&
    (probe.value.screen_width !== undefined || probe.value.display !== undefined);
  capture.update({
    ready: !!ok,
    observedAtMonotonic: Date.now(),
    diagnostic: ok ? undefined : "display screenshot capability not available (driver call failed)",
  });
  return { ready: !!ok };
}

async function main() {
  const request = await readRequest();
  await mkdir(ROOT, { recursive: true });
  const store = await RecordStore.create(join(ROOT, "state"));
  const capture = new CaptureGate();

  try {
    const sessionId = request.sessionId ?? "session-unframed";
    const attemptId = request.attemptId ?? "attempt-unframed";

    if (request.kind === "sequence") {
      // Multi-action run: one admission per step, live supervision (D19).
      const resources = new ResourceManager({
        taskStorageBytes: request.budgets?.taskStorageBytes ?? 100 * 1024 * 1024,
        stopAllowanceBytes: request.budgets?.stopAllowanceBytes ?? 10 * 1024 * 1024,
        perExecutionOutputBytes: request.budgets?.perExecutionOutputBytes ?? 64 * 1024,
        relayBufferBytes: request.budgets?.relayBufferBytes ?? 1 * 1024 * 1024,
        volumeFloorBytes: request.budgets?.volumeFloorBytes ?? 0,
        volumePaths: [ROOT],
        pollIntervalMs: request.budgets?.pollIntervalMs ?? 500,
      });
      const steps: Array<{ argv: string[]; title?: string }> = request.steps ?? [];
      const results: Array<{ title?: string; outcome: unknown }> = [];
      let firstStop: string | undefined;
      let cancelled = false;

      // Observe capture health BEFORE the first admission (the supervisor's
      // first tick may lag the first step otherwise).
      const initial = await observeCapture(capture);
      if (!initial.ready) {
        emit({
          executionId: request.executionId,
          outcome: { kind: "refused", diagnostic: capture.checkAdmission() ?? "capture unavailable" },
        });
        return;
      }

      const supervisor = Supervisor.start(resources, {
        deadlineAtMonotonic: Date.now() + (request.deadlineMs ?? 120_000),
        pollIntervalMs: request.budgets?.pollIntervalMs ?? 500,
        maxObservationAgeMs: request.maxObservationAgeMs ?? 5_000,
        onSample: async () => {
          const obs = await resources.sampleVolume();
          resources.checkVolumeCapacity(obs);
          await observeCapture(capture);
          const refusal = capture.checkAdmission();
          return refusal ? { healthy: false, diagnostic: refusal } : { healthy: true };
        },
        onStop: (diagnostic) => {
          firstStop ??= diagnostic;
          cancelled = true;
          void store.appendJournal({
            kind: "resource-stop",
            sessionId,
            attemptId,
            state: "incomplete",
            diagnostic,
            observed: resources.lastSample,
            thresholds: request.budgets ?? {},
          }).catch(() => {});
        },
      });

      const snapshotStore = new SnapshotStore(
        (out) => captureDisplayToFileImpl(out, cuaCall),
        store,
        join(ROOT, "state"),
      );
      for (const [i, step] of steps.entries()) {
        if (cancelled) break;
        const engine = new AdmissionEngine(store, capture, { sessionId, attemptId }, snapshotStore);
        try {
          // Per-step freshness: re-observe capture health immediately before
          // each admission so a loss between actions is caught even when the
          // step duration is shorter than the supervisor interval.
          const fresh = await observeCapture(capture);
          if (!fresh.ready) {
            throw new AdmissionRefusedError(
              capture.checkAdmission() ?? "capture unavailable between actions",
            );
          }
          const { resolved, env } = await resolveArgv(step.argv);
          const stepSnapshots = snapshotsParamsOf({ snapshots: (step as { snapshots?: unknown }).snapshots });
          const outcome = await engine.call(
            {
              stepId: `${request.step?.id ?? "seq"}-${i}`,
              title: step.title ?? `${step.argv.join(" ")}`,
              inputMode: (step as { inputMode?: string }).inputMode as "ordinary" | "accessibility" | undefined,
              snapshots: stepSnapshots,
              dispatchIdentity: (step as { dispatchIdentity?: string }).dispatchIdentity ?? `${step.title ?? step.argv.join(" ")}`,
            },
            () => runArgv(resolved, request.cwd, env, {
              resources,
              accountingKey: `${request.executionId}-${i}`,
            }),
          );
          if (outcome.outputRefused) {
            // Output cap stop: declare the resource stop, record it, refuse
            // the rest of the run (D19: stop affected work, keep evidence).
            firstStop ??= "per-execution output cap exceeded";
            cancelled = true;
            resources.declareStop(firstStop);
            void store.appendJournal({
              kind: "resource-stop",
              sessionId,
              attemptId,
              state: "incomplete",
              diagnostic: firstStop,
              observed: resources.lastSample,
            }).catch(() => {});
          }
          results.push({
            title: step.title,
            outcome: {
              kind: outcome.outputRefused ? "refused" : outcome.spawnError ? "uncertain" : "completed",
              exitStatus: outcome.exitStatus,
              stdoutTail: outcome.stdout.slice(-500),
              stderrTail: outcome.stderr.slice(-500),
              timedOut: !!outcome.timedOut,
              outputTruncated: !!outcome.outputTruncated,
              outputRefused: !!outcome.outputRefused,
              snapshots: engine.actionSnapshots,
            },
          });
          if (outcome.outputRefused) break;
        } catch (err) {
          const refused = err instanceof AdmissionRefusedError;
          results.push({
            title: step.title,
            outcome: refused
              ? { kind: "refused", diagnostic: err.message }
              : { kind: "uncertain", diagnostic: err instanceof Error ? err.message : String(err) },
          });
          if (refused) break; // capture/resource refusal: stop the run
        }
      }
      supervisor.stopWatching();

      emit({
        executionId: request.executionId,
        outcome: {
          kind: "completed",
          sequence: results,
          stopDiagnostic: firstStop,
          resourceStopped: resources.isStopped,
        },
      });
      return;
    }

    // exec / script: establish capture readiness (screenshot capability),
    // verify identity, run once.
    await observeCapture(capture);
    const snapshotStore = new SnapshotStore(
      (out) => captureDisplayToFileImpl(out, cuaCall),
      store,
      join(ROOT, "state"),
    );

    if (request.kind === "script") {
      let statInfo;
      try {
        statInfo = await stat(request.remotePath);
      } catch {
        emit({
          executionId: request.executionId,
          outcome: { kind: "refused", diagnostic: `deployed script missing: ${request.remotePath}` },
        });
        return;
      }
      const bytes = await readFile(request.remotePath);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== request.scriptSha256) {
        emit({
          executionId: request.executionId,
          outcome: { kind: "refused", diagnostic: `script hash mismatch: expected ${request.scriptSha256}, deployed ${sha256}` },
        });
        return;
      }
      void statInfo;
    }

    // Per-execution output accounting for the single-shot path (D19); the
    // request may override the cap within the task budget.
    const singleResources = new ResourceManager({
      taskStorageBytes: request.budgets?.taskStorageBytes ?? 100 * 1024 * 1024,
      stopAllowanceBytes: request.budgets?.stopAllowanceBytes ?? 10 * 1024 * 1024,
      perExecutionOutputBytes: request.budgets?.perExecutionOutputBytes ?? 64 * 1024,
      relayBufferBytes: request.budgets?.relayBufferBytes ?? 1 * 1024 * 1024,
      volumeFloorBytes: request.budgets?.volumeFloorBytes ?? 0,
      volumePaths: [ROOT],
      pollIntervalMs: request.budgets?.pollIntervalMs ?? 500,
    });

    if (request.kind === "code") {
      // Streamed-code path (EXECUTION-01): the code text arrived inside the
      // framed request. Verify the declared hash over the received bytes,
      // materialize it under the runtime's streamed-code directory, and run
      // it through the same admission/record/resource contracts as an
      // uploaded script. Identity survives the stream: the hash is declared
      // before transmission and checked against the received bytes.
      const code = request.code;
      const codeSha256 = request.codeSha256;
      if (typeof code !== "string" || !codeSha256) {
        emit({ executionId: request.executionId, outcome: { kind: "refused", diagnostic: "streamed-code request missing code or codeSha256" } });
        return;
      }
      const receivedSha256 = createHash("sha256").update(code, "utf8").digest("hex");
      if (receivedSha256 !== codeSha256) {
        emit({ executionId: request.executionId, outcome: { kind: "refused", diagnostic: `streamed code hash mismatch: expected ${codeSha256}, received ${receivedSha256}` } });
        return;
      }
      const ext =
        request.language === "python" ? ".py" : request.language === "typescript" ? ".ts" : ".js";
      const streamedDir = join(ROOT, "streamed");
      await mkdir(streamedDir, { recursive: true });
      const remotePath = join(streamedDir, `${request.executionId}${ext}`);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(remotePath, code, "utf8");
      // Hash the materialized file back — the executed bytes, not just the
      // in-memory string, are what the evidence cites.
      const materialized = await readFile(remotePath);
      const materializedSha256 = createHash("sha256").update(materialized).digest("hex");
      if (materializedSha256 !== codeSha256) {
        emit({ executionId: request.executionId, outcome: { kind: "refused", diagnostic: `materialized streamed code hash mismatch: ${materializedSha256}` } });
        return;
      }
      const interpreter =
        request.language === "python" ? "python3" : request.language === "typescript" ? "tsx" : "node";
      const argv = [interpreter, remotePath];

      const streamedResources = new ResourceManager({
        taskStorageBytes: request.budgets?.taskStorageBytes ?? 100 * 1024 * 1024,
        stopAllowanceBytes: request.budgets?.stopAllowanceBytes ?? 10 * 1024 * 1024,
        perExecutionOutputBytes: request.budgets?.perExecutionOutputBytes ?? 64 * 1024,
        relayBufferBytes: request.budgets?.relayBufferBytes ?? 1 * 1024 * 1024,
        volumeFloorBytes: request.budgets?.volumeFloorBytes ?? 0,
        volumePaths: [ROOT],
        pollIntervalMs: request.budgets?.pollIntervalMs ?? 500,
      });

      const { resolved, env } = await resolveArgv(argv);
      const engine = new AdmissionEngine(store, capture, { sessionId, attemptId }, snapshotStore);
      const outcome = await engine.call(
        {
          stepId: request.step?.id,
          title: request.step?.title ?? `code: ${remotePath}`,
          inputMode: request.step?.inputMode,
          snapshots: snapshotsParamsOf(request),
          dispatchIdentity: request.step?.id ?? "streamed-code",
        },
        () => runArgv([...resolved], request.cwd, env, { resources: streamedResources, accountingKey: request.executionId }),
      );

      emit({
        executionId: request.executionId,
        outcome: {
          kind: outcome.spawnError ? "uncertain" : "completed",
          exitStatus: outcome.exitStatus,
          stdoutTail: outcome.stdout.slice(-2000),
          stderrTail: outcome.stderr.slice(-2000),
          timedOut: !!outcome.timedOut,
          outputTruncated: !!outcome.outputTruncated,
          outputRefused: !!outcome.outputRefused,
          codeIdentity: { sha256: codeSha256, remotePath, language: request.language },
          snapshots: engine.actionSnapshots,
        },
      });
      return;
    }

    if (request.kind === "script" || request.kind === "exec") {
      const argv = request.argv;
      if (!argv) {
        emit({ executionId: request.executionId, outcome: { kind: "refused", diagnostic: "request missing argv" } });
        return;
      }

      const { resolved, env } = await resolveArgv(argv);
      const engine = new AdmissionEngine(store, capture, { sessionId, attemptId }, snapshotStore);
      const outcome = await engine.call(
        {
          stepId: request.step?.id,
          title: request.step?.title ?? `${request.kind}: ${argv.join(" ")}`,
          inputMode: request.step?.inputMode,
          snapshots: snapshotsParamsOf(request),
          dispatchIdentity: request.step?.id ?? `${request.kind}-${argv[0] ?? ""}`,
        },
        () => runArgv([...resolved], request.cwd, env, { resources: singleResources, accountingKey: request.executionId }),
      );

      emit({
        executionId: request.executionId,
        outcome: {
          kind: outcome.spawnError ? "uncertain" : "completed",
          exitStatus: outcome.exitStatus,
          stdoutTail: outcome.stdout.slice(-2000),
          stderrTail: outcome.stderr.slice(-2000),
          timedOut: !!outcome.timedOut,
          outputTruncated: !!outcome.outputTruncated,
          outputRefused: !!outcome.outputRefused,
          snapshots: engine.actionSnapshots,
        },
      });
      return;
    }

    emit({ executionId: request.executionId, outcome: { kind: "refused", diagnostic: `unknown request kind: ${request.kind}` } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({
      executionId: request.executionId,
      outcome: { kind: "uncertain", diagnostic: `receiver error: ${message}` },
    });
  } finally {
    await store.close().catch(() => {});
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  emit({
    executionId: "unknown",
    outcome: { kind: "uncertain", diagnostic: `fatal: ${message}` },
  });
});
