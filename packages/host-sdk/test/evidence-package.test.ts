/**
 * EVIDENCE-01 unit layer: manifest building and host acceptance, including
 * the D18 damaged-recording delivery path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  buildManifest,
  verifyPackage,
  probeMedia,
  listFiles,
  enrichPackage,
  verifyPackageRevision,
} from "../src/index.js";

const exec = promisify(execFile);

/** Make a tiny valid mp4 with ffmpeg (playable artifact). */
async function makePlayableMp4(dir: string, name: string): Promise<string> {
  const path = join(dir, name);
  await exec("ffmpeg", [
    "-v", "error",
    "-f", "lavfi",
    "-i", "color=c=black:s=64x64:d=0.5",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-y",
    path,
  ]);
  return path;
}

/** Damage a media file by truncating it (simulates unfinalized moov). */
async function makeDamagedMp4(source: string, dir: string, name: string): Promise<string> {
  const path = join(dir, name);
  const bytes = await readFile(source);
  // Cut the tail: the moov atom is written at finalize time.
  await writeFile(path, bytes.subarray(0, Math.floor(bytes.length * 0.7)));
  return path;
}

async function tempPackage(): Promise<string> {
  return mkdtemp(join(tmpdir(), "relay-pkg-"));
}

test("playable media builds a manifest that passes acceptance", async () => {
  const root = await tempPackage();
  await mkdir(join(root, "media"), { recursive: true });
  await mkdir(join(root, "journal"), { recursive: true });
  const playable = await makePlayableMp4(join(root, "media"), "segment-a.mp4");
  const journal = join(root, "journal", "events.jsonl");
  await writeFile(journal, '{"kind":"action-start"}\n');

  const manifest = await buildManifest({
    packageId: "pkg-1",
    sessionId: "session-1",
    taskId: "task-1",
    rootDir: root,
    media: [{ absolutePath: playable, packagePath: "media/segment-a.mp4", segmentId: "seg-a", finalized: true }],
    records: [{ absolutePath: journal, packagePath: "journal/events.jsonl" }],
    attempts: [{ attemptId: "attempt-a", state: "completed", segmentIds: ["seg-a"] }],
    segments: [{
      segmentId: "seg-a",
      attemptId: "attempt-a",
      artifactPath: "media/segment-a.mp4",
      clockMapping: { mediaTimeZero: 0, anchor: "first-captured-frame" },
    }],
  });

  const result = await verifyPackage(manifest, root);
  assert.equal(result.accepted, true, JSON.stringify(result.findings));
  const media = manifest.media[0];
  assert.equal(media.decode, "playable");
  assert.ok((media.media?.width ?? 0) > 0);
  assert.equal(media.finalized, true);
});

test("damaged original passes delivery while its failed decode stays explicit (D18)", async () => {
  const root = await tempPackage();
  await mkdir(join(root, "media"), { recursive: true });
  const playable = await makePlayableMp4(join(root, "media"), "src.mp4");
  const damaged = await makeDamagedMp4(playable, join(root, "media"), "segment-damaged.mp4");

  const probed = await probeMedia(damaged);
  assert.equal(probed.decode, "damaged", "truncated mp4 must not decode");

  const manifest = await buildManifest({
    packageId: "pkg-2",
    sessionId: "session-1",
    taskId: "task-1",
    rootDir: root,
    media: [{ absolutePath: damaged, packagePath: "media/segment-damaged.mp4", segmentId: "seg-1", finalized: false }],
    records: [],
    attempts: [
      { attemptId: "attempt-1", state: "interrupted", segmentIds: ["seg-1"], continuesAttemptId: "attempt-2" },
      { attemptId: "attempt-2", state: "completed", segmentIds: ["seg-1"], continuesAttemptId: undefined },
    ],
    segments: [{
      segmentId: "seg-1",
      attemptId: "attempt-1",
      artifactPath: "media/segment-damaged.mp4",
      clockMapping: { mediaTimeZero: 0, anchor: "first-captured-frame" },
    }],
  });

  const result = await verifyPackage(manifest, root);
  assert.equal(result.accepted, true, JSON.stringify(result.findings));
  const damagedFinding = result.findings.find((f) => f.code === "damaged-original-ok");
  assert.ok(damagedFinding, "delivery must record the damaged original explicitly");
  assert.equal(manifest.media[0].decode, "damaged");
  assert.equal(manifest.media[0].finalized, false);
});

