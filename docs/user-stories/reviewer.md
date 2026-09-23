# Reviewer stories

## US-7 Jump to the behavior under review

As a reviewer, I want to select a meaningful step beside the video, so that I can inspect the behavior without searching a MOV file for a prose timestamp.

- Selecting a step seeks before its action with enough context to understand it.
- Playback highlights the corresponding explanation.
- Previous/next controls and stable step links support navigation.
- A precise checkpoint provides its verified still frame.

## US-8 Inspect the evidence behind a claim

As a reviewer, I want each claimed result linked to its evidence, so that I can distinguish what the screen shows from what other checks establish.

- The action, expected result, and observed result remain separately readable.
- Visual observations reference the recording; logs and file assertions identify their own source.
- Missing evidence and timing uncertainty remain visible.

## US-9 Distinguish failures, retries, and approval

As a reviewer, I want original attempts and independent outcomes preserved, so that a later retry or agent verdict cannot obscure what I am approving.

- Retries, continuations, and incomplete recordings retain their identities.
- Recording completeness, execution outcome, and human review status are shown separately.
- Human review remains pending until a person supplies it.
