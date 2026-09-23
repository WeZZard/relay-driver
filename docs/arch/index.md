# Architecture

The design wraps existing execution tools and binds their evidence to a reviewable recording. [Owner decisions](../decisions.md) constrain the subsystems; [engineering](../engineering/CLAUDE.md) defines their execution mechanisms.

## Subsystem walkthrough

```mermaid
flowchart LR
    Caller[Agent call or generated script] --> Session[Walkthrough session]
    Environment[Remote or VM task context] --> Session
    Session --> Action[Action and observation evidence]
    Session --> Timeline[Recording timeline]
    Backend[Existing execution tools] --> Action
    Capture[Screen capture] --> Timeline
    Action --> Timeline
    Action --> Package[Review package]
    Timeline --> Package
    Package --> Viewer[Local review viewer]
    Viewer --> Review[Human review]
```

## Specifications

| Document | Responsibility |
| --- | --- |
| [Design philosophy](design-philosophy.md) | Principles binding every subsystem. |
| [Sessions](sessions.md) | Task, step, attempt, capture, and handoff lifecycle. |
| [Action and observation evidence](action-evidence.md) | What an operation or observation establishes and how annotations reference it. |
| [Recording timeline](timeline.md) | Time relationships, uncertainty, and segment boundaries. |
| [Review package](review-package.md) | Durable delivery and independent review outcomes. |
| [Data schema](data-schema.md) | Shared record identities and relationships. |
