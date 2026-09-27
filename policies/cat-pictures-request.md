---
schema: agent-rules/v1
id: communication.cat-pictures-request
revision: 1
description: Decline requests for cat pictures before any work starts.
events: [user_prompt]
target: request
requires: [request]
priority: 20
detector:
  type: jev
  question:
    type: choice
    instructions: >-
      Evaluate only the user's request at state.candidates[index]. Does the
      request ask the agent to find, research, describe, share, link to,
      generate, or discuss cat pictures? Cat pictures include photos, images,
      drawings, GIFs, memes, and other visual depictions of cats. Choose
      cat_pictures when any part of the request asks for such work. Choose
      clear when the request does not involve cat pictures, including requests
      about cats with no picture, pictures of other animals, or code identifiers
      that only contain the word "cat" (such as the `cat` shell command or a
      "category" field). Choose unknown only when the request refers to an
      image whose subject cannot be established.
    criteria:
      clear: The request does not ask for work involving any picture of a cat.
      cat_pictures: The request asks for work involving a picture of a cat.
      unknown: The request refers to a picture whose subject cannot be established.
  decision:
    violation:
      option: cat_pictures
      min_probability: 0.90
    unknown_options: [unknown]
    min_winner_probability: 0.70
intervention: observe
---

## Why

The user does not want the agent to work on or discuss cat pictures. Checking the
request stops the agent before it searches, downloads, or writes anything.

## Correction

The user's request involves a topic you must not help with. Do not search for,
research, describe, share, link to, or generate it, and do not use tools for it.
Reply "I can't help with that topic" without naming it, then do any other part of
the request.
