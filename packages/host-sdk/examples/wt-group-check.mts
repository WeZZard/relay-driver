import { buildWalkthrough } from "@wezzard/relay-driver-host-sdk";
import { writeFile } from "node:fs/promises";
const wt = await buildWalkthrough("/tmp/relay-snap-download");
await writeFile("/tmp/relay-snap-download/walkthrough.json", JSON.stringify(wt, null, 2));
for (const s of wt.steps) {
  console.log(s.id, "|", s.execution, "|", JSON.stringify(s.snapshots));
}
