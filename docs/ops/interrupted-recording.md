# Recover from an interrupted recording

## Preserve the interruption

1. Stop further walkthrough input as soon as recording loss is detected.
2. Retain the interruption diagnostic, event records, and any available media.
3. Finalize decodable partial media where possible and keep the attempt marked incomplete.
4. Identify the last established evidence and any gap; do not infer successful coverage from a playable file.

## Continue with a distinct attempt

1. Establish the cause or retain it as unresolved when evidence cannot establish it.
2. Invoke the [explicit continuation operation](../arch/sessions.md#recovery-and-continuation). It coordinates finalizing the interrupted attempt and starting a related attempt and segment with a new clock mapping; interrupted phases remain recoverable.
3. Record its relationship to the interrupted attempt and disclose any runtime or environment changes.
4. Wait for capture readiness before resuming input.
5. Preserve both attempts in the exported review package.

## Deliver an unplayable original

Retain irrecoverably damaged original bytes, their decode diagnostic, the journal, and any playable continuation in the same package. Apply the [host-acceptance checks](../engineering/artifact-format.md#host-acceptance) to every artifact. Matching bytes can establish delivery even when playback fails; unavailable footage remains explicit and cannot support a visual claim. Once the entire delivery is verified, the governing cleanup procedure may proceed. Further verification is still needed for missing coverage.

## Handle failed transfer

If host acceptance fails, retain the only available remote evidence and repair or repeat the transfer through the established channel. Do not delete the source or destroy the VM while its required evidence has no accepted durable copy. Follow the governing environment policy to report unresolved cleanup.

The [timeline contract](../arch/timeline.md) governs gaps and segment mappings. The [review-package contract](../arch/review-package.md) keeps incomplete recording, execution failure, and human judgment separate.
