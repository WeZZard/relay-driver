# docs

This tree is the source of truth for the project's design. It follows the organization of `../progressively-homepage/docs`. Open discussions, execution plans, and implementation progress live outside the tracked design tree.

## Conventions

- Describe established requirements, design, and enduring operational procedures here. Keep open discussions, unresolved choices, tentative proposals, milestone status, and build order in Markdown documents under the repository's ignored `.plans/`; keep run results in `.reviews/`.
- Keep one paragraph, list item, or table row per line. Do not hard-wrap prose. Write parallel requirements as lists of complete sentences.
- Mark an unresolved factual claim with the literal text `(to verify)`. Remove the marker only after verification and update the design in place.
- Keep related open discussions, alternatives, and execution planning in a single dated Markdown file in `.plans/`. Do not maintain open-question lists or tentative proposals in `docs/`. Once a discussion is resolved, update the applicable design documents; add an owner decision only when the owner made or confirmed it.
- Allocate owner decisions in `decisions.md` as `D<number>`. Never reuse or renumber an ID.
- Allocate user stories from `user-stories/index.md` as `US-<number>`. Keep profile definitions independent of story IDs.
- Register verification contracts in `engineering/verification.md` with uppercase, hyphenated IDs ending in a numeric ordinal. A contract describes required proof, not evidence that a check has passed.
- Keep subsystem behavior in `arch/` and execution mechanisms in `engineering/`. Keep review interaction design in `ux/` and operator procedures in `ops/`.
- Update indexes and links when files or headings move. Give each rule one authoritative home and link to it from other concerns.
- Keep secret values and runtime recordings outside this tree. Environment authority and credential custody are defined once in `engineering/environments.md`.

## Contents

- [decisions.md](decisions.md) records the owner-confirmed requirements.
- [user-profiles.md](user-profiles.md) defines the operator and reviewer roles.
- [user-stories/index.md](user-stories/index.md) maps stable story IDs to their profile documents.
- [ux/sitemap.md](ux/sitemap.md) introduces the review surfaces, wireframes, and review flow.
- [arch/index.md](arch/index.md) maps the behavioral subsystems and their specifications.
- [engineering/CLAUDE.md](engineering/CLAUDE.md) indexes the execution mechanisms and verification contracts.
- [ops/README.md](ops/README.md) indexes the operational runbooks.
