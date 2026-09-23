import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allocateId,
  formatId,
  parseId,
  assertTransition,
  rational,
  playbackTime,
  subtract,
  JournalWriter,
  readJournal,
} from "../src/index.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("identity round-trips and is unique", () => {
  const a = allocateId("action", 1_000_000, () => 0.5);
  const b = allocateId("action", 1_000_000, () => 0.9);
  assert.notEqual(formatId(a), formatId(b));
  const parsed = parseId(formatId(a), "action");
  assert.equal(parsed?.kind, "action");
  assert.equal(parseId("bogus"), undefined);
  assert.equal(parseId(formatId(a), "segment"), undefined);
});

test("event state machine refuses replay-shaped transitions", () => {
  assertTransition("pending", "admitted");
  assertTransition("admitted", "recorded");
  assertTransition("uncertain", "recorded"); // recovery, evidence-only
  assert.throws(() => assertTransition("recorded", "admitted"));
  assert.throws(() => assertTransition("uncertain", "admitted"));
});

test("playback time subtracts the first-frame PTS exactly", () => {
  // Plan example: first frame at 72000/6000, drag start 112320/6000 => 6.72 s.
  const first = rational(72000n, 6000);
  const drag = rational(112320n, 6000);
  const playback = playbackTime(drag, first);
  assert.equal(playback.value, 40320n);
  assert.equal(playback.timescale, 6000);
  assert.ok(subtract(playback, rational(0, 6000)).value === 40320n);
});

test("journal appends durably, reads damaged tails, never throws on torn lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-journal-"));
  const path = join(dir, "events.jsonl");
  const writer = await JournalWriter.create(path);
  const start = await writer.append(
    { kind: "action-start", actionId: "action-a", state: "admitted" },
    { durable: true },
  );
  assert.equal(start.seq, 0);
  await writer.append({ kind: "action-completion", actionId: "action-a", state: "recorded" });
  await writer.close();

  // Simulate a torn final write.
  const fs = await import("node:fs/promises");
  await fs.appendFile(path, '{"kind":"action-start","acti');

  const { records, damagedTail } = await readJournal(path);
  assert.equal(records.length, 2);
  assert.equal(records[0].kind, "action-start");
  assert.equal(records[1].state, "recorded");
  assert.ok(damagedTail?.includes("action-start"));
});
