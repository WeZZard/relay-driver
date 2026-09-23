/**
 * Stage 4 remote proof driver: builds a manifest over the package downloaded
 * from RELAY_SSH_HOST (interrupted attempt + continuation + damaged original)
 * and runs host acceptance on the delivered bytes (EVIDENCE-01 / EXPORT-01).
 */
import { writeFile, readFile } from "node:fs/promises";
import {
  buildManifest,
  verifyPackage,
  listFiles,
} from "../src/index.js";

const root = "/tmp/relay-stage4-download";

const files = await listFiles(root);
console.log("delivered files:", files.join(", "));

const media = [];
const records = [];
for (const f of files) {
  if (f.endsWith(".mp4")) {
    media.push({
      absolutePath: `${root}/${f}`,
      packagePath: f,
      segmentId: f.includes("attempt1") ? "seg-attempt1" : "seg-attempt2",
      finalized: !f.includes("attempt1"),
    });
  } else {
    records.push({ absolutePath: `${root}/${f}`, packagePath: f });
  }
}

const manifest = await buildManifest({
  packageId: "pkg-stage4-relay",
  sessionId: "session-stage4-1788995433405",
  taskId: "2026-09-09-21-51-38-Z-relay-driver-stage1",
  rootDir: root,
  media,
  records,
  attempts: [
    {
      attemptId: "attempt-stage4-interrupted",
      state: "interrupted",
      continuesAttemptId: "attempt-stage4-continuation",
      segmentIds: ["seg-attempt1"],
    },
    {
      attemptId: "attempt-stage4-continuation",
      state: "completed",
      segmentIds: ["seg-attempt2"],
    },
  ],
  segments: [
    {
      segmentId: "seg-attempt1",
      attemptId: "attempt-stage4-interrupted",
      artifactPath: "media/segment-attempt1-damaged.mp4",
      clockMapping: { mediaTimeZero: 0, anchor: "first-captured-frame" },
    },
    {
      segmentId: "seg-attempt2",
      attemptId: "attempt-stage4-continuation",
      artifactPath: "media/segment-attempt2-continuation.mp4",
      clockMapping: { mediaTimeZero: 0, anchor: "first-captured-frame" },
    },
  ],
});

await writeFile(`${root}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log("manifest written");

const result = await verifyPackage(manifest, root);
console.log("accepted:", result.accepted);
for (const f of result.findings) console.log(`  [${f.code}] ${f.detail}`);

// Damaged original summary from the manifest facts.
for (const m of manifest.media) {
  console.log(
    `media ${m.path}: ${m.decode}` +
      (m.decode === "playable"
        ? ` ${m.media?.width}x${m.media?.height} ${m.media?.codec} ${m.media?.durationSeconds?.toFixed(2)}s`
        : ` (${m.decodeDiagnostic?.slice(0, 60)})`) +
      ` finalized=${m.finalized} bytes=${m.bytes}`,
  );
}

if (!result.accepted) process.exit(1);
