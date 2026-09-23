# Recording timeline

## Responsibility

Relate execution events and observations to the actual media timeline while preserving uncertainty. [D5](../decisions.md#evidence) makes the first captured frame playback zero and keeps UTC as separate provenance.

## Distinct moments

1. The agent declares an intention.
2. The driver submits input.
3. The driver completes its operation.
4. An observation establishes an application state.
5. A recorded frame visibly establishes that state.

These moments can differ. The timeline must retain those distinctions instead of using one timestamp for the whole step.

## Correlation and uncertainty

Execution timestamps and recorded frame timestamps retain their verified mapping into each written media segment. Recorder process launch time does not establish the first frame's time. A callback's arrival time does not necessarily establish the time of the frame it delivers.

If one inspection shows a state absent and the next shows it present, the evidence establishes an interval. Narrow it only with intervening evidence. Additional decimal places do not increase observational precision.

An exact visual review point references an actual recorded frame. An interval or nonvisual observation must not silently become a claim about the first visible occurrence.

## Segments and derivatives

- Every recording restart begins a new segment and a new time mapping.
- Preserve gaps, capture failures, and timing uncertainty across segments.
- Retain the source and timeline mapping of each playback derivative or excerpt.
- Do not infer timestamps from frame count divided by an assumed frame rate.
- Keep [clock conversion and encoding mechanisms](../engineering/capture-and-timing.md) separate from this behavioral contract.
