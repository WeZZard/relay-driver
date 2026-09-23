/**
 * Portable evidence package (EVIDENCE-01 / EXPORT-01, D18).
 *
 * A package is a directory with a versioned manifest, relative artifact
 * paths, and media whose integrity, decodability, and recording-completeness
 * states are kept separate:
 *
 *  - integrity:   bytes match the manifest checksum (delivery verification).
 *  - decodability: media decodes; only artifacts advertised playable must.
 *  - completeness: whether the recording covers the claimed timeline.
 *
 * A source-declared damaged original passes delivery verification when its
 * bytes match and its failed decode state is explicit. Missing required
 * bytes, checksum mismatches, invalid references, or corruption of media
 * advertised as playable fail acceptance.
 */

import { createHash } from "node:crypto";
import { readFile, stat, readdir } from "node:fs/promises";
import { join, relative, posix } from "node:path";
import { spawn } from "node:child_process";

export const MANIFEST_VERSION = 1;

/** Integrity + decodability facts for one packaged media file. */
export interface MediaArtifact {
  /** Relative POSIX path inside the package. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Explicit decodability state; "damaged" originals keep their diagnostic. */
  readonly decode: "playable" | "damaged" | "unchecked";
  /** Duration/dimensions; unknown for damaged media stays undefined. */
  readonly media?: {
    readonly durationSeconds?: number;
    readonly width?: number;
    readonly height?: number;
    readonly codec?: string;
  };
  /** Diagnostic retained when decode is "damaged" or "unchecked". */
  readonly decodeDiagnostic?: string;
  readonly segmentId: string;
  /** Whether the source recorder finalized this segment (D18). */
  readonly finalized: boolean;
}

export interface PackageManifest {
  readonly manifestVersion: number;
  readonly packageId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly createdAt: string;
  /** Attempts in delivery order; an interrupted attempt precedes its continuation. */
  readonly attempts: ReadonlyArray<{
    readonly attemptId: string;
    readonly state: "interrupted" | "completed" | "refused";
    readonly continuesAttemptId?: string;
    readonly segmentIds: readonly string[];
  }>;
  readonly segments: ReadonlyArray<{
    readonly segmentId: string;
    readonly attemptId: string;
    /** Manifest-relative media path. */
    readonly artifactPath: string;
    /** Media time of the segment's first captured frame (playback zero, D5). */
    readonly clockMapping: {
      readonly mediaTimeZero: number;
      readonly anchor: "first-captured-frame";
    };
  }>;
  /** Event journal and record artifacts (integrity-checked, not media). */
  readonly records: ReadonlyArray<{
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  }>;
  /**
   * Dispatch-time snapshot evidence (SNAP-01/02/03). Each file is
   * provenance-tagged dispatch-captured with hash-at-capture; action
   * records reference these by path.
   */
  readonly snapshots?: ReadonlyArray<SnapshotArtifact>;
  /**
   * Application-supplied attachments (2026-09-11 decision): Relay verifies
   * the bytes byte-wise but NEVER interprets their meaning. This is how an
   * application (e.g. Walkthrough) adds continuous video as supplementary
   * evidence without Relay owning any video semantics.
   */
  readonly attachments?: ReadonlyArray<{
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
    /** Application-declared type label, uninterpreted by Relay. */
    readonly declaredType?: string;
  }>;
  readonly media: ReadonlyArray<MediaArtifact>;
  readonly openingInstructions: string;
}

/** One dispatch-time snapshot artifact with causal-pair provenance. */
export interface SnapshotArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Where in the journal this snapshot anchors (actionId). */
  readonly actionId: string;
  /** "before" | "after" — the causal pair role. */
  readonly role: "before" | "after";
  /** Coalescing group identity when the snapshot belongs to a group pair. */
  readonly groupId?: string;
  /** Declared after-interval for after-snapshots (agent-supplied). */
  readonly declaredAfterIntervalMs?: number;
  readonly capturedAt: string;
  /** Fixed provenance class for dispatch-time captures. */
  readonly provenance: "dispatch-captured";
}

