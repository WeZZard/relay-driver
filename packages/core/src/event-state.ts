/**
 * Event-record lifecycle state machine (plan: "Action-record state machine").
 *
 * One action invocation moves through these evidence states:
 *
 *   pending    awaiting admission
 *   refused    not invoked (capture unavailable, route invalid)
 *   admitted   start retained durably, callable invoked once
 *   recorded   completion receipt retained (success or failure)
 *   uncertain  completion cannot be confirmed (process/transport lost)
 *   incomplete known result but completion receipt write failed
 *
 * `uncertain -> recorded` is allowed only by recovering an existing
 * completion record — never by replaying input.
 */

export type EventState =
  | "pending"
  | "refused"
  | "admitted"
  | "recorded"
  | "uncertain"
  | "incomplete";

/** Tool outcome, independent of evidence retention. */
export type ToolOutcome =
  | { readonly kind: "success"; readonly value?: unknown }
  | { readonly kind: "failure"; readonly error?: unknown }
  | { readonly kind: "unknown" };

/** Evidence retention status, independent of tool outcome (D17). */
export type EvidenceStatus =
  | "retained"
  | "failed"
  | "unconfirmed"
  | "not-applicable"; // refused: no start was retained

/** Legal transitions. Recovery (`uncertain -> recorded`) is evidence-only. */
const TRANSITIONS: Readonly<Record<EventState, readonly EventState[]>> = {
  pending: ["refused", "incomplete", "admitted"],
  refused: [],
  admitted: ["recorded", "uncertain", "incomplete"],
  recorded: [],
  uncertain: ["recorded"],
  incomplete: [],
};

export function canTransition(from: EventState, to: EventState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: EventState, to: EventState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal event-state transition: ${from} -> ${to}`);
  }
}

/** Whether the event still admits further trajectory input. */
export function inputEnabled(state: EventState): boolean {
  // An admitted (in-flight) or terminal event does not itself disable input;
  // evidence failure and capture loss are separate, runtime-level gates.
  return state === "pending" || state === "admitted" || state === "recorded";
}
