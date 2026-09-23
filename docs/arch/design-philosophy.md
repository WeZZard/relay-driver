# Design philosophy

## Meaning follows evidence

The agent supplies intent and explanation. Execution and capture supply measured events and observations. An annotation references what was observed; its writing time does not become the observation time. This is the basis of [D5](../decisions.md#evidence).

## An input path determines the claim

The method used to locate a target is separate from the method used to activate it. A direct accessibility action does not establish that pointer interaction works. A keyboard-navigation claim requires keyboard input. [D3](../decisions.md#execution) defines the accessibility-testing exception.

## Recording is part of execution

Capture readiness precedes walkthrough input. Unexpected capture loss stops further input and produces an incomplete attempt. A later continuation cannot turn the earlier attempt into a complete recording.

## Sources survive presentation

Original recordings and events remain authoritative. Review steps and playback derivatives reference them. Explanations may evolve without replacing the underlying evidence or rendering a new original movie.

## Outcomes remain independent

Recording completeness, execution outcome, and human review answer different questions. None inherits success from another. A saved file or completed tool call also does not establish that its visible confirmation appeared.

## Environment ownership is inherited

The walkthrough consumes the existing task identity and environment authority. It produces durable evidence before that environment is relinquished; it does not create a second allocation or cleanup mechanism.
