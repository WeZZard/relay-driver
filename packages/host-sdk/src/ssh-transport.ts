/**
 * The real SSH transport: framed requests over an SSH connection to the
 * assigned remote machine (Stage 2 EXECUTION-01 path A).
 *
 * Framing discipline (plan: "Preserve commands and evidence across the
 * transport"): the request is JSON on stdin; the response is a single JSON
 * object on stdout of the last line. Commands run as argv data via `ssh --
`
 * (no remote shell reinterpretation).
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import type { FramedRequest, FramedResponse, SessionTransport, FinishResult } from "./relay.js";

export interface SshTransportOptions {
  /** e.g. "user@192.0.2.10" */
  readonly target: string;
  /** Remote runtime entry point invoked for each framed request. */
  readonly remoteRunner?: string;
  /** Extra ssh arguments (e.g. -i identity, -p port). */
  readonly sshArgs?: readonly string[];
  /** Remote base directory for script deployments (created on demand). */
  readonly remoteScriptRoot?: string;
}

/** Default remote runner: node execution of the staged runtime receiver. */
const DEFAULT_RUNNER = "node /var/tmp/relay-driver-runtime/receive.js";

export class SshTransport implements SessionTransport {
  constructor(private readonly options: SshTransportOptions) {}

  private ssh(argv: readonly string[], input?: string, timeoutMs = 120_000): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const args: string[] = [
        ...(this.options.sshArgs ?? []),
        this.options.target,
        "--",
        ...argv,
      ];
      const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`ssh timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? -1 });
      });
      if (input !== undefined) {
        child.stdin.write(input);
      }
      child.stdin.end();
    });
  }

  async send(request: FramedRequest): Promise<FramedResponse> {
    const runner = this.options.remoteRunner ?? DEFAULT_RUNNER;
    const payload = JSON.stringify(request);
    // The remote login shell may not have node on PATH; prefer the Homebrew
    // prefix explicitly when the runner references a bare "node".
    const runnerArgv = runner.split(" ");
    if (runnerArgv[0] === "node") runnerArgv[0] = "/opt/homebrew/bin/node";
    const { stdout, stderr, code } = await this.ssh(runnerArgv, payload);
    if (code !== 0 && !stdout.trim()) {
      return {
        executionId: request.executionId,
        outcome: { kind: "uncertain", diagnostic: `ssh exit ${code}: ${stderr.trim().slice(0, 500)}` },
      };
    }
    try {
      const lastLine = stdout.trim().split("\n").at(-1)!;
      const response = JSON.parse(lastLine) as FramedResponse;
      if (response.executionId !== request.executionId) {
        return {
          executionId: request.executionId,
          outcome: { kind: "uncertain", diagnostic: "response identity mismatch" },
        };
      }
      return response;
    } catch (err) {
      return {
        executionId: request.executionId,
        outcome: { kind: "uncertain", diagnostic: `unparseable response: ${String(err)}` },
      };
    }
  }

  async upload(path: string, options: { remotePath: string }): Promise<{ scriptId: string; path: string }> {
    // Remote paths are absolute (task-scoped deployment root); relative paths
    // land under the remote user's home and are NOT re-rooted here.
    const remotePath = options.remotePath;
    // Ensure the parent directory exists, then copy.
    const parent = remotePath.slice(0, remotePath.lastIndexOf("/"));
    const prep = await this.ssh(["/bin/mkdir", "-p", parent]);
    if (prep.code !== 0) {
      throw new Error(`mkdir failed (${prep.code}): ${prep.stderr.trim()}`);
    }
    const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
      const child = spawn("scp", ["-q", path, `${this.options.target}:${remotePath}`], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (c) => resolve({ code: c ?? -1, stderr }));
    });
    if (code !== 0) {
      throw new Error(`scp failed (${code}): ${stderr.trim()}`);
    }
    const scriptId = `script-${remotePath}`;
    return { scriptId, path: remotePath };
  }

  /**
   * Finalize the package (Stage 4 EVIDENCE-01/EXPORT-01): assemble the
   * remote runtime state and recording media into a staging directory,
   * download it over scp, build a manifest over the delivered bytes, and
   * run host acceptance. The recording stop itself is an explicit driver
   * call the session performs before finish.
   */
  async finish(options: { downloadTo: string }): Promise<FinishResult> {
    const { buildManifest, verifyPackage, listFiles } = await import("./evidence-package.js");
    const runtimeRoot = "/var/tmp/relay-driver-runtime";
    const stage = `/var/tmp/relay-export-${Date.now()}`;

    // Assemble the remote package: journal slice, action records, media.
    const prep = await this.ssh([
      "/bin/sh", "-c",
      `set -e; rm -rf ${stage}; mkdir -p ${stage}/media ${stage}/journal; ` +
      `cp -r ${runtimeRoot}/state/records ${stage}/ 2>/dev/null || true; ` +
      `cp ${runtimeRoot}/state/journal/events.jsonl ${stage}/journal/ 2>/dev/null || true; ` +
      `for f in ${runtimeRoot}/media/*.mp4; do [ -f "$f" ] && cp "$f" ${stage}/media/; done; echo ${stage}`,
    ]);
    if (prep.code !== 0) {
      throw new Error(`package assembly failed (${prep.code}): ${prep.stderr.trim().slice(0, 300)}`);
    }

    // Download over scp.
    const dl = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
      const child = spawn("scp", ["-q", "-r", `${this.options.target}:${stage}/.`, options.downloadTo], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", reject);
      child.on("close", (c) => resolve({ code: c ?? -1, stderr }));
    });
    if (dl.code !== 0) {
      throw new Error(`package download failed (${dl.code}): ${dl.stderr.trim().slice(0, 300)}`);
    }

    // Clean the remote staging copy; the delivered bytes are now host-owned.
    await this.ssh(["/bin/rm", "-rf", stage]);

    // Build the manifest over delivered bytes and run acceptance.
    const files = await listFiles(options.downloadTo);
    const media = [];
    const records = [];
    for (const f of files) {
      if (f.endsWith(".mp4")) {
        media.push({ absolutePath: join(options.downloadTo, f), packagePath: f, segmentId: `seg-${f.replace(/\W+/g, "-")}`, finalized: true });
      } else {
        records.push({ absolutePath: join(options.downloadTo, f), packagePath: f });
      }
    }
    const manifest = await buildManifest({
      packageId: `pkg-${this.options.target}-${Date.now()}`,
      sessionId: "session-unframed",
      taskId: "task-unframed",
      rootDir: options.downloadTo,
      media,
      records,
      attempts: [],
      segments: [],
    });
    // The manifest is part of the delivered package: write it so `verify`
    // and `review` can consume the package directory as-is.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(options.downloadTo, "manifest.json"), JSON.stringify(manifest, null, 2));
    const acceptance = await verifyPackage(manifest, options.downloadTo);
    return {
      manifestPath: join(options.downloadTo, "manifest.json"),
      deliveryVerified: acceptance.accepted,
      recording: acceptance.accepted ? "complete" : "incomplete",
      execution: "uncertain",
    };
  }

  async close(): Promise<void> {
    // Stateless transport: each request is its own ssh invocation.
  }
}
