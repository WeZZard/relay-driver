/**
 * Damaged-original relabel check (D18): a "damaged" original that actually
 * decodes means the source state was mislabeled — acceptance must fail even
 * when the bytes match the manifest.
 */
import { verifyPackage } from "../src/index.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

async function main(): Promise<void> {
  const root = "/tmp/relay-stage4-mislabel";
  const manifest = JSON.parse(await readFile(`${root}/manifest.json`, "utf8"));
  // The mislabeled file now decodes; align integrity facts so ONLY the
  // decode-flag rule is under test.
  const bytes = await readFile(`${root}/media/segment-attempt1-damaged.mp4`);
  manifest.media[0].sha256 = createHash("sha256").update(bytes).digest("hex");
  manifest.media[0].bytes = bytes.length;
  const r = await verifyPackage(manifest, root);
  console.log("mislabeled accepted:", r.accepted);
  for (const f of r.findings) console.log(`[${f.code}] ${f.detail.slice(0, 90)}`);
  if (r.accepted) process.exit(1);
}
main();