test("checksum mismatch and missing artifacts fail acceptance", async () => {
  const root = await tempPackage();
  await mkdir(join(root, "media"), { recursive: true });
  const playable = await makePlayableMp4(join(root, "media"), "segment-x.mp4");
  const manifest = await buildManifest({
    packageId: "pkg-3",
    sessionId: "s",
    taskId: "t",
    rootDir: root,
    media: [{ absolutePath: playable, packagePath: "media/segment-x.mp4", segmentId: "seg-x", finalized: true }],
    records: [],
    attempts: [{ attemptId: "a", state: "completed", segmentIds: ["seg-x"] }],
    segments: [{
      segmentId: "seg-x",
      attemptId: "a",
      artifactPath: "media/segment-x.mp4",
      clockMapping: { mediaTimeZero: 0, anchor: "first-captured-frame" },
    }],
  });

  // Corruption of media advertised as playable fails acceptance.
  await writeFile(join(root, "media", "segment-x.mp4"), Buffer.from("corrupted"));
  const corrupted = await verifyPackage(manifest, root);
  assert.equal(corrupted.accepted, false);
  assert.ok(corrupted.findings.some((f) => f.code === "checksum-mismatch"));

  // Missing required bytes fail acceptance.
  const { rm } = await import("node:fs/promises");
  await rm(join(root, "media", "segment-x.mp4"));
  const missing = await verifyPackage(manifest, root);
  assert.equal(missing.accepted, false);
  assert.ok(missing.findings.some((f) => f.code === "missing-artifact"));
});

test("late enrichment creates a revalidated revision without changing original evidence", async () => {
  const root = await tempPackage();
  await mkdir(join(root, "media"), { recursive: true });
  const playable = await makePlayableMp4(join(root, "media"), "segment-z.mp4");
  const manifest = await buildManifest({
    packageId: "pkg-5",
    sessionId: "s",
    taskId: "t",
    rootDir: root,
    media: [{ absolutePath: playable, packagePath: "media/segment-z.mp4", segmentId: "seg-z", finalized: true }],
    records: [],
    attempts: [{ attemptId: "a", state: "completed", segmentIds: ["seg-z"] }],
    segments: [{
      segmentId: "seg-z",
      attemptId: "a",
      artifactPath: "media/segment-z.mp4",
      clockMapping: { mediaTimeZero: 0, anchor: "first-captured-frame" },
    }],
  });
  const before = manifest.media[0].sha256;

  const revision = await enrichPackage(manifest, root, [{
    annotationId: "ann-1",
    author: "agent",
    writtenAt: new Date().toISOString(),
    references: ["seg-z", "media/segment-z.mp4"],
    text: "The click lands between t=0.2s and t=0.5s in this segment.",
  }]);
  assert.equal(revision.revision, 2);
  assert.ok(revision.priorManifestSha256);

  // Original evidence unchanged.
  assert.equal(revision.originalManifest.media[0].sha256, before);
  assert.deepEqual(revision.originalManifest.records, manifest.records);

  const r = await verifyPackageRevision(revision, root);
  assert.equal(r.accepted, true, JSON.stringify(r.findings));

  // An annotation referencing an unknown identity fails revalidation.
  const badRevision = await enrichPackage(manifest, root, [{
    annotationId: "ann-2",
    author: "agent",
    writtenAt: new Date().toISOString(),
    references: ["action-ghost"],
    text: "dangling",
  }]);
  const r2 = await verifyPackageRevision(badRevision, root);
  assert.equal(r2.accepted, false);
  assert.ok(r2.findings.some((f) => f.code === "invalid-reference"));
});

test("invalid references and state laundering fail acceptance", async () => {
  const root = await tempPackage();
  await mkdir(join(root, "media"), { recursive: true });
  const playable = await makePlayableMp4(join(root, "media"), "segment-y.mp4");
  const base = {
    packageId: "pkg-4",
    sessionId: "s",
    taskId: "t",
    rootDir: root,
    media: [{ absolutePath: playable, packagePath: "media/segment-y.mp4", segmentId: "seg-y", finalized: true }],
    records: [],
  } as const;

  // Attempt referencing an unknown segment.
  const badSegment = await buildManifest({
    ...base,
    attempts: [{ attemptId: "a", state: "completed", segmentIds: ["seg-ghost"] }],
    segments: [{
      segmentId: "seg-y",
      attemptId: "a",
      artifactPath: "media/segment-y.mp4",
      clockMapping: { mediaTimeZero: 0, anchor: "first-captured-frame" },
    }],
  });
  const r1 = await verifyPackage(badSegment, root);
  assert.equal(r1.accepted, false);
  assert.ok(r1.findings.some((f) => f.code === "invalid-reference"));

  // Interrupted attempt without a continuation reference.
  const noContinuation = await buildManifest({
    ...base,
    attempts: [{ attemptId: "a", state: "interrupted", segmentIds: ["seg-y"] }],
    segments: [{
      segmentId: "seg-y",
      attemptId: "a",
      artifactPath: "media/segment-y.mp4",
      clockMapping: { mediaTimeZero: 0, anchor: "first-captured-frame" },
    }],
  });
  const r2 = await verifyPackage(noContinuation, root);
  assert.equal(r2.accepted, false);
  assert.ok(r2.findings.some((f) => f.code === "state-inconsistent"));
});

// ---- Snapshot evidence + attachment slot (SNAP-05) ----

