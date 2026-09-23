/**
 * SNAP-01/02/03 real remote proof: dispatch-time snapshot pairs on real GUI
 * events (TextEdit on RELAY_SSH_HOST), a sender-declared typing group, and
 * the missing-interval usage refusal.
 */
import { Relay, SshTransport } from "@wezzard/relay-driver-host-sdk";
import { requireTarget } from "./env.js";

const TARGET = requireTarget();
const PID = 86030;
const WINDOW = 5708;
const CUAD = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";

const relay = Relay.open("/tmp/relay-snap-proof-store");
relay.useTransport((o) => new SshTransport({ target: o.target }));
const session = await relay.start({ target: TARGET, taskId: "task-snap-proof" });
const SID = session.sessionId;
console.log("session:", SID);

// 1. Single event: click into the text document. Snapshot contract: agent
//    decides the dialog needs ~700ms to settle after the click.
const click = await session.exec(
  [CUAD, "call", "click", "--json", JSON.stringify({ pid: PID, window_id: WINDOW, x: 300, y: 200 })],
  { step: { id: "snap-click-doc", title: "Click into document", inputMode: "ordinary" },
    snapshots: { afterIntervalMs: 700 } },
);
console.log("click:", click.outcome.kind, JSON.stringify(click.outcome).slice(0, 160));

// 2. Sender-declared typing group: "hello" = h e l l o keystrokes. One pair
//    spans the group; each keystroke is its own journaled event.
const key = (k: string) => [CUAD, "call", "press_key", "--json", JSON.stringify({ pid: PID, window_id: WINDOW, key: k })];
const group = { groupId: "grp-hello" };
const h = await session.exec(key("h"), { step: { id: "type-h", title: "Type h", inputMode: "ordinary" }, snapshots: { group: { ...group, phase: "first" } } });
console.log("h:", h.outcome.kind);
const e = await session.exec(key("e"), { step: { id: "type-e", title: "Type e", inputMode: "ordinary" }, snapshots: { group: { ...group, phase: "member" } } });
console.log("e:", e.outcome.kind);
const llo = await session.exec(key("l"), { step: { id: "type-l1", title: "Type l", inputMode: "ordinary" }, snapshots: { group: { ...group, phase: "member" } } });
console.log("l1:", llo.outcome.kind);
const l2 = await session.exec(key("l"), { step: { id: "type-l2", title: "Type l", inputMode: "ordinary" }, snapshots: { group: { ...group, phase: "member" } } });
console.log("l2:", l2.outcome.kind);
const o = await session.exec(key("o"), { step: { id: "type-o", title: "Type o (group terminal)", inputMode: "ordinary" }, snapshots: { group: { ...group, phase: "last", afterIntervalMs: 900 } } });
console.log("o:", o.outcome.kind);

// 3. Missing-interval usage refusal: a click with snapshot intent but no
//    interval and no group — refused before dispatch.
const refused = await session.exec(
  [CUAD, "call", "click", "--json", JSON.stringify({ pid: PID, window_id: WINDOW, x: 300, y: 220 })],
  { step: { id: "snap-refusal", title: "Click without interval" }, snapshots: {} },
);
console.log("refusal:", JSON.stringify(refused.outcome).slice(0, 200));

// 4. One more ordinary single event after the group (document shows "hello").
const after = await session.exec(
  [CUAD, "call", "click", "--json", JSON.stringify({ pid: PID, window_id: WINDOW, x: 300, y: 210 })],
  { step: { id: "snap-after-group", title: "Click after typing", inputMode: "ordinary" },
    snapshots: { afterIntervalMs: 400 } },
);
console.log("after:", after.outcome.kind);

const execs = await relay.submissions.listExecutions(SID);
console.log("executions:", execs.length, "states:", execs.map((e2) => e2.state).join(","));
await session.close();
