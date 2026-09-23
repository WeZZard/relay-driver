import { Relay } from "../src/relay.js";
import { SshTransport } from "../src/ssh-transport.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTarget } from "./env.js";

const TARGET = requireTarget();
const RUNNER = "node /var/tmp/relay-driver-runtime/receive.js";

async function main(): Promise<void> {
  const storeRoot = await mkdtemp(join(tmpdir(), "relay-exec01-"));
  const relay = Relay.open(storeRoot);
  relay.useTransport((o) => new SshTransport({ target: o.target ?? TARGET, remoteRunner: RUNNER }));
  const session = await relay.start({ target: TARGET, taskId: "task-exec01" });

  // Streamed JavaScript — no upload round-trip.
  const js = await session.runCode(
    `process.stdout.write("streamed-js-ok:" + (6 * 7));\n`,
    "javascript",
    { step: { id: "streamed-js", title: "streamed JS multiplication" } },
  );
  console.log("JS:", js.outcome.kind, JSON.stringify(js.outcome).slice(0, 220));

  // Streamed TypeScript — executed via tsx.
  const ts = await session.runCode(
    `const m: Map<string, number> = new Map([["answer", 42]]);\nprocess.stdout.write("streamed-ts-ok:" + m.get("answer"));\n`,
    "typescript",
    { step: { id: "streamed-ts", title: "streamed TS map" } },
  );
  console.log("TS:", ts.outcome.kind, JSON.stringify(ts.outcome).slice(0, 220));

  // Streamed Python.
  const py = await session.runCode(
    `print("streamed-py-ok:" + str(2 ** 10))\n`,
    "python",
    { step: { id: "streamed-py", title: "streamed Python power" } },
  );
  console.log("PY:", py.outcome.kind, JSON.stringify(py.outcome).slice(0, 220));

  // Hash-mismatch refusal: declared hash lies about the bytes.
  const { createHash } = await import("node:crypto");
  const code = `process.stdout.write("tampered")\n`;
  const wrongHash = createHash("sha256").update(code + "x", "utf8").digest("hex");
  const bad = await session.runCodeWithHash(code, wrongHash, "javascript", { step: { id: "streamed-bad", title: "hash mismatch refusal" } });
  console.log("BAD:", bad.outcome.kind, JSON.stringify(bad.outcome).slice(0, 220));

  await session.close();
}
main();
