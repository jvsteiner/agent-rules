# Versions, local installs, and releases

For every installable plugin update, increment the patch version before handing
the update back to the user. This is an explicit user requirement: installers
need a new version to pick up the update.

Run `npm version patch --no-git-tag-version`. Its version lifecycle builds the
bundles and synchronizes the plugin manifests and both marketplace files from
`package.json`; npm updates `package-lock.json`. Then run `make install-local` to
install the build into Claude Code, Codex, and omp on this machine, and verify
that `make status` reports the new version.

Publishing is a separate, explicit step: `make release` bumps, tests, tags,
publishes `@jvsteiner/agent-rules` to npm, pushes, and creates the GitHub release
(see the Release section of README.md). Do not commit, tag, push, publish, or
create a release unless the user asks for that specific action.
