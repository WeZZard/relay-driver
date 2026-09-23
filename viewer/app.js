/**
 * Relay Driver trajectory viewer (REVIEW-01/REVIEW-02, TIME-02, SNAP-01).
 *
 * Consumes only files inside the delivered package:
 *   trajectory.json    steps, snapshot pairs, outcome dimensions
 *   snapshots/*.png    dispatch-time before/after causal pairs (primary)
 *   media/*, evidence/*  application-supplied supplementary media
 *
 * The three outcome dimensions (recording completeness, execution outcome,
 * human review) are displayed separately and never merged (REVIEW-02).
 * Snapshot stills are labeled dispatch-captured (their provenance class);
 * supplementary media renders only when the application supplied it — the
 * viewer never fabricates a frame or an image.
 */

const params = new URL(location).searchParams;
const steps = [];
let currentStep = -1;
let trajectory = null;

const video = document.getElementById("recording");
const stepsList = document.getElementById("steps");

function setOutcome(id, value) {
  const el = document.getElementById(id);
  el.textContent = el.title.split(":")[0] + ": " + value;
  el.className = "outcome " + String(value).replace(/\s+/g, "-");
}

// Legacy compatibility (owner decision, 2026-09-23, docs/decisions.md#D25):
// packages written before the trajectory rename carry "walkthrough.json"
// instead of "trajectory.json", with the identical manifest shape. Try the
// current name first and fall back to the old one so those packages still
// open; this is the only place that needs to know the old name exists.
async function fetchTrajectoryManifest() {
  const current = await fetch("trajectory.json");
  if (current.ok) return current.json();
  const legacy = await fetch("walkthrough.json");
  return legacy.json();
}

async function load() {
  trajectory = await fetchTrajectoryManifest();
  document.getElementById("package-meta").textContent =
    `package ${trajectory.packageId} · session ${trajectory.sessionId}`;

  setOutcome("outcome-recording", trajectory.outcomes.recording);
  setOutcome("outcome-execution", trajectory.outcomes.execution);
  // Human review is always initialized pending; only a reviewer changes it.
  setOutcome("outcome-review", trajectory.outcomes.humanReview ?? "pending");

  const segmentsById = new Map(trajectory.segments.map((s) => [s.segmentId, s]));
  const mediaById = new Map(trajectory.media.map((m) => [m.path, m]));

  for (const step of trajectory.steps) {
    const li = document.createElement("li");
    li.dataset.stepId = step.id;
    const seg = segmentsById.get(step.reviewPoint?.segmentId);
    const segMedia = seg ? mediaById.get(seg.artifactPath) : null;
    const damaged = segMedia && segMedia.decode !== "playable";
    if (step.execution === "failed") li.classList.add("step-failed");
    if (step.execution === "refused" || step.state === "refused") li.classList.add("step-refused");
    if (step.state === "incomplete" || damaged) li.classList.add("step-incomplete");
    const hasPair = step.snapshots && (step.snapshots.before || step.snapshots.after);
    li.innerHTML =
      `<strong>${escapeHtml(step.title)}</strong>` +
      `<span class="step-time">${hasPair ? "snapshot pair" + (step.snapshots.groupId ? " (group)" : "") : step.reviewPoint ? "media t=" + step.reviewPoint.timeSeconds.toFixed(3) + "s" : "no snapshot evidence"}` +
      `${damaged ? " · damaged segment" : ""}</span>` +
      `<span class="step-attempt">${escapeHtml(step.attemptId)} · ${escapeHtml(step.execution)}</span>`;
    li.addEventListener("click", () => selectStep(step.id, true));
    stepsList.appendChild(li);
    steps.push(step);
  }

  document.querySelectorAll("button[id$='-step']").forEach((b) => {
    b.addEventListener("click", () =>
      selectStep(steps[Math.max(0, Math.min(steps.length - 1, currentStep + (b.id === "next-step" ? 1 : -1)))].id, true));
  });

  // Deep link (#step-id) opens that step directly (stable links, REVIEW-01).
  const initial = params.get("step") ?? location.hash.slice(1);
  if (initial && steps.some((s) => s.id === initial)) selectStep(initial, false);
  else if (steps.length > 0) selectStep(steps[0].id, false);
}

