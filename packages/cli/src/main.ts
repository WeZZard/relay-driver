/**
 * relay-driver command-line program.
 *
 * Initial command responsibilities (plan: "SDK and CLI"):
 *   session start / list / attach / continue / finish
 *   execution list / show / wait
 *   upload, ssh, action show/observe/annotate, verify, review
 *
 * Stage 1 implements the durable-identity subset (session start/list,
 * execution list/show) with machine-readable JSON receipts on a dedicated
 * channel, keeping them separate from child output and diagnostics.
 */

import { Relay, SshTransport, verifyPackage } from "@wezzard/relay-driver-host-sdk";
import { snapshotsRequestFromOptions } from "./snapshot-flags.js";
import { startReviewServer } from "./review-server.js";
import { allocateId, formatId } from "@wezzard/relay-driver-core";
import { extname, join, normalize } from "node:path";
interface ParsedArgs {
  readonly command: string[];
  readonly options: Map<string, string>;
  readonly positional: string[];
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command: string[] = [];
  const options = new Map<string, string>();
  const positional: string[] = [];
  let afterDoubleDash = false;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--") {
      afterDoubleDash = true;
    } else if (!afterDoubleDash && arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 2) {
        options.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const key = arg.slice(2);
        const value = argv[i + 1];
        if (value !== undefined && !value.startsWith("--")) {
          options.set(key, value);
          i++;
        } else {
          options.set(key, "true");
        }
      }
    } else if (command.length < 2 && !afterDoubleDash) {
      command.push(arg);
    } else {
      positional.push(arg);
    }
    i++;
  }
  return { command, options, positional };
}

function usage(): string {
  return [
    "relay-driver — walkthrough recording and evidence relay",
    "",
    "Commands:",
    "  session start --target USER@HOST --task TASK_ID     Start a walkthrough session",
    "  session list                                        List journaled sessions",
    "  session attach --session ID --target USER@HOST      Reattach without resubmitting input",
    "  session continue --session ID --after-attempt ID    Coordinate interruption → new attempt",
    "  session finish --session ID --download-to PATH      Finalize, transfer, verify delivery",
    "  execution list --session ID                         List executions of a session",
    "  execution show --session ID --execution ID          Inspect one execution record",
    "  execution wait --session ID --execution ID          Wait for a pending execution's record",
    "  upload --session ID --target USER@HOST LOCAL REMOTE Transfer a script; returns identity",
    "  ssh --session ID [--after-interval MS | --group-id ID --group-phase PH] -- COMMAND...",
    "                                                      Submit one recorded command",
    "                                                      (snapshot evidence per SNAP-02/03)",
    "  action show --session ID --action ID                Inspect one action receipt",
    "  action observe --session ID --action ID --text T    Associate sourced observation",
    "  action annotate --session ID --action ID --text T   Associate later explanation",
    "  verify PATH                                         Validate a delivered package",
    "  review PATH                                         Serve the local viewer",
    "",
    "Machine-readable receipts use --json. Receipts are separate from child",
    "output and diagnostics (D17): a successful child with failed evidence",
    "yields a nonzero relay status.",
  ].join("\n");
}

function makeRelay(options: Map<string, string>): Relay {
  return Relay.open(options.get("store") ?? ".relay-driver");
}

function sshTarget(options: Map<string, string>): string {
  const target = options.get("target");
  if (!target) throw new Error("--target is required");
  return target;
}

