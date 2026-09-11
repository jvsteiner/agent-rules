# Recorded hook payloads

Envelopes captured from real Claude Code sessions, not written from the
documentation. The hook contract has changed more than once; a recording is how
you find that out instead of a user.

They are named by index, not by tool — `PreToolUse-Edit-2.json` is in fact a
`Write`, which is useful: the set covers both shapes.

**The file bodies are not original.** Each recording's `new_string` or `content`
has been replaced with a short stand-in. Every other field is exactly as
recorded. What is under test is the envelope and the matching, and the original
bodies were long documents that named unrelated local paths.
