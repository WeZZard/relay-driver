# Review package

## Responsibility

Deliver the original evidence and its review structure in a package that remains usable after the execution environment is gone. [D8 and D9](../decisions.md#review-and-delivery) define the local viewer and handoff requirements.

## Review structure

The package groups immutable events and recordings into navigable steps. A step references its action interval, observation interval or review point, expected result, observed result, outcome, and supporting evidence.

Retry and continuation boundaries remain visible. A browser-compatible recording or excerpt identifies the original media and its mapping. Narrative edits do not alter the original evidence.

## Artifact states

Under [D18](../decisions.md#review-and-delivery), the single package retains damaged originals and their diagnostics beside playable continuations. Artifact integrity, decodability, and recording completeness are separate properties. A damaged segment remains visible as unavailable footage; its original bytes can be inspected/downloaded but cannot supply visual evidence. The [artifact acceptance contract](../engineering/artifact-format.md#host-acceptance) defines how such a delivery is verified.

Since the snapshot-evidence decision ([D20](../decisions.md#evidence-snapshot-era)), the package's primary visual evidence is the dispatch-time snapshot pairs (`snapshots/`, provenance `dispatch-captured`), and video enters only as **application-supplied attachments** ([D24](../decisions.md#evidence-snapshot-era)): Relay verifies attachment bytes but never interprets their meaning — a walkthrough application attaches recording segments there when its doctrine demands continuous footage.

## Independent outcomes

| Outcome | Question answered |
| --- | --- |
| Recording completeness | Does the capture cover the required interaction and observable result? |
| Execution outcome | What did the operation or test establish? |
| Human review status | Has a person supplied a judgment about this evidence? |

Human review remains pending until supplied by the reviewer. An agent's pass verdict cannot approve the walkthrough on the person's behalf.

## Handoff boundary

The host accepts the exported package only after verifying its artifacts and references. Accepted export permits the environment workflow to proceed with cleanup; human review happens independently. A failed transfer does not justify deleting the only retained evidence.

The [artifact format](../engineering/artifact-format.md) defines packaging mechanics. The [review flow](../ux/review-flow.md) defines how a person navigates the delivered evidence.
