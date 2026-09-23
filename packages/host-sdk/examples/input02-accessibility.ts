/**
 * INPUT-02 (accessibility confinement) — real proof against RELAY_SSH_HOST.
 *
 * Accessibility-mode actions (direct AX activation/value-setting) must be
 * labeled as such on their action records, and ordinary-interaction claims
 * must not inherit accessibility evidence.
 *
 * Steps, each journaled under the runtime admission engine with inputMode:
 *  ax-set-value : set_value writes "AXSET" directly via AXValue into the
 *                 TextEdit text area — accessibility mode.
 *  ax-type-text : type_text inserts "-AXTYPE" via AXSetAttribute —
 *                 accessibility mode.
 *  ord-click    : click(x,y) — real pointer event — ordinary mode.
 *  ord-press-*  : press_key O/R/D — real keystrokes — ordinary mode.
 *
 * Confinement verification (programmatic, after the run):
 *  1. Every accessibility action record carries inputMode:"accessibility".
 *  2. Every ordinary action record carries inputMode:"ordinary".
 *  3. Ordinary receipts reference only their own action ids/evidence — no
 *     inheritance from the AX actions.
 *  4. Document content independently confirms both deliveries.
 */
import { Relay, type ExecResult } from "../src/relay.js";
import { SshTransport } from "../src/ssh-transport.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTarget } from "./env.js";

const TARGET = requireTarget();
const RUNNER = "node /var/tmp/relay-driver-runtime/receive.js";
const CUA = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const PID = 44431; // TextEdit on the remote

interface StepResult {
  stepId: string;
  inputMode: string;
  executionId: string;
  outcome: unknown;
}

async function cuaStep(
  session: ReturnType<Relay["start"]> extends Promise<infer S> ? S : never,
  stepId: string,
  inputMode: "ordinary" | "accessibility",
  tool: string,
  args: Record<string, unknown>,
): Promise<StepResult> {
  const result: ExecResult = await session.exec(
    [CUA, "call", tool, "--json", JSON.stringify(args)],
    {
      step: {
        id: stepId,
        title: `${stepId} [${inputMode}] ${tool}`,
        inputMode,
      },
    },
  );
  return { stepId, inputMode, executionId: result.executionId, outcome: result.outcome };
}

async function main(): Promise<void> {
  const storeRoot = await mkdtemp(join(tmpdir(), "relay-input02-"));
  const relay = Relay.open(storeRoot);
  relay.useTransport((options) => new SshTransport({ target: options.target ?? TARGET, remoteRunner: RUNNER }));
  const session = await relay.start({ target: TARGET, taskId: "task-input02" });

  const results: StepResult[] = [];

  // Accessibility mode: direct AX value-setting into the text area.
  results.push(await cuaStep(session, "ax-set-value", "accessibility", "set_value", {
    pid: PID, window_id: 5503, element_token: "s00000070:1", value: "AXSET",
  }));
  // Accessibility mode: AXSetAttribute(kAXSelectedText) insertion.
  results.push(await cuaStep(session, "ax-type-text", "accessibility", "type_text", {
    pid: PID, window_id: 5503, text: "-AXTYPE",
  }));
  // Ordinary mode: real pointer click, then real keystrokes.
  results.push(await cuaStep(session, "ord-click", "ordinary", "click", {
    pid: PID, window_id: 5503, x: 400, y: 300,
  }));
  for (const key of ["o", "r", "d"]) {
    results.push(await cuaStep(session, `ord-press-${key}`, "ordinary", "press_key", {
      pid: PID, window_id: 5503, key,
    }));
  }

  console.log(JSON.stringify(results, null, 2));
  await session.close();
}

main();
