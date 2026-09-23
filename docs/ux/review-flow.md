# Review flow

## Open the package

The reviewer opens the delivered package using its local instructions. The overview identifies the trajectory and keeps recording completeness, execution outcome, and human review status separately readable. The original execution environment is not needed.

## Select a step

1. Select the user-visible action to inspect.
2. Resolve its attempt and recording segment.
3. Seek slightly before the action to preserve context.
4. Read the action and expected result beside the video.
5. Follow the corresponding observation and evidence when playback reaches them.

Previous/next navigation and stable links preserve the same step identities. Retry selection changes the displayed attempt explicitly.

## Inspect the result

A visual result references recorded footage or a verified frame. A log or file assertion opens as supporting evidence with its source identified. The viewer retains an uncertainty interval when the exact first visible occurrence has not been established.

An optional pause at a review point helps the reviewer inspect the result. The verified frame remains available when ordinary browser seeking cannot select that exact frame.

## Inspect unavailable footage

A step whose original recording cannot play remains selectable. Show the incomplete coverage and decode diagnostic, offer the retained original as evidence, and expose its related continuation without seeking to invented footage. Delivery integrity and playback failure remain separately readable under the [review-package contract](../arch/review-package.md#artifact-states).

## Supply human review

The reviewer records a judgment tied to the inspected evidence. That judgment is separate from the agent's explanation and execution verdict. Adding a later attempt does not silently transfer approval to different evidence.

The [human-review runbook](../ops/human-review.md) describes the operator procedure; the [review-package contract](../arch/review-package.md) defines the underlying outcome distinctions.