// ---------------------------------------------------------------------------
// Manifest building
// ---------------------------------------------------------------------------

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fileBytes(path: string): Promise<number> {
  return (await stat(path)).size;
}

function toPosix(p: string): string {
  return p.split("\\").join("/").replace(/^\.\//, "");
}

/**
 * Probe a media file with ffprobe. Returns explicit decode facts; a failed
 * probe is retained as a damaged state with its diagnostic — never silently
 * upgraded to playable.
 */
export async function probeMedia(
  path: string,
): Promise<Pick<MediaArtifact, "decode" | "media" | "decodeDiagnostic">> {
  return new Promise((resolve) => {
    const child = spawn(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries", "format=duration:stream=codec_name,width,height",
        "-of", "json",
        path,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (err) => {
      resolve({ decode: "unchecked", decodeDiagnostic: `ffprobe unavailable: ${err.message}` });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({ decode: "damaged", decodeDiagnostic: stderr.trim().slice(0, 500) });
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as {
          format?: { duration?: string };
          streams?: Array<{ codec_name?: string; width?: number; height?: number }>;
        };
        const video = parsed.streams?.find((s) => s.codec_name);
        if (!video) {
          resolve({ decode: "damaged", decodeDiagnostic: "no decodable stream" });
          return;
        }
        resolve({
          decode: "playable",
          media: {
            durationSeconds: parsed.format?.duration
              ? Number(parsed.format.duration)
              : undefined,
            width: video.width,
            height: video.height,
            codec: video.codec_name,
          },
        });
      } catch (err) {
        resolve({ decode: "damaged", decodeDiagnostic: `probe parse failure: ${String(err)}` });
      }
    });
  });
}

export interface BuildManifestInput {
  readonly packageId: string;
  readonly sessionId: string;
  readonly taskId: string;
  /** Absolute path of the package root on the assembling host. */
  readonly rootDir: string;
  /** Media files, keyed by absolute source path, with source-known state. */
  readonly media: ReadonlyArray<{
    readonly absolutePath: string;
    readonly packagePath: string;
    readonly segmentId: string;
    readonly finalized: boolean;
  }>;
  readonly records: ReadonlyArray<{ readonly absolutePath: string; readonly packagePath: string }>;
  /** Snapshot evidence files (hash-at-capture facts verified at build). */
  readonly snapshots?: ReadonlyArray<{
    readonly absolutePath: string;
    readonly packagePath: string;
    readonly actionId: string;
    readonly role: "before" | "after";
    readonly groupId?: string;
    readonly declaredAfterIntervalMs?: number;
    readonly capturedAt: string;
  }>;
  /** Application-supplied attachments (byte-verified, uninterpreted). */
  readonly attachments?: ReadonlyArray<{
    readonly absolutePath: string;
    readonly packagePath: string;
    readonly declaredType?: string;
  }>;
  readonly attempts: PackageManifest["attempts"];
  readonly segments: PackageManifest["segments"];
  readonly openingInstructions?: string;
}

