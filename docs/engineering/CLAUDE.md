# engineering/ — maintenance rules

- Keep execution mechanisms here: environment configuration, tool adapters, recording clocks, artifact encoding, and verification methods.
- Keep behavioral subsystem contracts in `../arch/`; link to them rather than duplicating their rules.
- Record an unverified backend fact with `(to verify)`. Cite the available contract and verify the installed version before relying on it.
- Keep environment authority and credential custody in `environments.md`. No document contains secret values.
- Keep open discussions, unresolved choices, tentative proposals, build order, and implementation progress in the repository's `.plans/` documents; keep actual run results in `.reviews/`.
- Keep the verification catalog's IDs stable and distinguish required proof from observed results.

## Contents

- [Environments](environments.md) defines host and execution-environment responsibilities.
- [Driver adapters](driver-adapters.md) defines the tool boundary, input classification, and generated-code path.
- [Capture and timing](capture-and-timing.md) defines recorder reuse and clock correlation mechanisms.
- [Artifact format](artifact-format.md) defines the encoding requirements and validation mechanics.
- [Verification](verification.md) registers the required proof contracts.
