# Agent Rules development and release tasks. Run `make` or `make help` for the list.
#
# Run make from the repository root: every path below is absolute, built from $(PWD).
# Recipes work with the GNU Make 3.81 that ships with macOS: each multi-step recipe is
# one shell command joined with backslashes, and starts with `set -euo pipefail`.

ROOT    := $(PWD)
PLUGIN  := $(ROOT)/plugin
RELEASE := $(ROOT)/.release
CLI     := $(PLUGIN)/dist/agent-rules.js
PACKAGE := $(shell node -p "require('$(ROOT)/package.json').pluginPackage" 2>/dev/null)
REPO    := jvsteiner/agent-rules
BUMP    ?= patch
VERSION  = $$(node -p "require('$(ROOT)/package.json').version")

SHELL := /bin/bash
.DEFAULT_GOAL := help

ifeq ($(wildcard $(ROOT)/tools/build.mjs),)
$(error Run make from the agent-rules repository root; $(ROOT) is not it)
endif

.PHONY: help deps build test validate check status install-local install-omp pack release release-check release-bump release-publish release-github

help: ## List the targets
	@grep -E '^[a-z-]+:.*## ' "$(ROOT)/Makefile" | awk -F ':.*## ' '{printf "  make %-16s %s\n", $$1, $$2}'
	@echo "  Release bump: make release BUMP=patch|minor|major (default patch)"

deps: ## Install development dependencies from the lockfile, then build
	@npm ci --prefix "$(ROOT)"

build: ## Bundle dist/ and assemble plugin/ (the npm package and local marketplace)
	@node "$(ROOT)/tools/build.mjs"

test: ## Build, then run the full test suite
	@npm test --prefix "$(ROOT)"

validate: build ## Validate the bundled policies
	@node "$(CLI)" validate "$(ROOT)/policies" > /dev/null && echo "Bundled policies are valid."

check: test validate ## Everything a release requires: tests and policy validation

status: build ## Show the effective policies, modes, and whether TYPESAFE_API_KEY is set
	@node "$(CLI)" status

install-local: build ## Install this checkout into Claude Code, Codex, and omp on this machine
	@node "$(ROOT)/tools/install-hosts.mjs"

install-omp: build ## Install this checkout into omp only
	@node "$(CLI)" install-omp --rules "$(ROOT)/rules"

pack: build ## Write the npm package tarball to .release/
	@mkdir -p "$(RELEASE)" && npm pack "$(PLUGIN)" --pack-destination "$(RELEASE)" --silent

release: release-check release-bump release-publish release-github ## Bump, test, tag, publish to npm, push, and create the GitHub release

release-check: ## Refuse to release from a dirty tree, another branch, or without npm and gh logins
	@set -euo pipefail; \
	branch=$$(git -C "$(ROOT)" branch --show-current); \
	[ "$$branch" = main ] || { echo "Release from main, not $$branch."; exit 1; }; \
	[ -z "$$(git -C "$(ROOT)" status --porcelain)" ] || { echo "Commit or stash your changes first:"; git -C "$(ROOT)" status --short; exit 1; }; \
	git -C "$(ROOT)" fetch --quiet origin main; \
	[ "$$(git -C "$(ROOT)" rev-parse HEAD)" = "$$(git -C "$(ROOT)" rev-parse origin/main)" ] || { echo "main is not in sync with origin/main. Pull or push first."; exit 1; }; \
	npm whoami > /dev/null 2>&1 || { echo "Not logged in to npm. Run: npm login"; exit 1; }; \
	gh auth status > /dev/null 2>&1 || { echo "Not logged in to GitHub. Run: gh auth login"; exit 1; }; \
	echo "Ready to release $(PACKAGE) with a $(BUMP) bump."

release-bump: ## Bump the version (BUMP=patch|minor|major), build, test, validate, commit, and tag
	@set -euo pipefail; \
	cd "$(ROOT)"; \
	npm version "$(BUMP)" --no-git-tag-version > /dev/null; \
	version=$(VERSION); \
	npm test --prefix "$(ROOT)"; \
	node "$(CLI)" validate "$(ROOT)/policies" > /dev/null; \
	git -C "$(ROOT)" add -A; \
	git -C "$(ROOT)" commit --quiet -m "release: v$$version"; \
	git -C "$(ROOT)" tag -a "v$$version" -m "v$$version"; \
	echo "Tagged v$$version."

release-publish: ## Publish plugin/ to npm, then push main and the version tag
	@set -euo pipefail; \
	version=$(VERSION); \
	[ "$$(node -p "require('$(PLUGIN)/package.json').version")" = "$$version" ] || { echo "plugin/ is not built for v$$version. Run make build."; exit 1; }; \
	git -C "$(ROOT)" rev-parse --quiet --verify "refs/tags/v$$version" > /dev/null || { echo "Tag v$$version is missing. Run make release-bump."; exit 1; }; \
	npm publish "$(PLUGIN)" --access public; \
	git -C "$(ROOT)" push origin main "v$$version"; \
	echo "Published $(PACKAGE)@$$version and pushed v$$version."

release-github: pack ## Create the GitHub release for the current version, with the package tarball
	@set -euo pipefail; \
	version=$(VERSION); \
	tarball="$(RELEASE)/$$(node -p "'$(PACKAGE)'.replace('@','').replace('/','-')")-$$version.tgz"; \
	gh release create "v$$version" "$$tarball" --repo "$(REPO)" --title "v$$version" --generate-notes \
	  --notes "npm: \`$(PACKAGE)@$$version\`. Install and update steps: https://github.com/$(REPO)#install"; \
	echo "GitHub release v$$version created."
