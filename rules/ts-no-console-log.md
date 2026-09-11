---
description: "Use a logger, not `console.log` — it cannot be levelled or turned off"
condition: "console\\.log\\("
scope: "tool:edit(*.ts), tool:write(*.ts), tool:edit(*.tsx), tool:write(*.tsx)"
interruptMode: never
---

`console.log` has no level and no off switch, so it ships to production and
prints forever. In a browser it also keeps whatever it logged alive in the
devtools heap.

## Avoid

```typescript
console.log("fetched", rows.length, "rows");
```

## Use

```typescript
logger.debug("fetched %d rows", rows.length);
```

`console.error` and `console.warn` are fine where there is no logger — they go
to stderr and people expect them.

## Exceptions

- A CLI where stdout is the product.
- A build or migration script.
- A deliberate, temporary debug line you are about to delete.
