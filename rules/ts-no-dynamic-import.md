---
description: "Do not use `await import()` — use a static import unless the path is runtime-chosen"
condition: "await import\\("
scope: "tool:edit(*.ts), tool:write(*.ts), tool:edit(*.tsx), tool:write(*.tsx)"
interruptMode: never
---

Use static imports for modules known when you write the line.

## Why

- A static import fails at build time. A dynamic one fails under load.
- Bundlers, type checkers and tree shakers can see it.
- The dependency graph stays readable.
- The consumer keeps the real module types with no cast.

## Avoid

```typescript
const { createClient } = await import("some-sdk");
const mod = (await import("./known-module")) as { run?: unknown };
```

## Use

```typescript
import { createClient } from "some-sdk";
import { run } from "./known-module";
```

## Exceptions

- Loading a plugin whose path is only known at runtime.
- A platform-specific module that does not exist everywhere.
- Breaking a genuine import cycle, with a comment saying so.