function selectStep(stepId, updateUrl) {
  const idx = steps.findIndex((s) => s.id === stepId);
  if (idx < 0) return;
  currentStep = idx;
  const step = steps[idx];
  const segmentsById = new Map(trajectory.segments.map((s) => [s.segmentId, s]));
  const mediaById = new Map(trajectory.media.map((m) => [m.path, m]));

  document.querySelectorAll("#steps li").forEach((li) =>
    li.classList.toggle("current", li.dataset.stepId === stepId));

  document.getElementById("current-step-title").textContent = step.title;
  document.getElementById("step-detail").innerHTML =
    `<span class="kv">attempt:</span> ${escapeHtml(step.attemptId)} · ` +
    `<span class="kv">execution:</span> ${escapeHtml(step.execution)} · ` +
    `<span class="kv">state:</span> ${escapeHtml(step.state)}` +
    (step.expected ? `<br><span class="kv">expected:</span> ${escapeHtml(step.expected)}` : "") +
    (step.observed ? `<br><span class="kv">observed:</span> ${escapeHtml(step.observed)}` : "") +
    (step.annotations && step.annotations.length
      ? `<div class="annotations"><strong>Annotations</strong> (authored ${escapeHtml(step.annotations[0].author)}, ` +
        `written ${escapeHtml(step.annotations[0].writtenAt)}):<br>` +
        step.annotations.map((a) => escapeHtml(a.text)).join("<br>") + "</div>"
      : "");

  // Seek to the step with preceding context (REVIEW-01): start one second
  // before the review point on the step's own segment.
  const seg = segmentsById.get(step.reviewPoint?.segmentId);
  const segMedia = seg ? mediaById.get(seg.artifactPath) : null;
  if (seg && segMedia && segMedia.decode === "playable") {
    if (!video.src.endsWith(seg.artifactPath)) {
      video.src = seg.artifactPath;
    }
    const start = Math.max(0, step.reviewPoint.timeSeconds - 1.0);
    const seek = () => { video.currentTime = start; video.removeEventListener("loadedmetadata", seek); };
    video.addEventListener("loadedmetadata", seek);
    video.load();
  } else {
    // No playable footage: no fabricated claims (TIME-02/D18).
    video.removeAttribute("src");
    video.load();
  }

  showSnapshots(step);
  showCheckpoint(step, seg, segMedia);
  if (updateUrl) history.replaceState(null, "", `#step-${encodeURIComponent(stepId)}`);
  document.getElementById("step-link").textContent = `${location.origin}${location.pathname}?step=${encodeURIComponent(stepId)}`;
}

function showSnapshots(step) {
  const before = document.getElementById("snapshot-before");
  const after = document.getElementById("snapshot-after");
  const afterMeta = document.getElementById("snapshot-after-meta");
  const unavailable = document.getElementById("snapshot-unavailable");
  unavailable.hidden = true;
  before.removeAttribute("src");
  after.removeAttribute("src");
  afterMeta.textContent = "";
  const pair = step.snapshots;
  if (!pair || (!pair.before && !pair.after)) {
    unavailable.textContent =
      "No dispatch-time snapshot pair for this step (non-display action or refusal before capture).";
    unavailable.hidden = false;
    return;
  }
  if (pair.before) {
    before.src = pair.before;
    before.onerror = () => { before.removeAttribute("src"); };
  }
  if (pair.after) {
    after.src = pair.after;
    afterMeta.textContent =
      (pair.declaredAfterIntervalMs !== undefined ? `+${pair.declaredAfterIntervalMs}ms ` : "") +
      (pair.groupId ? `group ${pair.groupId} ` : "");
    after.onerror = () => { after.removeAttribute("src"); };
  }
}

function showCheckpoint(step, seg, segMedia) {
  const img = document.getElementById("still-frame");
  const unavailable = document.getElementById("checkpoint-unavailable");
  const note = document.getElementById("checkpoint-note");
  img.hidden = true;
  unavailable.hidden = true;
  if (!seg || !segMedia) {
    note.textContent = "No segment associated with this step.";
    return;
  }
  if (segMedia.decode !== "playable") {
    note.textContent = "";
    unavailable.textContent =
      `Still-frame checkpoint unavailable: segment ${seg.segmentId} is damaged ` +
      `(${segMedia.decodeDiagnostic ?? "undecodable"}). No frame is fabricated for damaged media.`;
    unavailable.hidden = false;
    return;
  }
  // The precise still frame is a separately verified extraction served from
  // evidence/; the video element alone is not exact-frame evidence.
  const framePath = step.reviewPoint.stillFrame;
  if (!framePath) {
    note.textContent = `Review point media t=${step.reviewPoint.timeSeconds.toFixed(3)}s on ${seg.segmentId}; no verified still frame registered for this step.`;
    return;
  }
  note.textContent = `Registered frame at media t=${step.reviewPoint.timeSeconds.toFixed(3)}s (${seg.segmentId}).`;
  img.src = framePath;
  img.hidden = false;
  img.onerror = () => {
    img.hidden = true;
    unavailable.textContent = `Registered still frame ${framePath} failed to load — delivery issue, not a playback estimate.`;
    unavailable.hidden = false;
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

load();
