# Artifact format

The [logical data schema](../arch/data-schema.md) defines record relationships. Artifact encoding and packaging must preserve those relationships and satisfy the requirements below.

## Encoding and references

- Use a versioned manifest and relative artifact paths so the package can move between machines.
- Retain event and evidence identities independently of annotation text.
- Include recording duration, dimensions, integrity information, and segment identity. Metadata that cannot be established for damaged media remains explicitly unknown with its diagnostic.
- Retain each segment's clock mapping and each derivative's source mapping.
- Include concise opening instructions without requiring access to the execution environment or an external service.

## Host acceptance

The host validates the package after transfer over the established environment channel.

1. Check every required artifact's checksum against the source manifest, including explicitly damaged original media.
2. Attempt media decoding, retain the result and diagnostics, and inspect metadata that can be established. Every artifact advertised as playable must decode successfully. A source-declared damaged original can pass delivery verification when its bytes match and its failed decode state is explicit; changing a flag cannot excuse transfer corruption.
3. Resolve every required artifact and evidence reference.
4. Check timeline bounds and segment associations. Reject playable-frame references and visual claims across unavailable footage; do not fabricate durations or mappings for damaged media.
5. Check that failed or incomplete attempts retain their declared state.
6. Confirm that the delivered viewer can consume the package without the original environment.

[D18](../decisions.md#review-and-delivery) keeps damaged originals and continuations in one package with separate integrity, decodability, and completeness states. Delivery can be verified while recording remains incomplete; that permits environment cleanup but does not satisfy the missing visual verification. Missing required bytes, checksum mismatches, invalid evidence references, or corruption of media advertised as playable still fail acceptance. Salvage remains a separately identified derivative.

Package integrity is distinct from a successful test or human approval. [D7](../decisions.md#evidence) governs those outcome distinctions.
