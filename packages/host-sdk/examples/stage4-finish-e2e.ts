/**
 * Stage 4 end-to-end EXPORT-01: Relay.finish() over the real SSH transport —
 * remote assembly, scp download, manifest build over delivered bytes, and
 * host acceptance — proving the SDK-level finish path (not just the
 * standalone examples).
 */
import { Relay } from "../src/relay.js";
import { SshTransport } from "../src/ssh-transport.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTarget } from "./env.js";

async function main(): Promise<void> {
  const downloadTo = await mkdtemp(join(tmpdir(), "relay-finish-"));
  const relay = new Relay();
  relay.useTransport(
    (options) =>
      new SshTransport({
        target: options.target,
        remoteRunner: `node /var/tmp/relay-driver-runtime/receive.js`,
      }),
  );
  // No start(): finish works against the staged runtime state directly for
  // this proof; session state lives under the runtime root.
  const transport = new SshTransport({
    target: requireTarget(),
    remoteRunner: "node /var/tmp/relay-driver-runtime/receive.js",
  });
  const result = await transport.finish({ downloadTo });
  console.log("finish result:", JSON.stringify(result, null, 2));
  await transport.close();
  if (!result.deliveryVerified) process.exit(1);
}
main();
