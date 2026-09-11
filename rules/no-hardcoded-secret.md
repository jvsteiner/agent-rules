---
description: "Never put a key, token or password in source — read it from the environment"
condition: "(?i)(api[_-]?key|secret|token|password|passwd)\\s*[:=]\\s*[\"'][A-Za-z0-9_+\\-]{16,}[\"']"
scope: "tool:edit(**/*), tool:write(**/*)"
interruptMode: never
---

A committed secret is a leaked secret. Git keeps it after the deletion commit,
forks keep it after the repository is made private, and rotating it is somebody
else's afternoon.

## Avoid

```python
API_KEY = "EXAMPLE_NOT_A_REAL_KEY_0000000"
```

## Use

```python
API_KEY = os.environ["API_KEY"]
```

Put the name in `.env.example` with an empty value, and the real value in
`.env`, which is gitignored.

## If one is already committed

Rotate it first. Removing the line does not remove it from history, and
scrubbing history does not reach forks or clones. Treat the value as public
from the moment it was pushed.

## Exceptions

- A test fixture whose value is obviously fake and is never accepted by
  anything real.
- A public, non-secret identifier that happens to be named `token`.
