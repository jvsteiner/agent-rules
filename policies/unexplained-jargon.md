---
schema: agent-rules/v1
id: communication.unexplained-jargon
revision: 1
description: Explain specialized terms that a general software user needs to act on.
events: [response_end]
target: response
requires: [request, response]
priority: 20
detector:
  type: jev
  question:
    type: choice
    instructions: >-
      Evaluate only the candidate at state.candidates[index], using the user's
      audience stated in state.request. Does this text contain a specialized
      term that materially blocks understanding because it is left unexplained?
      Choose jargon only when the term is specialized for this audience and is
      needed to understand or act on the answer. Choose clear when the term is
      explained nearby, the wording is plain, or common programming terms fit
      the requested technical level. Choose unknown if the audience or needed
      context cannot be established.
    criteria:
      clear: No material unexplained term blocks understanding.
      jargon: A necessary specialized term is unexplained and impairs understanding.
      unknown: The available request and response do not establish the reader's needs.
  decision:
    violation:
      option: jargon
      min_probability: 0.92
    unknown_options: [unknown]
    min_winner_probability: 0.75
intervention: observe
---

## Why

Technical answers should stay understandable to the person who asked.

## Correction

Add a short plain-language explanation of the term where it first matters.
