# Record identities and relationships

This is the logical schema shared by the subsystems. It describes record identities and relationships. [Artifact encoding requirements](../engineering/artifact-format.md) govern their serialization and packaging.

| Record | Identity and relationships |
| --- | --- |
| Task | Inherited environment identity, project, and authority context. |
| Session | Associates the task with its trajectory steps and attempts. |
| Step | Stable review identity with intent and expected result; references action events and observations. |
| Attempt | Identifies one execution attempt and its relationship to earlier retries or continuations. |
| Recording segment | Identifies media, clock mapping, completeness, and any interruption. |
| Action event | References the session, step, attempt, segment, backend operation, target, input method, timing, and result. |
| Observation | Identifies its evidence source and timestamp or frame reference. |
| Annotation | References existing events or observations and retains the explanation's author or source. |
| Artifact | Identifies a relative package path, media or evidence metadata, and integrity information. |
| Human review | References the reviewed evidence and the reviewer's judgment independently of execution outcomes. |

## Invariants

- References remain stable when explanations are edited or the package moves to another host.
- An event's writing time and its referenced evidence time are separate facts.
- An original artifact is never replaced by its derivative.
- A derivative identifies its original artifact and timeline mapping.
- Missing required artifacts, checksum mismatches, invalid references, and failure to decode an artifact advertised as playable remain validation failures. An explicitly damaged original can have verified delivery while its playback and coverage remain failed or incomplete, under [artifact acceptance](../engineering/artifact-format.md#host-acceptance).
- Human judgments retain which evidence they concern when new attempts are added.
