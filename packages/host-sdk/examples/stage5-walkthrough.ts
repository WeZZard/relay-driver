/**
 * Stage 5 REVIEW-01/REVIEW-02 prep: build walkthrough.json for the delivered
 * stage-4 package and register precise still-frame checkpoints.
 *
 * Review points: action-start records carry ms-since-session-start; the
 * segment's clock mapping (TIME-01, first-captured-frame anchor) converts
 * that to media time. For the continuation segment the mapping is
 * media_t = action_ms - segStart_ms (segment recorded from session start of
 * attempt 2). Still frames are extracted with ffmpeg at the mapped time and
 * served from evidence/.
 */
import { buildWalkthrough } from "../src/walkthrough.js";
import { writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

const packageDir = process.argv[2] ?? "/tmp/relay-stage4-download";

async function main(): Promise<void> {
  const journal = (await import("node:fs/promises")).readFile;
  const lines = (await journal(join(packageDir, "journal", "session-events.jsonl"), "utf8"))
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const starts = lines.filter((r) => r.kind === "action-start");
  console.log("action-start events:", starts.length);
  for (const s of starts) {
    console.log(JSON.stringify({ actionId: s.actionId, stepId: s.stepId, attemptId: s.attemptId, title: s.title, call: s.call?.argv ?? s.call, keys: Object.keys(s) }));
  }
  const wt = await buildWalkthrough(packageDir);
  await writeFile(join(packageDir, "walkthrough.json"), JSON.stringify(wt, null, 2));
  console.log("walkthrough.json written:", wt.steps.length, "steps");
  for (const step of wt.steps) console.log(`- ${step.id}: ${step.execution}/${step.state} @ ${step.reviewPoint?.segmentId ?? "no segment"}`);
}
main();
