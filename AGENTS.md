# Release versions

For every installable plugin update, increment the patch version before handing
the update back to the user. This is an explicit user requirement: installers
need a new version to pick up the update.

Run `npm version patch --no-git-tag-version`. Its version lifecycle builds the
bundles and synchronizes all plugin manifests and the existing Claude marketplace
entry from `package.json`; npm updates `package-lock.json`. Verify that `status`
reports the new version. Do not create a release commit or tag unless requested.
