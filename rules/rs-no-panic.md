---
description: "A library must not `panic!` — return an error the caller can handle"
condition: "panic!\\("
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: never
---

A panic crosses the library boundary and takes down a caller who had a perfectly
good way to recover.

## Avoid

```rust
pub fn parse(s: &str) -> Config {
    if s.is_empty() {
        panic!("empty config");
    }
    ...
}
```

## Use

```rust
pub fn parse(s: &str) -> Result<Config, ConfigError> {
    if s.is_empty() {
        return Err(ConfigError::Empty);
    }
    ...
}
```

## Exceptions

- Tests, and `unreachable!` for a branch the type system cannot rule out.
- A binary's `main`, where a panic is just a noisy exit.
- A broken invariant that means memory is already corrupt — panicking is then
  the safe move, and the message should say which invariant.
