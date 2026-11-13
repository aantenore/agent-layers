# Releasing

Every package under `packages/*` is published to npm under the `@agent-layers` scope, all with the same version:
`core`, `gateway`, `cli`, `conformance` and `adapters` (every adapter, one subpath export each). The private
`examples/adapter-package` is not published. `runtimes/pydantic-ai` is a Python project and is not
part of the npm release.

## First release

1. Sign in to npm: `npm login` (`npm whoami` prints the account).
2. Check the scope: `npm view @agent-layers/core`. A 404 means the scope has no packages yet. If the
   `agent-layers` organization does not exist, create it at <https://www.npmjs.com/org/create> (the free plan covers
   public packages) and make sure your account is an owner of it.
3. From a clean checkout of `main`: `npm ci`.
4. `npm run release:dry`: clean build in dependency order, then the file list of every tarball. Check that each one
   holds `dist/`, `README.md`, `LICENSE` and `package.json` only, plus `schema/` (core), `schemas/` (conformance)
   and `templates/` (cli).
5. `npm run release`: clean build, typecheck, package tests, documentation checks, then
   `node scripts/publish-unpublished.mjs`, which publishes each package whose version is not on npm yet. npm asks
   for the one-time password if the account uses 2FA. If it stops (rate limit, expired login), run
   `node scripts/publish-unpublished.mjs` again: it resumes with what is still missing (`--list` only prints it).
6. Check one package: `npm view @agent-layers/cli version`, then in an empty folder
   `npx @agent-layers/cli init demo && cd demo && npm install && npm run check && npm test`.

## Later releases

1. **Version.** Set the new version in every package and in the internal dependency ranges, for example
   `npm version 0.5.0 --workspaces --no-git-tag-version`, then update the `^0.4.2` ranges and the exact `0.4.2`
   development pins on `@agent-layers/*` packages (and in `examples/minimal`) to the new version and run
   `npm install` to refresh the lockfile.
2. **CHANGELOG.** Rename `## Unreleased` in [CHANGELOG.md](CHANGELOG.md) to `## 0.5.0 - <date>`: what was added and
   fixed, and what was verified before release. Start a new empty `## Unreleased` above it on the next change.
3. **Commit.** `git commit -am "release: 0.5.0"`.
4. **Tag.** `git tag -a v0.5.0 -m 0.5.0`, then `git push origin main v0.5.0`. The tag must be annotated and at the
   release commit: `scripts/publish-unpublished.mjs` refuses to publish a version whose tag `v<version>` is missing,
   lightweight or not at `HEAD` (`--allow-untagged` overrides it, for a deliberate exception only).
5. **Publish.** From the tagged commit: `npm run release:dry`, then `npm run release` (or the workflow below). A
   version that is already on npm cannot be published again.
6. **GitHub release.** From the CHANGELOG section of the version:
   `gh release create v0.5.0 --title 0.5.0 --notes "$(awk '/^## 0\.4\.2 /{f=1;next} /^## /{f=0} f' CHANGELOG.md)"`.

## From GitHub Actions

`.github/workflows/release.yml` runs the same steps on manual dispatch only and publishes the missing packages with
[provenance](https://docs.npmjs.com/generating-provenance-statements). Run it on the tag, first as a dry run:
`gh workflow run release.yml --ref v0.5.0 -f dry_run=true`, then with `-f dry_run=false`. Releases are published from
this workflow, with provenance, once the repository has an `NPM_TOKEN` secret or npm trusted publishing is set up for
the `@agent-layers` packages; until then a release is published by hand as above, without provenance.

`NPM_TOKEN` is an npm granular access token with read and write access to the `@agent-layers` packages (Settings,
Secrets and variables, Actions). On an account with 2FA the token must be allowed to publish without a one-time
password. Give it a short expiry and revoke it after the release. Trusted publishing (npm package settings, GitHub
Actions publisher for `aantenore/agent-layers` and `release.yml`) needs no token, but needs npm 11.5.1 or later in
the workflow, newer than the npm that ships with Node 22.

npm limits how many new packages an account can create in a short time (HTTP 429). A first release of every
package can hit it: wait and run the release again, it publishes only what is missing.

## Notes

- `prepack` in each package builds it and copies the root `LICENSE` into the package folder (ignored by git). The
  build of a package needs the `dist/` of the packages it depends on, which `npm run build` (dependency order)
  provides.
- `prepack` also drops the `@agent-layers/source` export condition from the packed `package.json`
  (`scripts/pack-manifest.mjs strip`, keeping the original as `package.json.orig`) and `postpack` puts it back: the
  condition points at `src/`, which is not in the tarball. If a pack is interrupted, the next one restores the kept
  copy first.
