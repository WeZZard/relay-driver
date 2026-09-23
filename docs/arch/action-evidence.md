# Action and observation evidence

## Responsibility

Retain what was requested, what the execution tool performed, and what the evidence establishes. The [record relationships](data-schema.md) keep these facts separate from the explanatory annotations derived from them.

## Action receipts

An action receipt retains the original backend operation and result alongside the common fields used for review.

- Identify the task, session, step, attempt, event, and recording segment.
- Identify the backend, operation, target, and target-discovery method.
- Identify the actual input-delivery method.
- Retain the measured operation interval, any observed input-dispatch interval, and the tool's execution result.
- Reference associated observations and capture errors.

Origin metadata remains extensible and records the actual tool, library, or command when known. It does not select a built-in driver type. Record the observed boundary and its clock source explicitly; an outer callback or process interval is not automatically an input-dispatch interval.

A completed tool operation establishes only what that tool completed. It does not automatically establish a visible response, file write, or save confirmation. Failed and refused operations remain recorded.

## Action identity and outcome access

[Explicit action handles](../decisions.md#developer-interfaces) give callers an action identity separately from the backend value or exception. Observations, frames, artifacts, and annotations reference that identity through the shared evidence model. Creating an identity or declaring intent does not establish execution or its timestamp.

Under [D17](../decisions.md#developer-interfaces), the callable preserves native outcomes while the evidence channel independently records retention status. Evidence failure immediately prevents further walkthrough input. The enclosing script/session scope must check evidence on exit: a successful body with failed evidence reports an evidence error; an already failing body preserves its original exception and exposes the additional evidence failure in diagnostics and the report. Completion knowledge lost with a process remains unknown to later inspection unless retained evidence establishes it.

## Action handles

Under [D15](../decisions.md#developer-interfaces), one handle identifies one backend invocation. A step may group multiple handles. Its session, attempt, step, and parent-execution associations remain stable; a continuation cannot silently rebind it.

| Member | Contract |
| --- | --- |
| `id` | Read-only invocation identity, distinct even when titles repeat. Creation establishes intent, without claiming execution or its time. |
| `call(callable)` | Admit input, retain the start durably, then invoke the supplied operation once. Preserve its original value or exception. A second call on that handle is refused without executing another input. |
| `receipt()` | Read an immutable snapshot of known outcome, timing, retention status, and evidence references. Inspection never dispatches work. |
| `observe(evidence)` | Register a sourced observation and associate it with this action through the shared evidence store. |
| `annotate(note)` | Add an attributed explanation with its writing time; preserve original event and observation timestamps. |

An unused handle is not an executed action. A refused or failing call retains an inspectable identity and outcome; missing completion stays uncertain. A deliberate retry receives a new linked handle. Handles recovered in another process support inspection and enrichment without restoring an executable callable.

The callable runs in the process that owns the tool; host-side command submission does not serialize a JavaScript or Python closure for remote execution. A handle surrounding several undisclosed tool calls cannot claim their individual coverage.

Observation and annotation methods are conveniences over the common evidence interface. One observation can reference several action IDs through that interface. Visual claims still require independently inspected recording evidence; a completed tool operation cannot fill that claim automatically. The caller cannot set execution timestamps or manually overwrite success, and recovery exposes no implicit replay operation.

## Execution paths

Operations submitted through SSH and operations performed by an uploaded script share this action contract under [D13](../decisions.md#execution). Delivery changes how execution is requested, not the meaning or completeness of its evidence. Each action retains its parent execution identity so a reviewer can distinguish a submitted command from one operation within a script.

Record events where the operations execute and correlate them with the recording through the [timeline contract](timeline.md). Host submission, upload completion, remote operation, input dispatch, and observed result are distinct events. Transport delay must not become an action timestamp.

Retain an action's start even if its completion cannot be established. After a lost connection, recover the existing remote record; until completion evidence is available, retain an explicit uncertain outcome. Reconnecting must not replay the action to determine what happened.

## Observations

An observation names its source and retains its evidence reference. A recorded video frame, accessibility snapshot, log entry, and file assertion establish different facts. Visual claims reference actual recorded frames; other assertions identify their own source.

An observation made after an operation may contain subsequent activity. The operation-to-observation relationship does not by itself prove causation or precise response latency.

## Annotations

An annotation retains its author or source and references existing actions or observations. It can supply an intent, expected result, explanation, or reported outcome. Adding the annotation later does not move its referenced evidence in time.

## Coverage

Individual events prove coverage of the operations recorded by the interface. One event surrounding an entire script does not establish its internal action history. The [generated-code integration](../engineering/driver-adapters.md#generated-code) must state what it can observe and identify incomplete coverage when operations bypass it.
