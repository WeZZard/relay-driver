import { Relay, SshTransport } from "@wezzard/relay-driver-host-sdk";
import { requireTarget } from "./env.js";
const relay = Relay.open("/tmp/relay-snap-refusal-store");
relay.useTransport((o) => new SshTransport({ target: o.target }));
const session = await relay.start({ target: requireTarget(), taskId: "task-snap-refusal" });
const r = await session.exec(["/bin/echo", "should-never-run"], {
  step: { id: "refused-step", title: "Click while capture down", inputMode: "ordinary" },
  snapshots: { afterIntervalMs: 200 },
});
console.log("outcome:", JSON.stringify(r.outcome).slice(0, 180));
await session.close();
