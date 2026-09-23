# Driver adapters

## Scope

The relay core supports arbitrary integrations under [D1](../decisions.md#execution). An integration supplies its callable or routable boundary and preserves the operation's original request, result, and errors. The core does not enumerate Playwright, Chrome DevTools, cua-driver, or other products as driver types. Origin metadata identifies what actually ran; it is not a required choice from a built-in backend list.

The integration must identify what it observes. A callback boundary, an MCP request, a command invocation, and an actual input dispatch establish different intervals and coverage. Supporting an integration does not automatically verify its input-delivery method or recording precision.

## Entry points

Each adapter wraps the actual dispatch boundary and retains the original backend operation and result. It adds the common identity and evidence fields required by the [action contract](../arch/action-evidence.md). A host-side timer around an SSH request cannot establish when remote input was submitted.

Both execution paths are required by [D13](../decisions.md#execution), and both must satisfy the [shared action contract](../arch/action-evidence.md#execution-paths).

| Execution path | Required coverage |
| --- | --- |
| Submit an operation through SSH | Record the operation in the remote execution environment. A command that performs multiple interactions must also provide individual action records. Code streamed through SSH stdin has the same requirement. |
| Upload a script, then execute it remotely | Verify the deployed script's identity and connect its recorded operations to the same walkthrough session. Each executed action receives a receipt, including actions inside loops and branches. Upload completion is separate from execution. |

Use the same remote event-recording contract for both paths. An upload mechanism or SSH wrapper alone does not establish inner-action coverage; the execution boundary must supply it. Preserve the executed script's identity with its parent execution record so later local edits cannot change the evidence of what ran.

## SDK and CLI coverage

Provide JavaScript, TypeScript, and Python SDK support and a CLI under [D12](../decisions.md#developer-interfaces). They share session, step, attempt, event, and recording identities, along with the same evidence and outcome semantics. Language conventions may differ without changing what an event claims.

Keep backend-specific objects and calls usable in their native environment. The integration must retain original return values and failures, distinguish operation completion from application success, and state the granularity of its recording. Wrapping a command or script cannot silently establish its individual input history.

## Recovery and result channels

The [session lifecycle](../arch/sessions.md#recovery-and-continuation) defines reattachment and explicit continuation. SDK/CLI submission persists identities before transmission and exposes discovery, list, status, and wait responsibilities. The remote record distinguishes admission, completion, and uncertainty independently of SSH exit.

The [action contract](../arch/action-evidence.md#action-identity-and-outcome-access) separates native callable outcomes from evidence status. In-process callers retain original value/exception identity; cross-process inspection uses a documented representation. Keep machine-readable receipts separate from child output and Relay diagnostics. A successful child with failed evidence gives the Relay command a nonzero outcome while preserving the original child exit code or signal in its receipt. The managed script/session scope always performs the evidence check; it is not an optional convention for callers.

Recorded SDK calls use the [single-use action handle](../arch/action-evidence.md#action-handles). The execution runtime enforces [task resource budgets](environments.md#task-resource-budgets), independent of which tool supplies the operation.

## Generated code

Generated scripts need a recorded client interface whose operations produce the same events as direct agent calls. Scripts may discover targets, compute coordinates, loop, and branch while their UI operations use that interface. Generic recorded-call scopes or verified dispatch hooks can supply those events while existing tools keep their APIs; neither SDK language nor script delivery changes the evidence requirement.

An MCP proxy records MCP calls. It cannot automatically observe every action inside arbitrary scripts or page-evaluation code. A single script-level receipt is insufficient to claim individual-action coverage.

The integration must identify incomplete coverage when operations bypass the recorded interface. A wrapper alone cannot guarantee coverage of arbitrary direct API calls.

## Input classification

| Backend activity | Classification required by the adapter |
| --- | --- |
| Read a DOM or accessibility snapshot | Observation and target discovery. |
| Perform pointer or keyboard input | Ordinary interaction, after verifying the method's actual delivery path. |
| Invoke direct accessibility activation or value-setting | Accessibility-test interaction only, explicitly identified. |
| Mutate application state or dispatch page events directly | Setup or diagnostic activity; it does not prove ordinary input behavior. |

Classify each backend operation against the real-input rule using its verified delivery path. The tool name alone does not establish input semantics.

Every integrated tool contributes to the same event stream. One tool's own action recorder does not automatically observe calls made through another tool; Playwright, Chrome DevTools, and cua-driver illustrate this boundary.

## Recorder integration

Reuse backend observations and recordings when their contracts satisfy the shared evidence requirements. [Capture and timing](capture-and-timing.md) owns the recorder and clock-correlation mechanism. Backend metadata must retain failed calls and missing observations rather than silently presenting a successful action.

## References

- [Cua integration choices](https://cua.ai/docs/concepts/choose-a-cua-driver-integration) describes the available runtime and transport boundaries.
- [Cua tool reference](https://github.com/trycua/cua/blob/main/docs/content/docs/reference/cua-driver/mcp-tools.mdx) describes operation and recording contracts.
- [Playwright actions](https://playwright.dev/docs/input) distinguishes input operations from programmatic event dispatch.

These references establish available mechanisms. Verify the installed versions before relying on a delivery or recording contract.