test("manifest carries dispatch-captured snapshots; verifier checks bytes, provenance, group pairs", async () => {
  const { buildManifest, verifyPackage } = await import("../src/evidence-package.js");
  const { writeFile, mkdir } = await import("node:fs/promises");
  const pkg = await mkdtemp(join(tmpdir(), "relay-snap-pkg-"));
  await mkdir(join(pkg, "snapshots"), { recursive: true });
  await mkdir(join(pkg, "records"), { recursive: true });
  await writeFile(join(pkg, "snapshots", "a000001-20260912T000000.000Z-before-click.png"), "PNGDATA-BEFORE");
  await writeFile(join(pkg, "snapshots", "a000001-20260912T000000.500Z-after-click.png"), "PNGDATA-AFTER");
  await writeFile(join(pkg, "records", "journal.jsonl"), "{}\n");
  const manifest = await buildManifest({
    packageId: "pkg-snap", sessionId: "s1", taskId: "t1", rootDir: pkg,
    records: [{ absolutePath: join(pkg, "records", "journal.jsonl"), packagePath: "records/journal.jsonl" }],
    media: [],
    snapshots: [
      { absolutePath: join(pkg, "snapshots", "a000001-20260912T000000.000Z-before-click.png"), packagePath: "snapshots/a000001-20260912T000000.000Z-before-click.png", actionId: "action-1", role: "before", groupId: "g1", capturedAt: "2026-09-12T00:00:00.000Z" },
      { absolutePath: join(pkg, "snapshots", "a000001-20260912T000000.500Z-after-click.png"), packagePath: "snapshots/a000001-20260912T000000.500Z-after-click.png", actionId: "action-1", role: "after", groupId: "g1", declaredAfterIntervalMs: 500, capturedAt: "2026-09-12T00:00:00.500Z" },
    ],
    attempts: [], segments: [],
  });
  const result = await verifyPackage(manifest, pkg);
  assert.equal(result.accepted, true, JSON.stringify(result.findings));
  assert.ok(manifest.snapshots && manifest.snapshots.every((sn) => sn.provenance === "dispatch-captured"));
  // Tamper: break the after snapshot's bytes → checksum-mismatch.
  await writeFile(join(pkg, "snapshots", "a000001-20260912T000000.500Z-after-click.png"), "TAMPERED");
  const tampered = await verifyPackage(manifest, pkg);
  assert.equal(tampered.accepted, false);
  assert.ok(tampered.findings.some((f) => f.code === "checksum-mismatch"));
});

test("group pair inconsistency is refused: a group must carry exactly one before/after", async () => {
  const { buildManifest, verifyPackage } = await import("../src/evidence-package.js");
  const { writeFile, mkdir } = await import("node:fs/promises");
  const pkg = await mkdtemp(join(tmpdir(), "relay-snap-pkg2-"));
  await mkdir(join(pkg, "snapshots"), { recursive: true });
  await mkdir(join(pkg, "records"), { recursive: true });
  await writeFile(join(pkg, "snapshots", "b1.png"), "B1");
  await writeFile(join(pkg, "snapshots", "b2.png"), "B2");
  await writeFile(join(pkg, "records", "journal.jsonl"), "{}\n");
  const manifest = await buildManifest({
    packageId: "pkg-snap2", sessionId: "s1", taskId: "t1", rootDir: pkg,
    records: [{ absolutePath: join(pkg, "records", "journal.jsonl"), packagePath: "records/journal.jsonl" }],
    media: [],
    snapshots: [
      { absolutePath: join(pkg, "snapshots", "b1.png"), packagePath: "snapshots/b1.png", actionId: "a1", role: "before", groupId: "gg", capturedAt: "2026-09-12T00:00:00.000Z" },
      { absolutePath: join(pkg, "snapshots", "b2.png"), packagePath: "snapshots/b2.png", actionId: "a1", role: "before", groupId: "gg", capturedAt: "2026-09-12T00:00:01.000Z" },
    ],
    attempts: [], segments: [],
  });
  const result = await verifyPackage(manifest, pkg);
  assert.equal(result.accepted, false);
  assert.ok(result.findings.some((f) => f.code === "state-inconsistent" && f.detail.includes("gg")));
});

test("application attachments are byte-verified but uninterpreted (video slot)", async () => {
  const { buildManifest, verifyPackage } = await import("../src/evidence-package.js");
  const { writeFile, mkdir } = await import("node:fs/promises");
  const pkg = await mkdtemp(join(tmpdir(), "relay-attach-pkg-"));
  await mkdir(join(pkg, "attachments"), { recursive: true });
  await mkdir(join(pkg, "records"), { recursive: true });
  await writeFile(join(pkg, "attachments", "segment.mp4"), "VIDEOBYTES");
  await writeFile(join(pkg, "records", "journal.jsonl"), "{}\n");
  const manifest = await buildManifest({
    packageId: "pkg-attach", sessionId: "s1", taskId: "t1", rootDir: pkg,
    records: [{ absolutePath: join(pkg, "records", "journal.jsonl"), packagePath: "records/journal.jsonl" }],
    media: [],
    attachments: [{ absolutePath: join(pkg, "attachments", "segment.mp4"), packagePath: "attachments/segment.mp4", declaredType: "application/walkthrough-video" }],
    attempts: [], segments: [],
  });
  const result = await verifyPackage(manifest, pkg);
  assert.equal(result.accepted, true, JSON.stringify(result.findings));
  assert.equal(manifest.attachments![0].declaredType, "application/walkthrough-video");
  assert.ok(manifest.attachments![0].sha256.length === 64);
});
