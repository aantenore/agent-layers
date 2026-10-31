# Releasing

Every package under `packages/*` and `adapters/*` (except the private `adapters/_template`) is published to npm
under the `@agent-layers` scope, all with the same version. `runtimes/pydantic-ai` is a Python project and is not
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
   `npm publish --workspaces --access public`. npm asks for the one-time password if the account uses 2FA.
6. Check one package: `npm view @agent-layers/cli version`, then in an empty folder
   `npx @agent-layers/cli init demo && cd demo && npm install && npx agent-layers check && npm test`.

## Later releases

1. Set the new version in every package and in the internal dependency ranges, for example
   `npm version 0.2.0 --workspaces --no-git-tag-version`, then update the `^0.1.0` ranges on `@agent-layers/*`
   packages to `^0.2.0` and run `npm install` to refresh the lockfile.
2. Commit, tag `v0.2.0`, push.
3. `npm run release:dry`, then `npm run release`. A version that is already on npm cannot be published again.

## From GitHub Actions

`.github/workflows/release.yml` runs the same steps on manual dispatch only and publishes with
[provenance](https://docs.npmjs.com/generating-provenance-statements). It needs a repository secret `NPM_TOKEN`: an
npm granular access token with read and write access to the `@agent-layers` packages (Settings, Secrets and
variables, Actions). Run it from the Actions tab, first with `dry_run` checked.

## Notes

- `@agent-layers/adapter-reinloop` depends on `reinloop` through a GitHub URL pinned to a commit, so installing it
  needs `git` and access to github.com. Switch the dependency to a version range once `reinloop` is on npm.
- `prepack` in each package builds it and copies the root `LICENSE` into the package folder (ignored by git). The
  build of a package needs the `dist/` of the packages it depends on, which `npm run build` (dependency order)
  provides.
