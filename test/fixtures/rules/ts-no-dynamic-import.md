---
description: "Do not use `await import()` — use static imports unless dynamic loading is unavoidable"
condition: "await import\\("
scope: "tool:edit(*.ts), tool:edit(*.tsx), tool:write(*.ts), tool:write(*.tsx)"
interruptMode: never
---

Use static imports for modules known at author time.

## Why

- Static imports fail during build, not under load.

## Exceptions

- Plugin loading from a runtime registry.