/** Build a manifest with integrity facts computed from the assembled files. */
export async function buildManifest(input: BuildManifestInput): Promise<PackageManifest> {
  const media: MediaArtifact[] = [];
  for (const m of input.media) {
    const probed = await probeMedia(m.absolutePath);
    media.push({
      path: toPosix(m.packagePath),
      sha256: await sha256File(m.absolutePath),
      bytes: await fileBytes(m.absolutePath),
      segmentId: m.segmentId,
      finalized: m.finalized,
      ...probed,
    });
  }
  const records = [];
  for (const r of input.records) {
    records.push({
      path: toPosix(r.packagePath),
      sha256: await sha256File(r.absolutePath),
      bytes: await fileBytes(r.absolutePath),
    });
  }
  const snapshots = [];
  for (const sn of input.snapshots ?? []) {
    snapshots.push({
      path: toPosix(sn.packagePath),
      sha256: await sha256File(sn.absolutePath),
      bytes: await fileBytes(sn.absolutePath),
      actionId: sn.actionId,
      role: sn.role,
      groupId: sn.groupId,
      declaredAfterIntervalMs: sn.declaredAfterIntervalMs,
      capturedAt: sn.capturedAt,
      provenance: "dispatch-captured" as const,
    });
  }
  const attachments = [];
  for (const at of input.attachments ?? []) {
    attachments.push({
      path: toPosix(at.packagePath),
      sha256: await sha256File(at.absolutePath),
      bytes: await fileBytes(at.absolutePath),
      declaredType: at.declaredType,
    });
  }
  return {
    manifestVersion: MANIFEST_VERSION,
    packageId: input.packageId,
    sessionId: input.sessionId,
    taskId: input.taskId,
    createdAt: new Date().toISOString(),
    attempts: input.attempts,
    segments: input.segments,
    records,
    snapshots: snapshots.length > 0 ? snapshots : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
    media,
    openingInstructions:
      input.openingInstructions ??
      "Open index.html from this package directory in a browser. " +
        "The viewer reads only files inside this package; no execution environment or external service is required.",
  };
}

// ---------------------------------------------------------------------------
// Host acceptance (EVIDENCE-01 host-acceptance steps 1–5)
// ---------------------------------------------------------------------------

export interface AcceptanceFinding {
  readonly code:
    | "missing-artifact"
    | "checksum-mismatch"
    | "playable-failed-decode"
    | "invalid-reference"
    | "damaged-original-ok"
    | "damaged-original-flagged-playable"
    | "state-inconsistent"
    | "ok";
  readonly detail: string;
}

export interface AcceptanceResult {
  readonly accepted: boolean;
  readonly findings: AcceptanceFinding[];
  /** Per-artifact integrity results, including damaged originals. */
  readonly integrity: ReadonlyArray<{ path: string; verified: boolean }>;
}

