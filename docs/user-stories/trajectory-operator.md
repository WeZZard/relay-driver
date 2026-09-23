# Trajectory operator stories

## US-1 Record ordinary input

As a trajectory operator, I want my existing tools to record the input they perform, so that the evidence follows the actual interaction.

- The recorded operation identifies its backend, target, input method, execution interval, and result.
- An operation submitted through SSH receives a remote event record tied to the recording; transport submission time remains separate.
- Integrating another backend does not require adding a driver type to the core API; its actual origin remains identifiable in the evidence.
- Target discovery through accessibility remains distinct from direct accessibility activation.
- A successful input dispatch does not automatically mark the application response or save as successful.

## US-2 Retain generated-script actions

As a trajectory operator, I want generated scripts to use the recorded interaction interface, so that loops and conditional actions remain individually inspectable.

- Each action performed through the interface has its own event receipt.
- An uploaded script joins the same recording and event contract as directly submitted SSH operations; upload completion and script execution remain distinct.
- Each receipt identifies its parent execution and retains its remote timing, including repeated actions in loops and actions in the branch actually taken.
- A receipt for a whole script does not establish coverage of its individual actions.
- Coverage limitations from code that bypasses the interface remain explicit.
- JavaScript, TypeScript, and Python SDKs provide the same trajectory identities and evidence semantics while preserving the language's original calls and failures.

## US-3 Correlate actions and observations

As a trajectory operator, I want measured actions and observations tied to the recording, so that I can explain the right moment without inventing a timestamp.

- Input timing originates in the execution environment and is mapped to actual media time.
- SSH submission and uploaded-script execution satisfy the same timing contract, including declared measurement boundaries and uncertainty.
- A later annotation references the evidence time rather than its own writing time.
- A result observed between two inspections retains that interval until closer evidence narrows it.

## US-4 Preserve an interrupted attempt

As a trajectory operator, I want recording loss to stop further input and preserve the partial evidence, so that an interrupted run cannot silently appear complete.

- The interrupted attempt remains identifiable and incomplete.
- A continuation receives a distinct attempt and recording segment.
- The earlier recording and event records remain available.

## US-5 Export before environment cleanup

As a trajectory operator, I want the host to verify my exported package before cleanup, so that the evidence survives the remote session or VM.

- The package opens without access to the execution environment.
- Host acceptance checks the artifacts and their references.
- Cleanup follows the governing environment policy after accepted transfer; it does not wait for human review.

## US-6 Identify accessibility tests

As a trajectory operator, I want direct accessibility actions identified when I test accessibility behavior, so that the evidence states which interaction path was exercised.

- Direct accessibility activation and value-setting are reserved for an explicitly identified accessibility test.
- Keyboard-navigation tests still send real keystrokes.
- The reported conclusion is limited to the behavior exercised.
