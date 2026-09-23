# Review viewer wireframes

These wireframes describe structure and information hierarchy. They do not prescribe a visual theme, frontend framework, or fixed route syntax.

## Walkthrough review

```text
┌────────────────────────────────────────────────────────────────────────┐
│ Walkthrough title                  Attempt selector   Copy step link   │
│ Recording: Complete     Execution: Failed     Human review: Pending    │
├─────────────────────────────────────────┬──────────────────────────────┤
│                                         │ Steps                        │
│                                         │  1. Open the card            │
│              Recorded display           │ >2. Increase padding         │
│                                         │  3. Check saving             │
│                                         ├──────────────────────────────┤
│                                         │ Action                       │
│                                         │ Expected result              │
│                                         │ Observed result              │
│                                         │ Evidence links               │
├─────────────────────────────────────────┴──────────────────────────────┤
│ Play / Pause    Media timeline    Previous step    Next step            │
│ Review point: inspect frame             Human judgment and notes       │
└────────────────────────────────────────────────────────────────────────┘
```

The labels above illustrate independent outcomes, not a completed evaluation. The video remains readable beside the explanation. A reviewer can inspect a referenced frame without losing the selected step.

## Visible states

| Condition | Presentation |
| --- | --- |
| A step is selected | Seek before its input and show its action, expectation, and observation. |
| Playback enters another step | Highlight the explanation corresponding to the presented media time. |
| An observation has timing uncertainty | Show the established interval and its supporting evidence. |
| A precise checkpoint is selected | Show the verified recorded frame and its media timestamp. |
| A required artifact is missing or invalid | Identify the affected evidence and the package-validation failure. |
| Recording was interrupted | Mark the attempt incomplete and expose the interruption and any continuation separately. |
| A direct accessibility action was tested | Identify the accessibility interaction mode next to the action. |
| Human review has not occurred | Keep human review pending even when execution passed. |

The viewer must not imply that its seek landed on an exact frame merely because it requested that time. [Playback synchronization](../engineering/capture-and-timing.md#playback-synchronization) defines the implementation limit.