/** Validate a delivered package directory against its manifest. */
export async function verifyPackage(
  manifest: PackageManifest,
  rootDir: string,
): Promise<AcceptanceResult> {
  const findings: AcceptanceFinding[] = [];
  const integrity: { path: string; verified: boolean }[] = [];
  let accepted = true;

  const checkArtifact = async (relPath: string, expectedSha: string): Promise<boolean> => {
    const abs = join(rootDir, relPath);
    let bytes: Buffer;
    try {
      bytes = await readFile(abs);
    } catch {
      findings.push({ code: "missing-artifact", detail: relPath });
      return false;
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expectedSha) {
      findings.push({ code: "checksum-mismatch", detail: `${relPath} expected ${expectedSha.slice(0, 12)} got ${actual.slice(0, 12)}` });
      return false;
    }
    integrity.push({ path: relPath, verified: true });
    return true;
  };

  // 1+2. Every artifact's checksum, including damaged originals; then decode.
  for (const m of manifest.media) {
    const present = await checkArtifact(m.path, m.sha256);
    if (!present) {
      accepted = false;
      continue;
    }
    const probed = await probeMedia(join(rootDir, m.path));
    if (m.decode === "playable") {
      if (probed.decode !== "playable") {
        // Advertised playable must decode after transfer.
        findings.push({ code: "playable-failed-decode", detail: `${m.path}: ${probed.decodeDiagnostic ?? "undecodable"}` });
        accepted = false;
      }
    } else if (m.decode === "damaged") {
      if (probed.decode === "playable") {
        // A damaged original that now decodes means the source state was
        // mislabeled; the flag cannot excuse that, so acceptance fails.
        findings.push({ code: "damaged-original-flagged-playable", detail: `${m.path}: source declared damaged but decodes` });
        accepted = false;
      } else {
        findings.push({ code: "damaged-original-ok", detail: `${m.path}: bytes verified, decode remains failed (${probed.decodeDiagnostic ?? "no diagnostic"})` });
      }
    }
  }
  for (const r of manifest.records) {
    const ok = await checkArtifact(r.path, r.sha256);
    if (!ok) accepted = false;
  }
  // Snapshot evidence: byte integrity + provenance class is fixed.
  for (const sn of manifest.snapshots ?? []) {
    const ok = await checkArtifact(sn.path, sn.sha256);
    if (!ok) accepted = false;
    if (sn.provenance !== "dispatch-captured") {
      findings.push({ code: "state-inconsistent", detail: `snapshot ${sn.path} has non-dispatch provenance "${sn.provenance}"` });
      accepted = false;
    }
  }
  // Application attachments: byte-verified, never interpreted.
  for (const at of manifest.attachments ?? []) {
    const ok = await checkArtifact(at.path, at.sha256);
    if (!ok) accepted = false;
  }

  // 3. Every reference resolves: segments point at real media artifacts,
  //    attempts point at real segments.
  const mediaByPath = new Map(manifest.media.map((m) => [m.path, m]));
  const segmentIds = new Set(manifest.segments.map((s) => s.segmentId));
  for (const s of manifest.segments) {
    if (!mediaByPath.has(s.artifactPath)) {
      findings.push({ code: "invalid-reference", detail: `segment ${s.segmentId} artifact ${s.artifactPath}` });
      accepted = false;
    }
  }
  for (const a of manifest.attempts) {
    for (const segId of a.segmentIds) {
      if (!segmentIds.has(segId)) {
        findings.push({ code: "invalid-reference", detail: `attempt ${a.attemptId} segment ${segId}` });
        accepted = false;
      }
    }
    if (a.continuesAttemptId && !manifest.attempts.some((x) => x.attemptId === a.continuesAttemptId)) {
      findings.push({ code: "invalid-reference", detail: `attempt ${a.attemptId} continues unknown ${a.continuesAttemptId}` });
      accepted = false;
    }
  }

  // 3b. Snapshot references: each snapshot cites an action identity; group
  //     pairs must be internally consistent (a group's before/after share
  //     the groupId; roles are valid).
  const snapshotList = manifest.snapshots ?? [];
  for (const sn of snapshotList) {
    if (sn.role !== "before" && sn.role !== "after") {
      findings.push({ code: "state-inconsistent", detail: `snapshot ${sn.path} has invalid role ${sn.role}` });
      accepted = false;
    }
    if (sn.role === "after" && sn.declaredAfterIntervalMs === undefined) {
      findings.push({ code: "state-inconsistent", detail: `after-snapshot ${sn.path} lacks its declared interval` });
      accepted = false;
    }
  }
  const groupIds = new Set(snapshotList.map((sn) => sn.groupId).filter(Boolean));
  for (const gid of groupIds) {
    const members = snapshotList.filter((sn) => sn.groupId === gid);
    const roles = new Set(members.map((m) => m.role));
    if (members.length !== 2 || !roles.has("before") || !roles.has("after")) {
      findings.push({ code: "state-inconsistent", detail: `group ${gid} does not carry exactly one before/after pair` });
      accepted = false;
    }
  }

  // 4. Timeline bounds: playable media may carry the frame references; the
  //    damaged original may not support any playable-frame claim.
  for (const s of manifest.segments) {
    const m = mediaByPath.get(s.artifactPath);
    if (!m) continue;
    if (m.decode !== "playable" && s.clockMapping.mediaTimeZero !== 0) {
      findings.push({ code: "state-inconsistent", detail: `segment ${s.segmentId} claims a clock mapping over damaged media` });
      accepted = false;
    }
  }

  // 5. Failed/incomplete attempts retain their declared state (no laundering
  //    an interrupted attempt into completed in the manifest).
  const interrupted = manifest.attempts.filter((a) => a.state === "interrupted");
  for (const a of interrupted) {
    if (a.continuesAttemptId === undefined) {
      findings.push({ code: "state-inconsistent", detail: `interrupted attempt ${a.attemptId} has no continuation reference` });
      accepted = false;
    }
  }

  if (accepted) findings.push({ code: "ok", detail: "all required artifacts verified; damaged originals explicit" });
  return { accepted, findings, integrity };
}

