# Contributing

## Add an adapter in one pull request

Adapters are independent packages, so anyone can add and maintain one without touching the core.

1. Copy [`adapters/_template`](adapters/_template) to `adapters/<name>`. Name it after the standard or technology it
   maps: `openai-compatible`, `qdrant`, `presidio`.
2. In `package.json`: name `@agent-layers/adapter-<name>`, remove `"private": true`, add
   `"publishConfig": { "access": "public" }`, set `repository.directory` and `homepage` to `adapters/<name>`, keep
   `@agent-layers/core` as a peer dependency. Runtime dependencies only when the technology needs a client library.
3. In `src/index.ts`: a factory plus a `defineAdapter` descriptor with `layer`, `port`, `name` (= `<name>`),
   `direction`, `maps` (`standard` or `technology`), `portVersion: PORT_VERSIONS.<Port>`, `tiers` and
   `optionsSchema`. Technology-specific features go behind `native()` or the `extra` / `meta` fields. Every timeout,
   size, count or truncation length is an option declared once with `defineLimits` and set as the descriptor's
   `limits` (see [docs/limits.md](docs/limits.md)), never a literal in the code.
4. Tests: `test/conformance.test.ts` with `checkAdapter` from `@agent-layers/conformance` must report no failures.
   For an upstream service, add a live contract test against a pinned version that skips when the service is down.
5. `README.md`: what it maps onto which port, tiers, an options table and a config snippet.
6. Run `npm run docs:adapters` to add the adapter to the catalog in [docs/adapters.md](docs/adapters.md) (the table is
   generated from the descriptor; remove the adapter from the Planned list if it was there) and, if you will maintain
   it, add a line in [CODEOWNERS](CODEOWNERS).

Checks for the pull request, run only for the package you touched:

```bash
npx tsc -p adapters/<name>/tsconfig.json
npm test -w @agent-layers/adapter-<name>
npm run docs:check
```

New adapters start as `experimental`; the criteria for `beta` and `stable` are in
[docs/adapters.md](docs/adapters.md#maturity).

## Change the core

The core (`packages/core`, `packages/conformance`, `packages/cli`) and the spec (`spec/`) are owned by the
maintainers listed in CODEOWNERS. A core change starts with a spec change:

1. Update the port page in `spec/ports/` and its schema in `spec/schemas/`.
2. Bump the port version per [spec/VERSIONING.md](spec/VERSIONING.md) (in `packages/core/src/ports/catalog.ts`).
3. Then the core, then the conformance suite, then the adapters that declare the old version.

If the stack config schema changes, regenerate it with `npm run gen:schema -w @agent-layers/core`.
Documentation follows the same rule: a changed layer, port or environment variable must be reflected in `docs/`;
`npm run docs:check` catches the drift (see below).

## Build and release

`npm run build` builds every package in dependency order (`scripts/build-packages.mjs`; `--clean` removes `dist/`
first). Packages ship `dist/` (JavaScript and type declarations), `README.md` and `LICENSE`; the `source` export
condition points at `src/` for development inside the repository only.

- `npm run release:dry`: clean build, then `npm pack --dry-run` of every package, to review the tarball contents.
- `npm run release`: clean build, typecheck, package tests, `docs:check`, then `npm publish --workspaces --access public`.

The steps for the maintainer, including the npm organization and the GitHub Actions workflow, are in
[RELEASING.md](RELEASING.md).

## Style

TypeScript, ESM, Node >= 22.18, `node --test`, small files, short JSDoc. Zero runtime dependencies in the core
packages. Documentation in English, short sentences, no marketing language. Never put tokens or secrets in errors,
logs or telemetry.

## Documentation checks

`npm run docs:check` (also `make docs-check`, and a step of the CI lint job) verifies that:

- relative Markdown links and `#anchors` resolve;
- layer ids, numbers, names and questions in tables match `LAYERS` in `packages/core`, and ports sit under their layer;
- every port in `PORTS` has a page in `spec/ports/` with the same layer and version, and every page is a port;
- `.env.example`, the environment table in [docs/contracts.md](docs/contracts.md) and the defaults in
  `reference/*/compose.yml` agree;
- the adapter catalog in [docs/adapters.md](docs/adapters.md) is what `npm run docs:adapters` generates;
- every limit declared in code has a row in [docs/limits.md](docs/limits.md) with the same default, ranges and check,
  and every row there is declared (a missing row is printed ready to paste);
- no stale paths or model names remain, and the docs name no assistant tooling.
