# Decisions

This is the authoritative inventory of owner-confirmed decisions. The records below come from the walkthrough discussion, the owner's approved walkthrough-capture policy on 2026-09-08, and the owner's review-option selections and follow-up ratification on 2026-09-10. Mechanisms without an owner decision remain architect-derived and open to change.

## Maintenance

- Allocate the next unused D-number for a new owner-confirmed decision. Never renumber or reuse an existing ID.
- Record whether a decision was owner-set or owner-ratified and retain its provenance when it changes.
- Keep the contents list current. Open discussions and alternatives belong in `.plans/`; this file records settled owner decisions.

## Contents

- [Execution](#execution) defines the execution tools, input contract, and environment composition.
- [Evidence](#evidence) defines capture, timing, original records, and outcome distinctions.
- [Review and delivery](#review-and-delivery) defines the review surface and durable handoff.
- [Project identity](#project-identity) defines the project and repository names.
- [Documentation](#documentation) defines where design and discussion records belong.
- [Developer interfaces](#developer-interfaces) defines the required SDK languages and CLI surface.

## Execution

- **D1 Backend-independent relay** (owner-set, refined 2026-09-08): Relay must support arbitrary backend integrations without a closed set of driver types in the core API. The earlier discussion named Playwright, Chrome DevTools, and cua-driver as execution tools; the owner's refinement makes them examples rather than the core's supported-backend list. Preserve an operation's actual origin as evidence without requiring a built-in backend selection for every call.
- **D2 Environment composition** (owner-set): Compose walkthroughs with the remote-computer and VM sections of the governing environment policy. Inherit task identity, working directory, ownership, and the evidence-transfer channel; environment allocation and cleanup remain governed there.
- **D3 Real input and accessibility testing** (owner-set): Perform ordinary interactions through real pointer and keyboard input. Accessibility may discover controls, resolve coordinates, and observe state. Direct accessibility activation or value-setting is reserved for a test of that accessibility behavior and must be identified in the evidence. Keyboard-navigation tests use real keystrokes. Keep walkthrough-specific instrumentation outside the shipped application.
- **D13 Both remote execution paths** (owner-set, 2026-09-08): Support both operations submitted through SSH and scripts uploaded and then executed remotely. Both paths must correctly record their individual walkthrough events and timestamps under the same evidence and media-timing contract. An uploaded script's process start and finish alone do not satisfy its individual-action recording requirement.

- **D19 Resource budgets and remote supervision** (owner-ratified, Q5 A and follow-up, 2026-09-10): Apply task storage and per-execution output limits with measured sizing defaults, optional overrides within the task budget, and protected shutdown/finalization capacity. Supervise usage on the remote machine independently of SSH and the tool script. Disable input and stop affected work before ordinary usage consumes the shutdown allowance. Bound Relay-controlled buffers/output directly; represent external-process monitoring and environment-provided hard quotas according to their actual enforcement. Numeric profiles and thresholds require measurement; script authors do not estimate resources per action.

## Evidence

- **D4 Continuous capture** (owner-ratified): Record the whole test display with readable content and a visible pointer. Verify permissions in the actual execution context. Capture begins before the first interaction and continues through the final observable result. Unexpected recording loss stops further walkthrough input and leaves an incomplete attempt.
- **D5 Measured timing and evidence references** (owner-ratified): Record structured actions as they happen. Use the actual recording timeline with the first captured frame defining zero. Correlate the event clock to that timeline and retain UTC separately. Steps identify action and observation intervals or review points; explanations distinguish visible evidence from other assertions.
- **D6 Original evidence** (owner-ratified): Preserve original recordings and event records. Retries and continuations have distinct attempt identities. Derivatives and excerpts identify their sources and timeline mappings. Failed actions and gaps remain visible.
- **D7 Independent outcomes** (owner-ratified): Report recording completeness, execution outcome, and human review status separately. A valid recording proves neither successful execution nor human approval.

## Review and delivery

- **D8 Navigable local viewer** (owner-set and owner-ratified): Show the recording beside synchronized explanatory steps in a reusable local web viewer. Support step selection, seeking with context, current-step highlighting, previous/next navigation, stable step links, and explicit failure states. Supply project-specific explanations as data.
- **D9 Portable handoff before teardown** (owner-ratified): Deliver a portable package with a versioned manifest, relative artifact paths, media metadata, checksums, and opening instructions. Transfer it through the established evidence channel and verify it on the host before cleanup, reboot, or VM destruction. Human review may happen after the execution environment is gone.

- **D18 One package with explicit artifact states** (owner-set, Q6 A, 2026-09-10): Keep damaged originals, their diagnostics, and playable continuations in one portable package. Validate delivery integrity separately from decodability and recording completeness. All media advertised as playable must decode; damaged originals retain their failed decode result and cannot support missing visual claims. Verified delivery permits the governing cleanup procedure while missing verification remains outstanding.

## Evidence — snapshot era

- **D20 Dispatch-time snapshot evidence** (owner-set, 2026-09-11): Relay Driver's built-in evidence is per-event dispatch-time snapshot PAIRS, not continuous video. The before-snapshot is captured immediately before the input event dispatches; the after-snapshot is captured exactly `afterIntervalMs` after dispatch completion. The interval is REQUIRED and agent-supplied per event (or per coalescing group) — the agent's knowledge of the screen semantics (dialog vs game) is the single authority; the runtime never guesses, polls for stability, or defaults. A missing interval is a usage refusal before dispatch.
- **D21 Causal pairs, never deduplicated** (owner-set, 2026-09-11): The before/after pair is the causal proof — after shows the effect, before establishes the baseline the effect is attributed against. Near-identical frames are acceptable; eliminating identical images is not a goal of the system. Every event gets its pair.
- **D22 Sender-declared text-entry coalescing** (owner-set, 2026-09-11): Consecutive keystrokes of one text run may form a deterministic, sender-declared group with ONE before/after pair spanning the group (before the first key, after the last). Every keystroke remains its own journal event referencing the group pair. Group membership is declared by the sender, never inferred.
- **D23 Snapshot naming and provenance** (owner-set, 2026-09-11): Snapshot files are named `<journal-seq>-<ISO-8601Z>-<role>-<dispatch-identity>.png` so they sort chronologically and bind bidirectionally to journal records. Files are hashed at capture; capture-start and capture-complete times are journaled; provenance class is fixed as `dispatch-captured` in the package manifest.
- **D24 Video is application-level** (owner-set, 2026-09-11): Relay Driver no longer records, requires, or manages video. Continuous recording (e.g. ScreenCaptureKit segments) is an application-level concern — a walkthrough application may record video and attach it to the package through the application-attachment slot, which Relay verifies byte-wise but never interprets. Capture readiness is screenshot capability, not an active recording.

## Project identity

- **D10 Relay Driver** (owner-set, 2026-09-08): The project is named **Relay Driver** and its repository is `relay-driver`, as confirmed by the owner's rename request following the naming discussion.

## Documentation

- **D11 Open discussions in plans** (owner-set, 2026-09-08): Keep open discussions in Markdown documents under the repository's `.plans/` directory. Update the applicable documents in `docs/` when a discussion is resolved, retaining owner-confirmed decisions in this inventory.

## Developer interfaces

- **D12 SDK languages and CLI** (owner-set, 2026-09-08): Provide SDK support for JavaScript, TypeScript, and Python, together with a CLI. Ground the interface design in how agents actually invoke tools through scripts, MCP, and command-line programs. Package organization and API spellings remain design work in `.plans/`.

- **D14 SDK-managed recovery identities** (owner-set, Q1 A, 2026-09-10): The SDK/CLI saves session and request identities before submission and supplies reattachment, enumeration, and outcome inspection. Preserve explicit caller IDs as an integration option. Startup failures after acquiring resources remain discoverable; recovery does not replay uncertain input.
- **D15 Explicit action handles** (owner-set, Q2 A; follow-up surface owner-ratified, 2026-09-10): One handle represents one invocation and exposes `id`, `call`, `receipt`, `observe`, and `annotate`. Creation establishes identity and intent; `call` retains the start before invoking the original operation once and preserves its value or exception. Repeated calls are refused; a deliberate retry uses a distinct linked identity. Recovered handles support inspection and enrichment without replay. Observation and annotation conveniences use the shared evidence store, preserving original times and source records. Language-specific argument schemas remain engineering details.
- **D16 Explicit continuation operation** (owner-set, Q3 A, 2026-09-10): One explicit operation coordinates finalizing the interrupted attempt, creating a related attempt, starting capture, and establishing new timing/readiness. Its phases remain recoverable and retain the earlier evidence. This is distinct from reattachment or replay.
- **D17 Native outcomes and enforced evidence checks** (owner-set, Q4 A, 2026-09-10): Preserve the tool's native return value or exception and expose evidence status separately. A mandatory enclosing scope checks evidence on exit. Evidence failure immediately disables further input; scope exit exposes it without masking an existing tool exception. Child outcome, Relay evidence status, and transport failure remain distinguishable in CLI receipts.
