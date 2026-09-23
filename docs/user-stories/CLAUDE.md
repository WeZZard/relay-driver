# User stories — maintenance rules

- Keep indexing directional: `index.md` points to the profile files; profile files do not link back to the index or to each other.
- Append every new story to `index.md` and allocate the next unused `US-<number>` from that table. Never reuse or renumber an ID.
- Write every story as “As a <profile>, I want <capability>, so that <benefit>.” Put observable acceptance criteria beneath it.
- Keep profile definitions in `../user-profiles.md`. The story index owns the mapping between profiles and stories.
- Link verification contracts from the index. Do not present acceptance criteria or contract IDs as completed verification.
