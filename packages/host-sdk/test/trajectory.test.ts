/**
 * Unit tests for trajectory manifest construction (viewer data path).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTrajectory } from "../src/index.js";

async function tempPackage(events: string, media: unknown[] = [], segments: unknown[] = []): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "trajectory-test-"));
  await mkdir(join(root, "journal"), { recursive: true });
  await writeFile(join(root, "journal", "session-events.jsonl"), events);
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    packageId: "pkg-test", sessionId: "session-x",
    media, segments,
    records: [],
  }));
  return root;
}

test("steps derive from action-start records with separate outcome dimensions", async () => {
  const events = [
    JSON.stringify({ kind: "action-start", actionId: "a1", attemptId: "att-1", stepId: "s1", title: "click", writtenAt: "t" }),
    JSON.stringify({ kind: "action-completion", actionId: "a1", kind2: undefined, toolOutcome: { kind: "success" } }),
    JSON.stringify({ kind: "action-start", actionId: "a2", attemptId: "att-1", stepId: "s2", title: "dangling", writtenAt: "t" }),
    JSON.stringify({ kind: "action-refusal", actionId: "a3", attemptId: "att-1" }),
  ].join("\n");
  const root = await tempPackage(events, [
    { path: "media/x.mp4", decode: "playable", finalized: true },
  ], [
    { segmentId: "seg-1", attemptId: "att-1", artifactPath: "media/x.mp4" },
  ]);
  const wt = await buildTrajectory(root);
  assert.equal(wt.steps.length, 3);
  assert.equal(wt.steps[0].execution, "completed");
  assert.equal(wt.steps[1].execution, "incomplete"); // dangling start
  assert.equal(wt.steps[2].execution, "refused");
  assert.equal(wt.steps[0].id, "s1");
  // Duplicate stepIds across attempts are qualified, keeping links stable.
  assert.ok(wt.steps.every((s) => s.id.length > 0));
  // REVIEW-02: three independent dimensions, human review starts pending.
  assert.deepEqual(wt.outcomes, { recording: "complete", execution: "uncertain", humanReview: "pending" });
});

test("damaged media drives recording incompleteness without merging dimensions", async () => {
  const events = [
    JSON.stringify({ kind: "action-start", actionId: "a1", attemptId: "att-1", stepId: "s1", title: "x", writtenAt: "t" }),
    JSON.stringify({ kind: "action-completion", actionId: "a1", toolOutcome: { kind: "success" } }),
  ].join("\n");
  const root = await tempPackage(events, [
    { path: "media/x.mp4", decode: "damaged", finalized: false },
  ], [
    { segmentId: "seg-1", attemptId: "att-1", artifactPath: "media/x.mp4" },
  ]);
  const wt = await buildTrajectory(root);
  assert.equal(wt.outcomes.recording, "incomplete");
  assert.equal(wt.outcomes.execution, "passed"); // executions succeeded; recording is separate
});

// Regression test for the c813020 fix: interior coalescing-group members
// must bind the group's shared pair via the START RECORD's
// snapshotPlan.group.groupId — the pre-fix binder read a top-level
// `start.groupId` that never exists, leaving members with
// `snapshots: undefined`. This test fails against that broken path.
test("coalescing-group members bind the shared pair via snapshotPlan.group.groupId", async () => {
  const BEFORE = "snapshots/b.png";
  const AFTER = "snapshots/a.png";
  const GROUP = "grp-hello";
  const start = (actionId: string, stepId: string, title: string, planRole?: string) =>
    JSON.stringify({
      kind: "action-start", actionId, attemptId: "att-1", stepId,
      title, writtenAt: "t",
      // This is the shape the runtime actually journals (retainActionStart).
      snapshotPlan: planRole === undefined ? undefined : {
        capturesBefore: planRole === "first",
        capturesAfter: planRole === "last",
        role: planRole,
        // The runtime's plan carries a group ONLY for coalescing members —
        // a single event's plan has no group field (resolveSnapshotPlan).
        group: planRole === "first" || planRole === "member" || planRole === "last"
          ? { groupId: GROUP }
          : undefined,
      },
    });
  const events = [
    // Single event with its own pair.
    start("a1", "click", "Click", "single"),
    JSON.stringify({ kind: "action-completion", actionId: "a1", toolOutcome: { kind: "success" } }),
    // Group: first / member / member / last.
    start("g1", "type-h", "Type h", "first"),
    JSON.stringify({ kind: "action-completion", actionId: "g1", toolOutcome: { kind: "success" } }),
    start("g2", "type-e", "Type e", "member"),
    JSON.stringify({ kind: "action-completion", actionId: "g2", toolOutcome: { kind: "success" } }),
    start("g3", "type-l", "Type l", "member"),
    JSON.stringify({ kind: "action-completion", actionId: "g3", toolOutcome: { kind: "success" } }),
    start("g4", "type-o", "Type o", "last"),
    JSON.stringify({ kind: "action-completion", actionId: "g4", toolOutcome: { kind: "success" } }),
  ].join("\n");
  const root = await tempPackage(events);
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    packageId: "pkg-test", sessionId: "session-x",
    media: [], segments: [], records: [],
    snapshots: [
      { path: BEFORE, actionId: "a1", role: "before", capturedAt: "c1", provenance: "dispatch-captured", sha256: "x", bytes: 1 },
      { path: AFTER, actionId: "a1", role: "after", declaredAfterIntervalMs: 700, capturedAt: "c2", provenance: "dispatch-captured", sha256: "x", bytes: 1 },
      { path: BEFORE, actionId: "g1", role: "before", groupId: GROUP, capturedAt: "c3", provenance: "dispatch-captured", sha256: "x", bytes: 1 },
      { path: AFTER, actionId: "g4", role: "after", groupId: GROUP, declaredAfterIntervalMs: 900, capturedAt: "c4", provenance: "dispatch-captured", sha256: "x", bytes: 1 },
    ],
  }));
  const wt = await buildTrajectory(root);
  const byId = new Map(wt.steps.map((s) => [s.id, s]));

  // Single event binds its OWN pair.
  const single = byId.get("click")!;
  assert.deepEqual(single.snapshots, { before: BEFORE, after: AFTER, declaredAfterIntervalMs: 700 });

  // EVERY group member — including interior ones g2/g3 — binds the shared pair.
  const expectedMember = {
    before: BEFORE,
    after: AFTER,
    groupId: GROUP,
    declaredAfterIntervalMs: 900,
  };
  for (const id of ["type-h", "type-e", "type-l", "type-o"]) {
    const step = byId.get(id)!;
    assert.ok(step.snapshots, `member ${id} must bind the group pair`);
    assert.equal(step.snapshots!.groupId, GROUP);
    if (id === "type-h") {
      // First member: it captured the before itself.
      assert.equal(step.snapshots!.before, BEFORE);
      assert.equal(step.snapshots!.after, AFTER);
      assert.equal(step.snapshots!.declaredAfterIntervalMs, 900);
    } else if (id === "type-o") {
      // Last member: it captured the after itself.
      assert.equal(step.snapshots!.after, AFTER);
      assert.equal(step.snapshots!.before, BEFORE);
    } else {
      // Interior members cite the group pair captured by the bookends.
      assert.deepEqual(step.snapshots, expectedMember,
        `interior member ${id} must cite the shared group pair (regression: pre-c813020 left this undefined)`);
    }
  }
});

// The binder must never silently bind a member that has no plan path: a
// member action record WITHOUT snapshotPlan.group.groupId gets no snapshots
// even when same-group snapshot artifacts exist (membership is plan-driven,
// never inferred from artifact proximity).
test("members without a declared group plan do not inherit snapshots", async () => {
  const events = [
    JSON.stringify({
      kind: "action-start", actionId: "m1", attemptId: "att-1", stepId: "m",
      title: "member without plan", writtenAt: "t",
      snapshotPlan: { capturesBefore: false, capturesAfter: false, role: "member" }, // no group field
    }),
    JSON.stringify({ kind: "action-completion", actionId: "m1", toolOutcome: { kind: "success" } }),
  ].join("\n");
  const root = await tempPackage(events);
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    packageId: "pkg-test", sessionId: "session-x",
    media: [], segments: [], records: [],
    snapshots: [
      { path: "snapshots/b.png", actionId: "other", role: "before", groupId: "grp-x", capturedAt: "c", provenance: "dispatch-captured", sha256: "x", bytes: 1 },
      { path: "snapshots/a.png", actionId: "other2", role: "after", groupId: "grp-x", capturedAt: "c", provenance: "dispatch-captured", sha256: "x", bytes: 1 },
    ],
  }));
  const wt = await buildTrajectory(root);
  const step = wt.steps.find((s) => s.id === "m")!;
  assert.ok(step, "member step exists");
  assert.equal(step.snapshots, undefined,
    "no groupId on the plan and no action-owned pair: no snapshots bound");
});
