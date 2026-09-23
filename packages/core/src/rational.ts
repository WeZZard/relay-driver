/**
 * Rational timestamps for clock mapping and playback normalization.
 *
 * Contracts (docs/engineering/capture-and-timing.md, docs/arch/timeline.md):
 * - Preserve rational timestamps internally; decimal seconds are presentation.
 * - Playback time = encoded PTS minus the first captured frame's encoded PTS.
 * - Never infer time from frame count / assumed frame rate.
 * - Mapping uncertainty is a separate quantity from observation intervals.
 */

/** A rational number value/timescale, exactly representable. */
export interface Rational {
  readonly value: bigint;
  readonly timescale: number; // units per second, > 0
}

export function rational(value: bigint | number, timescale: number): Rational {
  if (!Number.isInteger(timescale) || timescale <= 0) {
    throw new Error(`timescale must be a positive integer, got ${timescale}`);
  }
  return { value: BigInt(value), timescale };
}

/** Convert to a decimal-seconds presentation value. */
export function toSeconds(r: Rational): number {
  return Number(r.value) / r.timescale;
}

/** Require a common timescale before exact arithmetic. */
function rescale(r: Rational, timescale: number): bigint {
  if (r.timescale === timescale) return r.value;
  // Exact rescale only when the ratio is integral; otherwise callers must
  // keep rationals in their native timescales and convert deliberately.
  const factor = timescale / r.timescale;
  if (!Number.isInteger(factor)) {
    throw new Error(
      `cannot exactly rescale ${r.value}/${r.timescale} to timescale ${timescale}`,
    );
  }
  return r.value * BigInt(factor);
}

export function subtract(a: Rational, b: Rational): Rational {
  const timescale = a.timescale >= b.timescale ? a.timescale : b.timescale;
  return {
    value: rescale(a, timescale) - rescale(b, timescale),
    timescale,
  };
}

export function add(a: Rational, b: Rational): Rational {
  const timescale = a.timescale >= b.timescale ? a.timescale : b.timescale;
  return {
    value: rescale(a, timescale) + rescale(b, timescale),
    timescale,
  };
}

export function compare(a: Rational, b: Rational): number {
  const timescale = a.timescale >= b.timescale ? a.timescale : b.timescale;
  const av = rescale(a, timescale);
  const bv = rescale(b, timescale);
  return av === bv ? 0 : av < bv ? -1 : 1;
}

/**
 * Normalize a mapped event time to playback time on a segment:
 * playback = encoded PTS - firstFramePTS. Returns a playback-time Rational
 * on the segment's timescale; negative results indicate a mapping error the
 * caller must surface, not clamp.
 */
export function playbackTime(encodedPTS: Rational, firstFramePTS: Rational): Rational {
  if (encodedPTS.timescale !== firstFramePTS.timescale) {
    throw new Error("encoded PTS and first-frame PTS must share a timescale");
  }
  return { value: encodedPTS.value - firstFramePTS.value, timescale: encodedPTS.timescale };
}
