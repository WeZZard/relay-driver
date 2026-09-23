import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { buildManifest } from "@wezzard/relay-driver-host-sdk";
import { buildWalkthrough } from "@wezzard/relay-driver-host-sdk";

const pkg = "/tmp/relay-snap-viewer-pkg";
await mkdir(join(pkg, "snapshots"), { recursive: true });
await mkdir(join(pkg, "records"), { recursive: true });
await mkdir(join(pkg, "journal"), { recursive: true });
await mkdir(join(pkg, "viewer"), { recursive: true });

// Tiny distinct PNGs (1x1 red / 1x1 blue)
const png1x1 = (r: number, g: number, b: number) => Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080200000090" +
  "7753de0000000c4944415408d763" + r.toString(16).padStart(2,"0") +
  g.toString(16).padStart(2,"0") + b.toString(16).padStart(2,"0") +
  "0500" + "00" + "01807be90f0000000049454e44ae426082", "hex");
await writeFile(join(pkg, "snapshots", "a000001-20260912T000000.000Z-before-click-save.png"), png1x1(255,0,0));
await writeFile(join(pkg, "snapshots", "a000001-20260912T000000.500Z-after-click-save.png"), png1x1(0,0,255));
await writeFile(join(pkg, "snapshots", "a000002-20260912T000001.000Z-before-type-hello.png"), png1x1(0,255,0));
await writeFile(join(pkg, "snapshots", "a000002-20260912T000002.000Z-after-type-hello.png"), png1x1(0,0,0));
await writeFile(join(pkg, "records", "action-1.json"), JSON.stringify({ actionId: "action-1" }));
// Journal with two action-starts (one group member)
const journal = [
  { kind: "action-start", seq: 0, writtenAt: "2026-09-12T00:00:00.000Z", actionId: "action-1", attemptId: "attempt-1", stepId: "click-save", title: "Click Save", groupId: undefined },
  { kind: "action-completion", seq: 1, writtenAt: "2026-09-12T00:00:00.500Z", actionId: "action-1", state: "recorded", toolOutcome: { kind: "success", value: { exitStatus: { code: 0 } } } },
  { kind: "action-start", seq: 2, writtenAt: "2026-09-12T00:00:01.000Z", actionId: "action-2", attemptId: "attempt-1", stepId: "type-hello", title: "Type hello", groupId: "grp-hello" },
  { kind: "action-completion", seq: 3, writtenAt: "2026-09-12T00:00:02.000Z", actionId: "action-2", state: "recorded", toolOutcome: { kind: "success", value: { exitStatus: { code: 0 } } } },
].map((r) => JSON.stringify(r)).join("\n") + "\n";
await writeFile(join(pkg, "journal", "session-events.jsonl"), journal);
// records list must include journal for integrity
await copyFile(join(pkg, "journal", "session-events.jsonl"), join(pkg, "records", "session-events.jsonl"));

const manifest = await buildManifest({
  packageId: "pkg-snap-viewer", sessionId: "session-snap", taskId: "task-snap",
  rootDir: pkg,
  records: [{ absolutePath: join(pkg, "records", "session-events.jsonl"), packagePath: "journal/session-events.jsonl" }],
  media: [],
  snapshots: [
    { absolutePath: join(pkg, "snapshots", "a000001-20260912T000000.000Z-before-click-save.png"), packagePath: "snapshots/a000001-20260912T000000.000Z-before-click-save.png", actionId: "action-1", role: "before", capturedAt: "2026-09-12T00:00:00.000Z" },
    { absolutePath: join(pkg, "snapshots", "a000001-20260912T000000.500Z-after-click-save.png"), packagePath: "snapshots/a000001-20260912T000000.500Z-after-click-save.png", actionId: "action-1", role: "after", declaredAfterIntervalMs: 500, capturedAt: "2026-09-12T00:00:00.500Z" },
    { absolutePath: join(pkg, "snapshots", "a000002-20260912T000001.000Z-before-type-hello.png"), packagePath: "snapshots/a000002-20260912T000001.000Z-before-type-hello.png", actionId: "action-2", role: "before", groupId: "grp-hello", capturedAt: "2026-09-12T00:00:01.000Z" },
    { absolutePath: join(pkg, "snapshots", "a000002-20260912T000002.000Z-after-type-hello.png"), packagePath: "snapshots/a000002-20260912T000002.000Z-after-type-hello.png", actionId: "action-2", role: "after", groupId: "grp-hello", declaredAfterIntervalMs: 1000, capturedAt: "2026-09-12T00:00:02.000Z" },
  ],
  attempts: [], segments: [],
});
const { writeFile: wf } = await import("node:fs/promises");
await wf(join(pkg, "manifest.json"), JSON.stringify(manifest, null, 2));
const wt = await buildWalkthrough(pkg, { packageId: manifest.packageId });
await wf(join(pkg, "walkthrough.json"), JSON.stringify(wt, null, 2));
// Viewer assets: the review server serves process.cwd()/viewer; also copy into package for portability
for (const f of ["index.html", "app.js", "style.css"]) {
  await copyFile(join("viewer", f), join(pkg, "viewer", f));
}
console.log("package built:", pkg, "steps:", wt.steps.length);
