---
description: "No `.unwrap()` in library code — return a Result or name the invariant"
condition: "\\.unwrap\\(\\)"
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: never
---

`.unwrap()` turns a recoverable error into a panic carrying no message. The
caller loses the error and gets a line number instead.

## Avoid

```rust
let cfg = read_config(path).unwrap();
```

## Use

```rust
let cfg = read_config(path)?;
```

When the value genuinely cannot be absent, say why in the code rather than in
your head:

```rust
let cfg = read_config(path).expect("config was validated at startup");
```

`expect` costs one line and turns a bare panic into a sentence the next person
can act on.

## Exceptions

- Tests. A panic there is the failure report.
- `main`, where there is nobody left to return to.
- A `Mutex` lock, where the only error is another thread having already panicked.
