---
schema: agent-rules/v1
id: communication.cat-pictures-tool
revision: 2
description: Block tool calls that fetch, search for, or create cat pictures.
events: [tool_start]
target: tool_call
requires: []
prefilter:
  pattern: '\b(cats?|kitt(y|en|ens|ies)|felines?|tabby|tabbies|calico|siamese|persian|maine coon|ragdoll|sphynx)\b[\s\S]*\b(pics?|pictures?|photos?|photographs?|images?|imgs?|jpe?g|png|gif|webp|bitmap|memes?|wallpapers?|drawings?|illustrations?|sketch(es)?|portraits?|selfies?|snapshots?|filetype)\b|\b(pics?|pictures?|photos?|photographs?|images?|imgs?|jpe?g|png|gif|webp|bitmap|memes?|wallpapers?|drawings?|illustrations?|sketch(es)?|portraits?|selfies?|snapshots?|filetype)\b[\s\S]*\b(cats?|kitt(y|en|ens|ies)|felines?|tabby|tabbies|calico|siamese|persian|maine coon|ragdoll|sphynx)\b'
  flags: i
priority: 20
detector:
  type: jev
  question:
    type: choice
    instructions: >-
      Evaluate only the pending tool call at state.candidates[index]: the tool
      name followed by its input. Does this tool call search for, fetch,
      download, open, generate, or save cat pictures? Cat pictures include
      photos, images, drawings, GIFs, memes, and other visual depictions of
      cats. Choose cat_pictures when the call's query, URL, path, prompt, or
      command targets such pictures. Choose clear for any other call, including
      the `cat` shell command, "category" fields, text about cats with no
      picture, and pictures of other animals. Choose unknown only when the call
      targets an image whose subject cannot be established.
    criteria:
      clear: The tool call does not target any picture of a cat.
      cat_pictures: The tool call searches for, fetches, creates, or saves a picture of a cat.
      unknown: The tool call targets a picture whose subject cannot be established.
  decision:
    violation:
      option: cat_pictures
      min_probability: 0.90
    unknown_options: [unknown]
    min_winner_probability: 0.70
intervention: observe
---

## Why

The user does not want the agent to work on cat pictures. Blocking the tool call
stops the work itself, not only the reply about it.

## Correction

This tool call works on a topic you must not help with. Do not retry it or find
another way to do it. Tell the user "I can't help with that topic" without naming
it, then continue with any other part of the task.
