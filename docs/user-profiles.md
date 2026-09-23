# User profiles

Profiles describe responsibilities. One person can operate a walkthrough and later review it. Recording state, test outcome, permission state, and review status are reversible conditions; they do not define additional profiles.

```text
Walkthrough participants
├── Walkthrough operator
└── Reviewer
```

## Walkthrough operator

The operator directs the test and delivers its evidence. An agent can carry out this responsibility on the person's behalf through tool calls or generated scripts.

- Declares the interaction intent and expected result.
- Operates the existing execution tools within the assigned environment.
- Observes outcomes and attaches explanations to recorded evidence.
- Preserves failures and exports the package before relinquishing the environment.

## Reviewer

The reviewer inspects the delivered behavior and records a human judgment. The reviewer can use the package after the remote computer or VM session has ended.

- Navigates directly to the behavior being judged.
- Compares the expected result with recorded observations and supporting evidence.
- Distinguishes an agent's verdict from the reviewer's own approval or rejection.
