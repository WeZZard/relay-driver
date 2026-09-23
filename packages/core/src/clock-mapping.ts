/**
 * Verified clock mapping between the event clock and a recording segment's
 * encoded presentation timestamps.
 *
 * Contract (docs/engineering/capture-and-timing.md):
 * - The mapping must be verified against the recorder and encoded output
 *   before it is accepted as precise; an unverified mapping is not evidence.
 * - Recorder launch time does not establish the first frame's time.
 * - Mapping uncertainty is retained, separate from observation intervals.
 */

import type { Rational } from "./rational.js";

/** Identity of the remote clock a measured interval came from. */
export interface ClockIdentity {
  /** e.g. "mach-absolute", "screencapturekit-sync", "cmclock-host". */
  readonly name: string;
  /** How correlation to this clock was established. */
  readonly correlationEvidence: string;
}

/**
 * A verified conversion from one clock to a segment's encoded timeline.
 * `verify()` evidence (measured offsets against known frames) lives outside
 * this type; constructing one asserts that verification happened.
 */
export interface ClockMapping {
  readonly eventClock: ClockIdentity;
  readonly segmentId: string;
  /** Encoded PTS of the segment's first captured frame (playback zero). */
  readonly firstFramePTS: Rational;
  /** Measured uncertainty of the conversion, in the segment's timescale. */
  readonly uncertainty: Rational;
  /** Reference to the evidence record that verified this mapping. */
  readonly evidenceId: string;
}

export interface MappedTime {
  readonly encodedPTS: Rational;
  readonly uncertainty: Rational;
  readonly mappingEvidenceId: string;
}

/** Convert an event-clock reading into encoded PTS using a verified mapping. */
export function toEncodedPTS(
  mapping: ClockMapping,
  eventClockTime: Rational,
): MappedTime {
  // A linear identity conversion is only valid when both clocks are the same
  // timebase; real conversions come from measured recorder experiments
  // (Stage 1) and are injected here as calibrated mappings.
  if (mapping.eventClock.name !== "segment-encoded") {
    throw new Error(
      `no calibrated conversion for clock ${mapping.eventClock.name}; ` +
        "record the measured mapping during Stage 1 before using this mapping",
    );
  }
  return {
    encodedPTS: eventClockTime,
    uncertainty: mapping.uncertainty,
    mappingEvidenceId: mapping.evidenceId,
  };
}