/** Resolve a package-relative path safely (no escaping the package root). */
export function safeJoin(rootDir: string, relPath: string): string {
  const resolved = posix.normalize(toPosix(relPath));
  if (resolved.startsWith("..") || resolved.startsWith("/")) {
    throw new Error(`package path escapes root: ${relPath}`);
  }
  return join(rootDir, resolved);
}

/**
 * Late enrichment (EVIDENCE-01): annotations added after delivery produce a
 * REVALIDATED package revision that references the prior manifest, with all
 * original artifacts and their hashes unchanged. The revision carries only
 * new records; original media and action records are never rewritten.
 */
export interface AnnotationRecord {
  readonly annotationId: string;
  readonly author: string;
  readonly writtenAt: string;
  /** Referenced evidence identities (action ids, segment ids, artifact paths). */
  readonly references: readonly string[];
  readonly text: string;
}

export interface PackageRevision {
  readonly revision: number;
  readonly priorManifestSha256: string;
  readonly annotations: readonly AnnotationRecord[];
  /** Original manifest, byte-preserved inside the revision. */
  readonly originalManifest: PackageManifest;
  readonly createdAt: string;
}

export async function enrichPackage(
  manifest: PackageManifest,
  rootDir: string,
  annotations: readonly AnnotationRecord[],
): Promise<PackageRevision> {
  // Revalidation runs acceptance first: enrichment never papers over a
  // package that does not verify.
  const base = await verifyPackage(manifest, rootDir);
  if (!base.accepted) {
    throw new Error(`cannot enrich a package that fails acceptance: ${base.findings.map((f) => f.detail).join("; ")}`);
  }
  const manifestBytes = JSON.stringify(manifest);
  return {
    revision: 2,
    priorManifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    annotations,
    originalManifest: manifest,
    createdAt: new Date().toISOString(),
  };
}

/** Validate a revision: original manifest unchanged plus annotations resolvable. */
export async function verifyPackageRevision(
  revision: PackageRevision,
  rootDir: string,
): Promise<AcceptanceResult> {
  const base = await verifyPackage(revision.originalManifest, rootDir);
  // The prior-manifest hash must match the delivered original manifest.
  const current = createHash("sha256")
    .update(JSON.stringify(revision.originalManifest))
    .digest("hex");
  if (current !== revision.priorManifestSha256) {
    return {
      accepted: false,
      findings: [...base.findings, { code: "state-inconsistent", detail: "prior manifest hash does not match the delivered original manifest" }],
      integrity: base.integrity,
    };
  }
  // Every annotation reference must resolve to a known identity.
  const known = new Set<string>([
    ...revision.originalManifest.attempts.map((a) => a.attemptId),
    ...revision.originalManifest.segments.map((s) => s.segmentId),
    ...revision.originalManifest.media.map((m) => m.path),
    ...revision.originalManifest.records.map((r) => r.path),
  ]);
  const unresolved = revision.annotations
    .flatMap((a) => a.references)
    .filter((ref) => !known.has(ref));
  if (unresolved.length > 0) {
    return {
      accepted: false,
      findings: [
        ...base.findings,
        { code: "invalid-reference", detail: `annotations reference unknown identities: ${unresolved.join(", ")}` },
      ],
      integrity: base.integrity,
    };
  }
  return base;
}

/** List files under a directory recursively (relative POSIX paths). */
export async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

export { relative };
