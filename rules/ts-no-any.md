---
description: "Never use `any` — reach for `unknown`, a generic, or a schema parse"
condition: ":\\s*any\\b|as\\s+any\\b"
scope: "tool:edit(*.ts), tool:write(*.ts), tool:edit(*.tsx), tool:write(*.tsx)"
interruptMode: never
---

`any` switches off type checking at exactly the boundary that needed it, and
the hole spreads: every value derived from an `any` is also unchecked.

## Avoid

```typescript
function handle(payload: any) { ... }
const user = res.data as any;
```

## Use

- `unknown` for input you have not validated yet. The compiler then forces you
  to narrow it before use.
- A schema parse at a trust boundary — validate once, then carry a typed value.
- A generic when the caller supplies the shape.
- The real type when you already know it.

```typescript
function handle(payload: unknown) {
  const parsed = PayloadSchema.parse(payload);
  ...
}
```

## Exceptions

- Declaration files describing a third-party library that is genuinely untyped.
- A deliberate escape hatch with a comment naming what is unsafe about it.
