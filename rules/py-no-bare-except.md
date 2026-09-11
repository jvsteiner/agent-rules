---
description: "Never write a bare `except:` — name the exception you expect"
condition: "except\\s*:"
scope: "tool:edit(*.py), tool:write(*.py)"
interruptMode: never
---

A bare `except:` catches `KeyboardInterrupt` and `SystemExit` as well, so it
swallows Ctrl-C and turns a shutdown into a hang.

## Avoid

```python
try:
    parse(raw)
except:
    return None
```

## Use

```python
try:
    parse(raw)
except ValueError as e:
    log.warning("unparseable payload: %s", e)
    return None
```

If the point really is "whatever goes wrong, keep going", say so with
`except Exception:` — that spells the intent and still lets Ctrl-C through.

## Exceptions

- A top-level crash handler that logs and re-raises.
