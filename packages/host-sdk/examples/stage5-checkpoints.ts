/**
 * Stage 5 REVIEW-01/REVIEW-02: register precise still-frame checkpoints in
 * the delivered package and produce the final trajectory.json.
 *
 * Review-point media times (TIME-01 mapping, first-captured-frame anchor):
 * the continuation segment's first captured frame corresponds to the
 * segment's session-relative t0; action writtenAt timestamps convert to
 * media time by subtracting that anchor. The resulting time is probed,
 * extracted with ffmpeg into evidence/ (separately verifiable), and the
 * registered stillFrame path is checked at load.
 */
import { buildTrajectory } from "../src/trajectory.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

const packageDir = process.argv[2] ?? "/tmp/relay-stage4-download";

interface JournalRec {
  kind: string; actionId?: string; attemptId?: string; title?: string;
  writtenAt?: string; toolOutcome?: { kind?: string; value?: unknown };
}

async function main(): Promise<void> {
  const lines = (await readFile(join(packageDir, "journal", "session-events.jsonl"), "utf8"))
    .split("\n").filter(Boolean).map((l) => JSON.parse(l) as JournalRec);

  // Segment anchors: first captured frame of each segment maps to the
  // segment's session-relative t0. From the stage-4 scenario: the damaged
  // attempt-1 segment starts at session start; the continuation segment
  // starts when recording resumed. Both anchored at first captured frame.
  // Continuation recording resumed at 23:11:37.0Z (measured get state after
  // stop/start in the scenario); action times convert by (t - anchor).
  const anchors: Record<string, number> = {
    "attempt-stage4-continuation": Date.parse("2026-09-09T23:11:37.000Z"),
  };

  const starts = lines.filter((r) => r.kind === "action-start" && r.attemptId && anchors[r.attemptId] !== undefined);
  await mkdir(join(packageDir, "evidence"), { recursive: true });

  const stillFrames: Record<string, string> = {};
  const times: Record<string, number> = {};
  for (const start of starts) {
    const tMs = (Date.parse(start.writtenAt!) - anchors[start.attemptId!]) / 1000;
    const t = Math.max(0, tMs);
    times[start.actionId!] = t;
    const frame = `evidence/still-${start.actionId}.png`;
    await execFileAsync("/opt/homebrew/bin/ffmpeg", [
      "-y", "-v", "error", "-ss", t.toFixed(3),
      "-i", join(packageDir, "media/segment-attempt2-continuation.mp4"),
      "-frames:v", "1", join(packageDir, frame),
    ]);
    stillFrames[start.actionId!] = frame;
  }

  const wt = await buildTrajectory(packageDir, { execution: "uncertain" });
  const steps = wt.steps.map((s) => ({
    ...s,
    expected: s.execution === "completed"
      ? "Remote action admitted, executed, and journaled with its measured outcome."
      : "Durable admitted state retained when the callable never reported completion.",
    observed: s.execution === "incomplete"
      ? "No completion record: receiver terminated after the fsynced durable start (dangling admitted action)."
      : s.observed,
    reviewPoint: s.reviewPoint && stillFrames[s.id]
      ? {
          ...s.reviewPoint,
          segmentId: "seg-attempt2",
          timeSeconds: times[s.id] ?? 0,
          stillFrame: stillFrames[s.id],
        }
      : s.reviewPoint,
    annotations: s.id === "action-0mtupwkgb49nhk6l5"
      ? [{ author: "relay-agent", writtenAt: new Date().toISOString(), text: "Late enrichment (revision 2): this admitted start has no completion — the receiver was killed mid-call. Inspection, not a completion claim." }]
      : undefined,
  }));

  const final = { ...wt, steps };
  await writeFile(join(packageDir, "trajectory.json"), JSON.stringify(final, null, 2));
  console.log("trajectory.json written with", steps.length, "steps;",
    Object.keys(stillFrames).length, "registered still frames");
  for (const s of final.steps) {
    console.log(`- ${s.id} [${s.execution}/${s.state}] t=${s.reviewPoint?.timeSeconds?.toFixed(3) ?? "—"}s frame=${s.reviewPoint?.stillFrame ?? "none"}`);
  }
}
main();
