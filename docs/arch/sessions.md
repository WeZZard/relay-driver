# Walkthrough sessions

## Responsibility

A session groups the work performed under an inherited task identity. It owns the association between steps, attempts, recording segments, events, and the final review package. Environment allocation remains outside this subsystem under [D2](../decisions.md#execution).

## Lifecycle operations

These names describe responsibilities; they do not freeze an API or command spelling.

| Operation | Responsibility |
| --- | --- |
| Start | Bind the task identity, establish capture and time correlation, and report readiness. |
| Attach and inspect | Recover an existing session or execution through its durable identity, including incomplete startup, without replaying input. |
| Step | Declare a title, intent, and expected result without implying execution. |
| Act | Dispatch an operation and retain its event receipt. |
| Observe | Retain evidence with its source and time or recorded-frame reference. |
| Annotate | Attach an explanation to existing events or observations. |
| Continue | Explicitly finalize an interrupted attempt, create a related attempt, establish capture and clock mapping, then report readiness through recoverable phases. |
| Finish | Close the session's capture and produce a package for host validation; attempt finalization alone does not close the session. |

The session admits walkthrough input only while recording is active. Recording loss leaves the current attempt incomplete and prevents further input until a new recorded segment is ready. Finishing capture is distinct from the host accepting the exported package.

## Recovery and continuation

Under [D14 and D16](../decisions.md#developer-interfaces), SDK/CLI submission identities survive host replacement, and the remote task exposes session/execution discovery and status. A startup failure after resource acquisition retains a discoverable identity, diagnostic, and finalization path. Reattachment reads the existing attempt; it does not create a continuation or resubmit an uncertain action.

A continuation is explicit. Its recoverable phases preserve the interrupted attempt, create a related attempt and segment, establish fresh time correlation, and admit input only after readiness. Old attempt handles remain refused. A continuation cannot resume an arbitrary script stack or claim an uncertain earlier action succeeded.

## Step boundaries

A step describes a user-visible intention and can include several backend operations. Each operation still retains its own receipt. The step can span a native panel and a browser without merging their individual evidence.

## Attempts and ownership

- Each attempt identifies its recording segments and preserves its outcome.
- A retry or continuation references the earlier attempt without replacing it.
- Session, attempt, and step identities disambiguate events from different callers.
- Input and display-sharing constraints follow the [execution environment design](../engineering/environments.md#display-ownership).
- After the host accepts the package, the governing environment workflow may clean up without waiting for human review.
