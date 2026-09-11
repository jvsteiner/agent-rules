---
description: "Use a logger, not `print()` — a library that prints cannot be silenced"
condition: "(?m)^\\s*print\\("
scope: "tool:edit(*.py), tool:write(*.py)"
interruptMode: never
---

`print` writes to stdout with no level, no timestamp and no off switch. A
caller who wants quiet cannot get it, and a caller parsing stdout gets your
debug output mixed into their data.

## Avoid

```python
print(f"loaded {n} rows")
```

## Use

```python
log = logging.getLogger(__name__)
log.info("loaded %s rows", n)
```

Pass the values as arguments rather than formatting them in. The string is then
never built when the level is off.

## Exceptions

- A command-line tool whose output **is** the product.
- A script under `scripts/` or `tools/`.
- Deliberate stdout in a pipe, where printing is the interface.
