/** Assemble + verify the snapshot package on the host (SNAP-04). */
import { buildManifest, verifyPackage } from "@wezzard/relay-driver-host-sdk";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const src = "/tmp/relay-snap-download";
const { createHash } = await import("node:crypto");
const files = await readdir(join(src, "snapshots"));
const snapshots = [];
for (const f of files.filter((f) => f.endsWith(".png"))) {
  const bytes = await readFile(join(src, "snapshots", f));
  // Parse provenance from the journal: match file name → snapshot-captured record
  snapshots.push({
    absolutePath: join(src, "snapshots", f),
    packagePath: `snapshots/${f}`,
    actionId: "journal-matched",
    role: f.includes("-before-") ? "before" as const : "after" as const,
    capturedAt: f.split("-").slice(1, 2).join("-"),
  });
}
const journalBytes = await readFile(join(src, "journal", "session-events.jsonl"));
// Bind actionIds from journal: each snapshot-captured record has actionId + fileName
const recs = journalBytes.toString().split("\n").filter(Boolean).map((l) => JSON.parse(l));
for (const sn of snapshots) {
  const fileName = sn.packagePath.split("/").at(-1);
  const match = recs.find((r) => r.kind === "snapshot-captured" && r.snapshot?.fileName === fileName);
  if (match) { sn.actionId = match.actionId; (sn as any).capturedAt = match.snapshot.capturedAt; }
}
const afterRecs = recs.filter((r) => r.kind === "snapshot-captured" && r.snapshot?.role === "after");
for (const sn of snapshots) {
  const fileName = sn.packagePath.split("/").at(-1);
  const m = afterRecs.find((r) => r.snapshot?.fileName === fileName);
  if (m) (sn as any).declaredAfterIntervalMs = m.snapshot.declaredAfterIntervalMs;
  const groupRec = recs.find((r) => r.kind === "snapshot-captured" && r.snapshot?.fileName === fileName && r.group);
  if (groupRec) (sn as any).groupId = groupRec.group;
}
const manifest = await buildManifest({
  packageId: "pkg-snap-proof",
  sessionId: "session-0mtxuc2s23lk1ftli",  // main proof; refusal sessions share the journal
  taskId: "task-snap-proof",
  rootDir: src,
  media: [],
  records: [{ absolutePath: join(src, "journal", "session-events.jsonl"), packagePath: "journal/session-events.jsonl" }],
  snapshots,
  attempts: [], segments: [],
});
const { writeFile } = await import("node:fs/promises");
await writeFile(join(src, "manifest.json"), JSON.stringify(manifest, null, 2));
const acceptance = await verifyPackage(manifest, src);
console.log(JSON.stringify({
  accepted: acceptance.accepted,
  snapshotCount: manifest.snapshots?.length,
  provenanceOk: manifest.snapshots?.every((s) => s.provenance === "dispatch-captured"),
  findings: acceptance.findings.map((f) => f.code),
}, null, 1));
const sdk = await import("@wezzard/relay-driver-host-sdk");
const trajectory = await sdk.buildTrajectory(src, { packageId: "pkg-snap-proof" });
await writeFile(join(src, "trajectory.json"), JSON.stringify(trajectory, null, 2));
for (const s of trajectory.steps) {
  console.log("step:", s.id, "execution:", s.execution, "snapshots:", JSON.stringify(s.snapshots)?.slice(0, 120));
}
