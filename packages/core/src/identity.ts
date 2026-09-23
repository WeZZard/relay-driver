/**
 * Identity allocation for Relay Driver records.
 *
 * Every record (task, session, attempt, step, execution, action event,
 * recording segment) carries a durable identity. Identities are allocated
 * before submission so a lost transport never requires replaying input to
 * discover what happened (D14). This module defines identity shape and
 * deterministic allocation; persistence belongs to the store using it.
 */

/** Distinguishable record kinds; identities are namespaced by kind. */
export type RecordKind =
  | "session"
  | "attempt"
  | "step"
  | "execution"
  | "action"
  | "segment"
  | "observation"
  | "annotation"
  | "artifact";

/** A record identity: kind plus a unique, sortable suffix. */
export interface RecordId {
  readonly kind: RecordKind;
  readonly suffix: string;
}

const SUFFIX_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Allocate a unique suffix. Time-ordered (lexicographic sort approximates
 * creation order) with randomness to stay unique across processes.
 */
export function allocateSuffix(now: number = Date.now(), random = Math.random): string {
  const time = now.toString(36).padStart(9, "0");
  let rand = "";
  for (let i = 0; i < 8; i++) {
    rand += SUFFIX_ALPHABET[Math.floor(random() * SUFFIX_ALPHABET.length)];
  }
  return `${time}${rand}`;
}

export function allocateId(kind: RecordKind, now: number = Date.now(), random = Math.random): RecordId {
  return { kind, suffix: allocateSuffix(now, random) };
}

/** Canonical string form: `<kind>-<suffix>`, e.g. `action-01j9x7k2ab3c`. */
export function formatId(id: RecordId): string {
  return `${id.kind}-${id.suffix}`;
}

/** Parse the canonical string form; returns undefined on malformed input. */
export function parseId(text: string, expected?: RecordKind): RecordId | undefined {
  const separator = text.indexOf("-");
  if (separator <= 0) return undefined;
  const kind = text.slice(0, separator) as RecordKind;
  const suffix = text.slice(separator + 1);
  if (!suffix) return undefined;
  if (expected !== undefined && kind !== expected) return undefined;
  return { kind, suffix };
}
