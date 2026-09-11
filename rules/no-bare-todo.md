---
description: "A TODO needs an owner or an issue in brackets, or it is never done"
condition: "\\bTODO\\b(?!\\()"
scope: "tool:edit(*.ts), tool:write(*.ts), tool:edit(*.tsx), tool:write(*.tsx), tool:edit(*.rs), tool:write(*.rs), tool:edit(*.py), tool:write(*.py), tool:edit(*.js), tool:write(*.js), tool:edit(*.go), tool:write(*.go)"
interruptMode: never
---

A bare `TODO` is a note to nobody. It survives every review because there is
nothing to chase.

## Avoid

```python
# TODO: handle the retry case
```

## Use

```python
# TODO(#412): handle the retry case
# TODO(jamie): handle the retry case
```

An issue number is better than a name, because the issue outlives the person's
memory of what they meant. If the work is worth a marker it is worth a tracker
entry; if it is not, delete the line instead.

## Exceptions

- A scratch file you are about to throw away.
- A template or generator emitting a placeholder for its user to fill in.
