# User stories — index

[Maintenance rules](CLAUDE.md) govern this index. [User profiles](../user-profiles.md) define the participants. The [verification catalog](../engineering/verification.md) defines the required evidence contracts.

| ID | Profile | Story | Verification |
| --- | --- | --- | --- |
| US-1 | [Walkthrough operator](walkthrough-operator.md#us-1-record-ordinary-input) | Record ordinary input through existing tools. | INPUT-01, EXECUTION-01 |
| US-2 | [Walkthrough operator](walkthrough-operator.md#us-2-retain-generated-script-actions) | Retain the actions performed by generated scripts. | SCRIPT-01, EXECUTION-01 |
| US-3 | [Walkthrough operator](walkthrough-operator.md#us-3-correlate-actions-and-observations) | Correlate actions and observations with the recording. | TIME-01, TIME-02, EXECUTION-01 |
| US-4 | [Walkthrough operator](walkthrough-operator.md#us-4-preserve-an-interrupted-attempt) | Preserve an interrupted attempt and stop unrecorded input. | CAPTURE-01 |
| US-5 | [Walkthrough operator](walkthrough-operator.md#us-5-export-before-environment-cleanup) | Export verified evidence before environment cleanup. | EXPORT-01 |
| US-6 | [Walkthrough operator](walkthrough-operator.md#us-6-identify-accessibility-tests) | Identify accessibility actions when that behavior is under test. | INPUT-02 |
| US-7 | [Reviewer](reviewer.md#us-7-jump-to-the-behavior-under-review) | Jump directly to the behavior under review. | REVIEW-01 |
| US-8 | [Reviewer](reviewer.md#us-8-inspect-the-evidence-behind-a-claim) | Inspect the evidence behind an observed-result claim. | EVIDENCE-01, TIME-02 |
| US-9 | [Reviewer](reviewer.md#us-9-distinguish-failures-retries-and-approval) | Distinguish failed attempts, retries, and human approval. | REVIEW-02 |
