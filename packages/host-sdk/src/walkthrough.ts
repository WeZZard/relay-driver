/**
 * Build the viewer-facing walkthrough manifest (walkthrough.json) from a
 * delivered package: manifest.json (Stage 4) + journal + action records.
 *
 * Steps are derived from action records; execution outcome, recording
 * completeness, and human review stay separate dimensions (REVIEW-02).
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface ReviewStep {
  readonly id: string;
  readonly attemptId: string;
  readonly title: string;
  readonly execution: "completed" | "failed" | "refused" | "uncertain" | "incomplete";
  readonly state: string;
  readonly expected?: string;
  readonly observed?: string;
  /**
   * Dispatch-time snapshot pair (SNAP-01/02/03): the causal evidence for
   * this step. Absent for non-display actions and refusal-only steps.
   */
  readonly snapshots?: {
    readonly before?: string;
    readonly after?: string;
    readonly groupId?: string;
    readonly declaredAfterIntervalMs?: number;
  };
  readonly reviewPoint?: {
    readonly segmentId: string;
    readonly timeSeconds: number;
    readonly stillFrame?: string;
  };
  readonly annotations?: Array<{ author: string; writtenAt: string; text: string }>;
}

export interface WalkthroughManifest {
  readonly formatVersion: string;
  readonly packageId: string;
  readonly sessionId: string;
  readonly media: Array<{ path: string; decode: string; decodeDiagnostic?: string; durationSeconds?: number; width?: number; height?: number; finalized: boolean }>;
  readonly segments: Array<{ segmentId: string; attemptId: string; artifactPath: string }>;
  readonly steps: ReviewStep[];
  readonly outcomes: { recording: string; execution: string; humanReview: string };
}

