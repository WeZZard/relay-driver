/**
 * Corruption-detection check (EXPORT-01 delivery honesty): a one-byte flip
 * in a delivered playable artifact must fail host acceptance.
 */
import { buildManifest, verifyPackage } from "../src/index.js";

async function main(): Promise<void> {
  const root = "/tmp/relay-stage4-corrupt";
  // The manifest is built over the ORIGINAL delivery (/tmp/relay-stage4-download)
  // and then checked against the possibly-corrupted copy — that is the real
  // acceptance flow: source manifest vs delivered bytes.
  const sourceRoot = "/tmp/relay-stage4-download";
  const manifest = await buildManifest({
    packageId: "pkg-corrupt-check",
    sessionId: "s",
    taskId: "t",
    rootDir: sourceRoot,
    media: [
      { absolutePath: `${sourceRoot}/media/segment-attempt1-damaged.mp4`, packagePath: "media/segment-attempt1-damaged.mp4", segmentId: "seg1", finalized: false },
      { absolutePath: `${sourceRoot}/media/segment-attempt2-continuation.mp4`, packagePath: "media/segment-attempt2-continuation.mp4", segmentId: "seg2", finalized: true },
    ],
    records: [{ absolutePath: `${sourceRoot}/journal/session-events.jsonl`, packagePath: "journal/session-events.jsonl" }],
    attempts: [
      { attemptId: "a1", state: "interrupted", continuesAttemptId: "a2", segmentIds: ["seg1"] },
      { attemptId: "a2", state: "completed", segmentIds: ["seg2"] },
    ],
    segments: [
      { segmentId: "seg1", attemptId: "a1", artifactPath: "media/segment-attempt1-damaged.mp4", clockMapping: { mediaTimeZero: 0, anchor: "first-captured-frame" } },
      { segmentId: "seg2", attemptId: "a2", artifactPath: "media/segment-attempt2-continuation.mp4", clockMapping: { mediaTimeZero: 0, anchor: "first-captured-frame" } },
    ],
  });
  const r = await verifyPackage(manifest, root);
  console.log("corrupted package accepted:", r.accepted);
  for (const f of r.findings) if (f.code !== "ok") console.log(`[${f.code}] ${f.detail.slice(0, 120)}`);
  if (r.accepted) process.exit(1);
}
main();