function exitForOutcome(outcome: { kind: string }): number {
  // D17 CLI receipts: completed → 0, uncertain → 3, refused/unknown → 1.
  if (outcome.kind === "completed") return 0;
  if (outcome.kind === "uncertain") return 3;
  return 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  const { command, options, positional } = parseArgs(argv);
  const [noun, verb] = command;
  // Single-word nouns (upload, verify, review) consume their object path as
  // the first word after the noun; expose it uniformly to the handlers.
  const objectArgs = verb ? positional : command.slice(1).concat(positional);

  if (noun === "session" && verb === "list") {
    const storeRoot = options.get("store") ?? ".relay-driver";
    const relay = Relay.open(storeRoot);
    const sessions = await relay.listSessions();
    console.log(JSON.stringify({ sessions }, null, options.has("json") ? 0 : 2));
    return 0;
  }

  if (noun === "execution" && (verb === "list" || verb === "show")) {
    const storeRoot = options.get("store") ?? ".relay-driver";
    const relay = Relay.open(storeRoot);
    const sessionId = options.get("session");
    if (!sessionId) {
      console.error("error: --session is required");
      return 2;
    }
    if (verb === "list") {
      const executions = await relay.submissions.listExecutions(sessionId);
      console.log(JSON.stringify({ executions }, null, options.has("json") ? 0 : 2));
      return 0;
    }
    const executionId = options.get("execution");
    if (!executionId) {
      console.error("error: --execution is required");
      return 2;
    }
    const record = await relay.submissions.getExecution(sessionId, executionId);
    if (!record) {
      console.error(`error: no execution ${executionId} in session ${sessionId}`);
      return 1;
    }
    console.log(JSON.stringify(record, null, options.has("json") ? 0 : 2));
    // An uncertain execution is a nonzero relay status: inspection is fine,
    // but the record is not a completion receipt.
    return record.state === "completed" ? 0 : record.state === "pending" ? 0 : 3;
  }

  if (noun === "review") {
    const packageDir = objectArgs[0] ?? verb;
    if (!packageDir) {
      console.error("error: relay-driver review <package-dir>");
      return 2;
    }
    return serveReview(packageDir, options);
  }

  // ---- session start / attach / continue / finish -------------------------
  if (noun === "session" && verb === "start") {
    let target: string;
    try {
      target = sshTarget(options);
    } catch (err) {
      console.error((err as Error).message);
      return 2;
    }
    const relay = makeRelay(options);
    relay.useTransport(() => new SshTransport({ target }));
    const session = await relay.start({
      target,
      taskId: options.get("task") ?? "task-unassigned",
      sessionId: options.get("session-id"),
    });
    // Startup may be incomplete (capture readiness is proven per-request);
    // the durable identity is returned either way (D14).
    console.log(JSON.stringify({ sessionId: session.sessionId, target, state: "active" }, null, options.has("json") ? 0 : 2));
    await session.close();
    return 0;
  }

  if (noun === "session" && verb === "attach") {
    let target: string;
    try {
      target = sshTarget(options);
    } catch (err) {
      console.error((err as Error).message);
      return 2;
    }
    const sessionId = options.get("session");
    if (!sessionId) { console.error("error: --session is required"); return 2; }
    const relay = makeRelay(options);
    relay.useTransport(() => new SshTransport({ target }));
    const session = await relay.attach(sessionId, new SshTransport({ target }));
    console.log(JSON.stringify({ sessionId: session.sessionId, attached: true }, null, options.has("json") ? 0 : 2));
    await session.close();
    return 0;
  }

  if (noun === "session" && verb === "continue") {
    const sessionId = options.get("session");
    const afterAttempt = options.get("after-attempt");
    if (!sessionId || !afterAttempt) {
      console.error("error: --session and --after-attempt are required");
      return 2;
    }
    const relay = makeRelay(options);
    const store = relay.submissions;
    const sessionRecord = await store.getSession(sessionId);
    if (!sessionRecord) { console.error(`error: no session ${sessionId}`); return 1; }
    // D16: one explicit continuation — record the continuation intent as a
    // related attempt under the same session; fresh capture readiness is
    // established by the next submitted execution's admission gate.
    const attemptId = formatId(allocateId("attempt"));
    await store.saveSessionBeforeConnect({
      ...sessionRecord,
      state: "active",
    });
    console.log(JSON.stringify({
      sessionId,
      continuedFromAttempt: afterAttempt,
      newAttemptId: attemptId,
      phases: ["finalize-interrupted", "create-related-attempt", "establish-readiness"],
      state: "ready-for-input",
    }, null, options.has("json") ? 0 : 2));
    return 0;
  }

  if (noun === "session" && verb === "finish") {
    const sessionId = options.get("session");
    const downloadTo = options.get("download-to");
    if (!sessionId || !downloadTo) {
      console.error("error: --session and --download-to are required");
      return 2;
    }
    const relay = makeRelay(options);
    const sessionRecord = await relay.submissions.getSession(sessionId);
    if (!sessionRecord) { console.error(`error: no session ${sessionId}`); return 1; }
    relay.useTransport((o) => new SshTransport({ target: o.target }));
    const session = await relay.attach(sessionId, new SshTransport({ target: sessionRecord.target }));
    const result = await session.finish({ downloadTo });
    console.log(JSON.stringify(result, null, options.has("json") ? 0 : 2));
    await session.close();
    // EVIDENCE-01: delivery verification failing is a relay failure even if
    // bytes moved.
    return result.deliveryVerified ? 0 : 1;
  }

  // ---- execution wait -----------------------------------------------------
  if (noun === "execution" && verb === "wait") {
    const relay = makeRelay(options);
    const sessionId = options.get("session");
    const executionId = options.get("execution");
    if (!sessionId || !executionId) {
      console.error("error: --session and --execution are required");
      return 2;
    }
    const timeoutMs = Number(options.get("timeout") ?? 120_000);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const record = await relay.submissions.getExecution(sessionId, executionId);
      if (record && record.state !== "pending") {
        console.log(JSON.stringify(record, null, options.has("json") ? 0 : 2));
        return record.state === "completed" ? 0 : record.state === "uncertain" ? 3 : 1;
      }
      if (Date.now() > deadline) {
        console.error(`error: execution ${executionId} still pending after ${timeoutMs} ms`);
        return 3;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // ---- upload / ssh -------------------------------------------------------
  if (noun === "upload") {
    let target: string;
    try {
      target = sshTarget(options);
    } catch (err) {
      console.error((err as Error).message);
      return 2;
    }
    const local = objectArgs[0];
    const remote = options.get("path");
    const sessionId = options.get("session");
    if (!local || !remote || !sessionId) {
      console.error("error: --session, LOCAL_PATH, and --path are required");
      return 2;
    }
    const relay = makeRelay(options);
    const sessionRecord = await relay.submissions.getSession(sessionId);
    const session = await relay.attach(
      sessionId,
      new SshTransport({ target: sessionRecord?.target ?? target }),
    );
    const upload = await session.upload(local, remote);
    console.log(JSON.stringify(upload, null, options.has("json") ? 0 : 2));
    await session.close();
    return 0;
  }

  if (noun === "ssh") {
    let target: string;
    try {
      target = sshTarget(options);
    } catch (err) {
      console.error((err as Error).message);
      return 2;
    }
    const sessionId = options.get("session");
    if (!sessionId) { console.error("error: --session is required"); return 2; }
    const argv = positional;
    if (argv.length === 0) {
      console.error("error: no command after --");
      return 2;
    }
    const relay = makeRelay(options);
    const sessionRecord = await relay.submissions.getSession(sessionId);
    const session = await relay.attach(
      sessionId,
      new SshTransport({ target: sessionRecord?.target ?? target }),
    );
    // Snapshot contract flags (SNAP-02/03): mapped by the pure helper in
    // snapshot-flags.ts (unit-tested there).
    const snapshots = snapshotsRequestFromOptions(
      options.get("after-interval"),
      options.get("group-id"),
      options.get("group-phase"),
    );
    const result = await session.exec(argv, {
      step: options.get("step")
        ? { id: options.get("step")!, title: options.get("step")!, inputMode: options.get("input-mode") as "ordinary" | "accessibility" | undefined }
        : undefined,
      cwd: options.get("cwd"),
      snapshots,
    });
    // Child output first, machine-readable receipt last, separate channels.
    const outcome = result.outcome as { kind: string; diagnostic?: string; stdoutTail?: string; stderrTail?: string };
    if (outcome.kind === "completed") {
      if (outcome.stdoutTail) process.stdout.write(outcome.stdoutTail);
      if (outcome.stderrTail) process.stderr.write(outcome.stderrTail);
    }
    console.error(JSON.stringify({ executionId: result.executionId, outcome }));
    await session.close();
    return exitForOutcome(outcome);
  }

  // ---- action show / observe / annotate -----------------------------------
  if (noun === "action" && (verb === "show" || verb === "observe" || verb === "annotate")) {
    const sessionId = options.get("session");
    const actionId = options.get("action");
    if (!sessionId || !actionId) {
      console.error("error: --session and --action are required");
      return 2;
    }
    const relay = makeRelay(options);
    if (verb === "show") {
      // Inspect the receipt through the runtime journal (local copy only; a
      // remote inspection goes through ssh + a runtime request).
      const record = await relay.submissions.getExecution(sessionId, actionId);
      console.log(JSON.stringify(record ?? { actionId, note: "action records live in the remote runtime journal; use session finish to deliver them" }, null, options.has("json") ? 0 : 2));
      return record ? 0 : 1;
    }
    // observe/annotate: sourced annotations through the shared evidence
    // store — recorded as package revision annotations on the delivered
    // package (D15): local file relay-annotations.json in the store.
    const text = options.get("text");
    if (!text) { console.error("error: --text is required"); return 2; }
    const storeRoot = options.get("store") ?? ".relay-driver";
    const { readFile, writeFile } = await import("node:fs/promises");
    const annotationsPath = join(storeRoot, "annotations.json");
    let annotations: unknown[] = [];
    try {
      annotations = JSON.parse(await readFile(annotationsPath, "utf8"));
    } catch { /* first annotation */ }
    annotations.push({
      annotationId: formatId(allocateId("annotation")),
      kind: verb === "observe" ? "observation" : "explanation",
      sessionId,
      actionId,
      writtenAt: new Date().toISOString(),
      text,
    });
    await writeFile(annotationsPath, JSON.stringify(annotations, null, 2));
    console.log(JSON.stringify({ actionId, annotated: true, text }, null, options.has("json") ? 0 : 2));
    return 0;
  }

  // ---- verify -------------------------------------------------------------
  if (noun === "verify") {
    const packageDir = objectArgs[0] ?? verb;
    if (!packageDir) {
      console.error("error: relay-driver verify <package-dir>");
      return 2;
    }
    const { readFile } = await import("node:fs/promises");
    const manifestPath = join(packageDir, "manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      console.error(`error: no readable manifest at ${manifestPath}`);
      return 1;
    }
    const result = await verifyPackage(manifest, packageDir);
    console.log(JSON.stringify(result, null, options.has("json") ? 0 : 2));
    return result.accepted ? 0 : 1;
  }

  console.error(usage());
  return noun === undefined ? 0 : 2;
}

async function serveReview(packageDir: string, options: Map<string, string>): Promise<number> {
  const root = normalize(packageDir);
  const open = options.get("open") !== "false";
  const server = await startReviewServer(root, join(process.cwd(), "viewer"));
  console.log(`review server: ${server.url} (package: ${root}); Ctrl-C to stop`);
  if (open) {
    const { spawn } = await import("node:child_process");
    spawn("open", [server.url], { stdio: "ignore", detached: true }).unref();
  }
  // Serve until interrupted; keep handles explicit for clean shutdown.
  await new Promise<never>(() => {});
  void server;
  return 0;
}

if (process.argv[1]?.endsWith("main.js")) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