/** Build walkthrough.json content for a package directory. */
export async function buildWalkthrough(
  packageDir: string,
  options: { packageId?: string; steps?: ReviewStep[]; execution?: string } = {},
): Promise<WalkthroughManifest> {
  const manifest = JSON.parse(await readFile(join(packageDir, "manifest.json"), "utf8")) as {
    packageId: string;
    sessionId: string;
    media: WalkthroughManifest["media"];
    segments: Array<{ segmentId: string; attemptId: string; artifactPath: string }>;
    snapshots?: Array<{
      path: string; actionId: string; role: "before" | "after";
      groupId?: string; declaredAfterIntervalMs?: number; provenance: string;
    }>;
  };
  const journalLines = (await readFile(join(packageDir, "journal", "session-events.jsonl"), "utf8"))
    .split("\n").filter(Boolean).map((l) => JSON.parse(l) as {
      kind: string; actionId?: string; stepId?: string; attemptId?: string;
      title?: string; toolOutcome?: { kind?: string; value?: unknown };
      diagnostic?: string;
    });

  // Group actions by attempt; steps come from action-start records.
  const completionByAction = new Map<string, { toolOutcome?: { kind?: string; value?: unknown } }>();
  for (const rec of journalLines) {
    if (rec.kind === "action-completion") completionByAction.set(rec.actionId ?? "", rec);
  }
  const refusals = new Set<string>(
    journalLines.filter((r) => r.kind === "action-refusal").map((r) => r.actionId ?? ""),
  );

  const segments = manifest.segments.map((s) => ({
    segmentId: s.segmentId,
    attemptId: s.attemptId,
    artifactPath: s.artifactPath,
  }));
  const segmentByAttempt = new Map(segments.map((s) => [s.attemptId, s]));
  const usedIds = new Set<string>();

  // Dispatch-time snapshot pairs (SNAP-01/02/03): bind each action to its
  // before/after stills. Group members cite the group's shared pair.
  const snapshotsByAction = new Map<string, { before?: string; after?: string; groupId?: string; declaredAfterIntervalMs?: number }>();
  for (const sn of manifest.snapshots ?? []) {
    const entry = snapshotsByAction.get(sn.actionId) ?? {};
    if (sn.role === "before") entry.before = sn.path; else entry.after = sn.path;
    if (sn.groupId) entry.groupId = sn.groupId;
    if (sn.declaredAfterIntervalMs !== undefined) entry.declaredAfterIntervalMs = sn.declaredAfterIntervalMs;
    snapshotsByAction.set(sn.actionId, entry);
  }
  const snapshotRefs = (actionId: string | undefined, groupId: string | undefined) => {
    const own = actionId !== undefined ? snapshotsByAction.get(actionId) : undefined;
    // A group member cites the pair captured by its bookends: find the pair
    // files by groupId, then MERGE with whatever the action itself captured —
    // a first member owns only the before, a last member only the after;
    // neither partial entry may hide the other half of the pair.
    const groupPair = groupId
      ? (() => {
          const before = (manifest.snapshots ?? []).find((sn) => sn.groupId === groupId && sn.role === "before");
          const after = (manifest.snapshots ?? []).find((sn) => sn.groupId === groupId && sn.role === "after");
          return (before || after)
            ? {
                before: before?.path,
                after: after?.path,
                groupId,
                declaredAfterIntervalMs: after?.declaredAfterIntervalMs,
              }
            : undefined;
        })()
      : undefined;
    if (own && groupPair) return { ...groupPair, ...own, groupId: own.groupId ?? groupPair.groupId };
    return own ?? groupPair;
  };

  const steps: ReviewStep[] = options.steps ?? journalLines
    .filter((r) => r.kind === "action-start")
    .map((start, i) => {
      const actionKey = start.actionId ?? `action-${i}`;
      const completion = completionByAction.get(actionKey);
      const outcome = completion?.toolOutcome;
      const seg = segmentByAttempt.get(start.attemptId ?? "");
      const plan = (start as { snapshotPlan?: { group?: { groupId?: string } } }).snapshotPlan;
      const stepSnapshots = snapshotRefs(actionKey, plan?.group?.groupId);
      const execution =
        refusals.has(actionKey) ? "refused"
        : completion ? (outcome?.kind === "success" ? "completed" : "failed")
        : "incomplete";
      // Step ids must be stable AND unique: the same step name across
      // attempts (e.g. both attempts' "seq-0") gets the attempt qualifier.
      const rawId = start.stepId ?? actionKey;
      const id = usedIds.has(rawId) ? `${rawId}@${start.attemptId ?? "a"}` : rawId;
      usedIds.add(id);
      return {
        id,
        attemptId: start.attemptId ?? "unknown-attempt",
        title: start.title ?? `action ${i}`,
        execution,
        state: completion ? "recorded" : "admitted",
        snapshots: stepSnapshots,
        observed: outcome?.kind === "success" && typeof outcome.value === "object"
          ? JSON.stringify(outcome.value).slice(0, 200)
          : undefined,
        reviewPoint: seg ? {
          segmentId: seg.segmentId,
          // The driver's t_ms_from_session_start anchors media time
          // (TIME-01 mapping); action-start records carry writtenAt only, so
          // the review point defaults to the retained start moment.
          timeSeconds: 0,
        } : undefined,
      };
    });

  // Refusals without a start record (admission never happened) are steps
  // too: the reviewer sees why input was refused (CAPTURE-01/D19 evidence).
  const refusalOnly = journalLines.filter(
    (r) => r.kind === "action-refusal" && !journalLines.some(
      (s) => s.kind === "action-start" && s.actionId === r.actionId));
  for (const [i, refusal] of refusalOnly.entries()) {
    const rawId = refusal.actionId ?? `refusal-${i}`;
    const id = usedIds.has(rawId) ? `${rawId}@${refusal.attemptId ?? "a"}` : rawId;
    usedIds.add(id);
    (steps as ReviewStep[]).push({
      id,
      attemptId: refusal.attemptId ?? "unknown-attempt",
      title: refusal.title ?? `refused: ${refusal.diagnostic ?? "admission denied"}`,
      execution: "refused",
      state: "refused",
      observed: typeof refusal.diagnostic === "string" ? refusal.diagnostic : undefined,
    });
  }

  const damaged = manifest.media.filter((m) => m.decode !== "playable");
  return {
    formatVersion: "draft",
    packageId: options.packageId ?? manifest.packageId,
    sessionId: manifest.sessionId,
    media: manifest.media,
    segments,
    steps,
    outcomes: {
      recording: damaged.length === 0 ? "complete" : "incomplete",
      execution: options.execution ?? (steps.some((s) => s.execution === "failed") ? "failed"
        : steps.some((s) => s.execution === "incomplete") ? "uncertain" : "passed"),
      humanReview: "pending",
    },
  };
}

/** List media files in a package (helper for still-frame registration). */
export async function listPackageMedia(packageDir: string): Promise<string[]> {
  try {
    return (await readdir(join(packageDir, "media"))).map((f) => `media/${f}`);
  } catch {
    return [];
  }
}
