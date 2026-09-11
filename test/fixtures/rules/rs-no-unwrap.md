---
description: "No `.unwrap()` outside tests — return a Result or name the invariant"
condition: "\\.unwrap\\(\\)"
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: never
---

`.unwrap()` turns a recoverable error into a panic with no message.
