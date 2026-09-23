# Record and export a walkthrough

## Prepare

1. Read the governing remote-computer or VM policy and complete its allocation, task-registration, installation, and launch requirements.
2. Bind the walkthrough to that task identity and working directory.
3. Verify the installed backend contracts and permissions in the actual execution context.
4. Place the tested UI and required companion applications on the recorded display, with readable content and a visible pointer.
5. Establish the display-ownership arrangement and keep its configuration stable.

Environment authority and credential custody are defined in [environments.md](../engineering/environments.md). This procedure does not prescribe unimplemented CLI commands.

## Record

1. Start capture and wait for recording readiness and time correlation before walkthrough input.
2. Declare the step's intent and expected result at the chosen annotation boundary.
3. Perform operations through the recorded backend interface and retain each receipt.
4. Capture observations with their evidence source and timestamp or recorded-frame reference.
5. Attach explanations to those receipts and observations.
6. Continue recording through the final observable result.

If recording ends unexpectedly, follow [interrupted-recording.md](interrupted-recording.md) immediately. Do not continue input and reconstruct the missing evidence afterward.

## Export and relinquish the environment

1. Finalize the recording and retain the original media and events.
2. Assemble the review manifest, supporting evidence, and local viewer instructions.
3. Verify that published steps reference the intended footage and identify any remaining uncertainty.
4. Transfer the package through the established environment channel.
5. Have the host perform the [package-acceptance checks](../engineering/artifact-format.md#host-acceptance).
6. After accepted transfer, complete cleanup and task unregistration according to the governing environment workflow.
7. Link the durable package in the report and leave human review pending until the reviewer supplies it.

Human review does not require the test environment to remain alive. The host's accepted copy must be sufficient to inspect the evidence after cleanup.
