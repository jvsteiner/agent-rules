---
description: "Never use `ruff format` — Black owns width, Ruff owns lint"
condition: "ruff\\s+format"
scope: "tool:edit(Makefile), tool:write(Makefile), tool:edit(*.toml), tool:write(*.toml), tool:edit(*.yml), tool:write(*.yml), tool:edit(*.yaml), tool:write(*.yaml), tool:edit(*.sh), tool:write(*.sh)"
interruptMode: never
---

Black is the formatter. Ruff is the linter. Never the other way round.

## Why

Two formatters with different widths re-flow each other's output forever. One
session ran `ruff format` at 100 characters across 122 files while the editor
was set to `black --line-length 80`. Every later save would have undone it.

## Avoid

```make
fmt:
	ruff format .
```

## Use

```make
fmt:
	black .
	ruff check --fix .
```

Black's width comes from the editor, never the other way round. Read
`~/.config/zed/settings.json` → `languages.Python.formatter.external.arguments`
and copy that number into `[tool.black] line-length`. Today it is **80**.

Set `[tool.ruff] line-length` about 20 higher — **100** — because it is a
ceiling, not a target. Matching them makes Ruff's E501 fire on long strings,
imports and URLs that Black could not wrap.

## Exceptions

None. If a project disagrees, change the project.
