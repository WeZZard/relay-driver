# Review surfaces

The local viewer presents a delivered walkthrough package. [D8](../decisions.md#review-and-delivery) defines the navigation requirements; concrete URL syntax remains an implementation choice.

```text
Walkthrough package
├── Overview
│   ├── Recording completeness
│   ├── Execution outcome
│   └── Human review status
├── Step review
│   ├── Recording and current explanation
│   ├── Previous / next step
│   ├── Attempt and segment selection
│   └── Stable step link
├── Evidence inspection
│   ├── Verified frame checkpoint
│   ├── Supporting logs or assertions
│   └── Original recording or identified derivative
└── Human review
    └── Judgment tied to the reviewed evidence
```

Selecting a step identifies the relevant attempt, recording segment, and explanation together. A link must not silently substitute a later successful attempt for the evidence originally referenced.

- [Wireframes](wireframes.md) defines the screen structure and visible states.
- [Review flow](review-flow.md) defines the sequence from opening a package to recording a judgment.
