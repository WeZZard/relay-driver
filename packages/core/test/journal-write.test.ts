/**
 * Journal append completeness (D26).
 *
 * A file write may write fewer bytes than asked (for example on a nearly
 * full disk). The journal must then keep writing the rest of the line, and
 * a write that makes no progress must surface as an error rather than leave
 * a silently torn record that later readers report as a damaged tail.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JournalWriter, readJournal } from "../src/index.js";

type WriteResult = { bytesWritten: number; buffer: unknown };

/**
 * Replace the writer's file handle with one that writes at most `maxBytes`
 * per call to the real file. Handles both FileHandle.write overloads.
 */
function limitWrites(writer: JournalWriter, maxBytes: number): void {
  const internals = writer as unknown as { handle: FileHandle };
  const real = internals.handle;
  const fake = {
    async write(data: string | Uint8Array, a?: unknown, b?: unknown): Promise<WriteResult> {
      let buf: Buffer;
      let offset: number;
      let length: number;
      if (typeof data === "string") {
        buf = Buffer.from(data, (typeof b === "string" ? b : "utf8") as BufferEncoding);
        offset = 0;
        length = buf.length;
      } else {
        buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        offset = typeof a === "number" ? a : 0;
        length = typeof b === "number" ? b : buf.length - offset;
      }
      const n = Math.min(length, maxBytes);
      if (n > 0) await real.write(buf, offset, n, null);
      return { bytesWritten: n, buffer: data };
    },
    sync: () => real.sync(),
    close: () => real.close(),
  };
  internals.handle = fake as unknown as FileHandle;
}

test("a short write does not tear the journal line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-journal-short-"));
  const path = join(dir, "events.jsonl");
  const writer = await JournalWriter.create(path);
  limitWrites(writer, 7);
  await writer.append({ kind: "action-start", actionId: "action-a", state: "admitted" }, { durable: true });
  await writer.append({ kind: "action-completion", actionId: "action-a", state: "recorded" });
  await writer.close();

  const { records, damagedTail } = await readJournal(path);
  assert.equal(damagedTail, undefined, `journal line was torn: ${damagedTail}`);
  assert.deepEqual(records.map((r) => r.kind), ["action-start", "action-completion"]);
});

test("a write that makes no progress is reported as an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-journal-stall-"));
  const path = join(dir, "events.jsonl");
  const writer = await JournalWriter.create(path);
  limitWrites(writer, 0);
  await assert.rejects(
    writer.append({ kind: "action-start", actionId: "action-b", state: "admitted" }),
    /journal write made no progress/,
  );
  await writer.close();
});
