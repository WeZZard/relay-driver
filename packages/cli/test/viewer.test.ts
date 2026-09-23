/**
 * Committed Playwright test for the walkthrough viewer (gap #4).
 *
 * Builds a fixture package (journal → buildWalkthrough → walkthrough.json +
 * snapshot PNGs), serves it with the real review server, and asserts the
 * rendered viewer: step list, before/after image bindings, the group's
 * shared pair cited by interior members, dispatch-captured provenance
 * labels, and refused-step rendering.
 *
 * Skips cleanly when Playwright is unavailable (it is a dev-time visual
 * dependency, not a runtime one).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWalkthrough, type WalkthroughManifest } from "@wezzard/relay-driver-host-sdk";
import { startReviewServer, type ReviewServer } from "../src/review-server.js";

// Repo viewer/ directory: packages/cli/dist/test/ → repo root is 4 up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const VIEWER_ROOT = join(REPO_ROOT, "viewer");

// 1x1 gray PNG (valid, tiny; the viewer <img> elements load it fine).
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function loadPlaywright(): Promise<Record<string, unknown> | null> {
  // Normal resolution first; PLAYWRIGHT_MODULE lets a dev point at a global
  // or otherwise out-of-tree install (e.g. an nvm global) when plain
  // resolution can't find one on this machine.
  const candidates = ["playwright", ...(process.env.PLAYWRIGHT_MODULE ? [process.env.PLAYWRIGHT_MODULE] : [])];
  for (const spec of candidates) {
    try {
      return (await import(/* @vite-ignore */ spec)) as unknown as Record<string, unknown>;
    } catch {
      // try next
    }
  }
  return null;
}

async function buildFixturePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "viewer-test-pkg-"));
  await mkdir(join(root, "journal"), { recursive: true });
  const start = (actionId: string, stepId: string, title: string, role?: string) =>
    JSON.stringify({
      kind: "action-start", actionId, attemptId: "att-1", stepId, title, writtenAt: "t",
      snapshotPlan: role === undefined ? undefined : {
        capturesBefore: role === "first" || role === "single",
        capturesAfter: role === "last" || role === "single",
        role,
        group: role === "first" || role === "member" || role === "last" ? { groupId: "grp-hello" } : undefined,
      },
    });
  const events = [
    start("a1", "click", "Click save", "single"),
    JSON.stringify({ kind: "action-completion", actionId: "a1", toolOutcome: { kind: "success", value: "clicked" } }),
    start("g1", "type-h", "Type h", "first"),
    JSON.stringify({ kind: "action-completion", actionId: "g1", toolOutcome: { kind: "success", value: "h" } }),
    start("g2", "type-e", "Type e", "member"),
    JSON.stringify({ kind: "action-completion", actionId: "g2", toolOutcome: { kind: "success", value: "e" } }),
    start("g3", "type-l", "Type l", "member"),
    JSON.stringify({ kind: "action-completion", actionId: "g3", toolOutcome: { kind: "success", value: "l" } }),
    start("g4", "type-o", "Type o", "last"),
    JSON.stringify({ kind: "action-completion", actionId: "g4", toolOutcome: { kind: "success", value: "o" } }),
    JSON.stringify({ kind: "action-refusal", actionId: "r1", attemptId: "att-1", title: "refused: capture unavailable" }),
  ].join("\n");
  await writeFile(join(root, "journal", "session-events.jsonl"), events);
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    packageId: "pkg-viewer-test", sessionId: "session-viewer",
    media: [], segments: [], records: [],
    snapshots: [
      { path: "snapshots/single-before.png", actionId: "a1", role: "before", capturedAt: "c1", provenance: "dispatch-captured", sha256: "x", bytes: PNG_1X1.length },
      { path: "snapshots/single-after.png", actionId: "a1", role: "after", declaredAfterIntervalMs: 700, capturedAt: "c2", provenance: "dispatch-captured", sha256: "x", bytes: PNG_1X1.length },
      { path: "snapshots/grp-before.png", actionId: "g1", role: "before", groupId: "grp-hello", capturedAt: "c3", provenance: "dispatch-captured", sha256: "x", bytes: PNG_1X1.length },
      { path: "snapshots/grp-after.png", actionId: "g4", role: "after", groupId: "grp-hello", declaredAfterIntervalMs: 800, capturedAt: "c4", provenance: "dispatch-captured", sha256: "x", bytes: PNG_1X1.length },
    ],
  }));
  const wt: WalkthroughManifest = await buildWalkthrough(root, { packageId: "pkg-viewer-test" });
  await writeFile(join(root, "walkthrough.json"), JSON.stringify(wt));
  // Real PNG bytes so the <img> loads succeed (viewer strips src on error).
  await mkdir(join(root, "snapshots"), { recursive: true });
  for (const name of wt.steps.flatMap((s) => [s.snapshots?.before, s.snapshots?.after])) {
    if (name) await writeFile(join(root, name), PNG_1X1);
  }
  return root;
}

test("viewer renders steps, snapshot pairs, group binding, provenance, refusals", async (t) => {
  const playwright = await loadPlaywright();
  if (!playwright) return t.skip("Playwright unavailable");

  const pkgDir = await buildFixturePackage();
  const server: ReviewServer = await startReviewServer(pkgDir, VIEWER_ROOT);
  t.after(() => server.close());

  const { chromium } = playwright as { chromium: { launch(o: unknown): Promise<any> } };
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.url);

    // Steps list: 4 group/ single steps + 1 refusal-only step.
    const stepCount = await page.locator("#steps li").count();
    assert.equal(stepCount, 6, "click + 4 typing members + refusal-only step");

    // Provenance labels (dispatch-captured) are rendered in the pair panel.
    const provenance = await page.locator(".provenance").allTextContents();
    assert.ok(provenance.every((p: string) => p === "dispatch-captured"), "provenance labels present");

    // Single step binds its own pair.
    await page.locator('#steps li[data-step-id="click"]').click();
    const singleBefore = await page.locator("#snapshot-before").getAttribute("src");
    const singleAfter = await page.locator("#snapshot-after").getAttribute("src");
    assert.equal(singleBefore, "snapshots/single-before.png");
    assert.equal(singleAfter, "snapshots/single-after.png");
    const singleMeta = await page.locator("#snapshot-after-meta").textContent();
    assert.match(singleMeta ?? "", /\+700ms/);

    // Interior group member cites the SHARED pair (regression surface for
    // the c813020 class of bug, now asserted through the real browser).
    await page.locator('#steps li[data-step-id="type-e"]').click();
    const memberBefore = await page.locator("#snapshot-before").getAttribute("src");
    const memberAfter = await page.locator("#snapshot-after").getAttribute("src");
    assert.equal(memberBefore, "snapshots/grp-before.png");
    assert.equal(memberAfter, "snapshots/grp-after.png");
    const memberMeta = await page.locator("#snapshot-after-meta").textContent();
    assert.match(memberMeta ?? "", /\+800ms/);
    assert.match(memberMeta ?? "", /group grp-hello/);

    // Refusal-only step is rendered as refused.
    const refusedClass = await page.locator('#steps li[data-step-id="r1"]').getAttribute("class");
    assert.ok(refusedClass?.includes("step-refused"), "refused step carries step-refused class");
  } finally {
    await browser.close();
  }
});
