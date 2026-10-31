# Contributing

## Add an adapter in one pull request

Adapters are independent packages, so anyone can add and maintain one without touching the core.

1. Copy [`adapters/_template`](adapters/_template) to `adapters/<name>`. Name it after the standard or technology it
   maps: `openai-compatible`, `qdrant`, `presidio`.
2. In `package.json`: name `@agent-layers/adapter-<name>`, remove `"private": true`, keep `@agent-layers/core` as a
   peer dependency. Runtime dependencies only when the technology needs a client library.
3. In `src/index.ts`: a factory plus a `defineAdapter` descriptor with `layer`, `port`, `name` (= `<name>`),
   `direction`, `maps` (`standard` or `technology`), `portVersion: PORT_VERSIONS.<Port>`, `tiers` and
   `optionsSchema`. Technology-specific features go behind `native()` or the `extra` / `meta` fields.
4. Tests: `test/conformance.test.ts` with `checkAdapter` from `@agent-layers/conformance` must report no failures.
   For an upstream service, add a live contract test against a pinned version that skips when the service is down.
5. `README.md`: what it maps onto which port, tiers, an options table and a config snippet.
6. Add a row to [docs/adapters.md](docs/adapters.md) and, if you will maintain it, a line in [CODEOWNERS](CODEOWNERS).

Checks for the pull request, run only for the package you touched:

```bash
npx tsc -p adapters/<name>/tsconfig.json
npm test -w @agent-layers/adapter-<name>
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

## Style

TypeScript, ESM, Node >= 22.18, `node --test`, small files, short JSDoc. Zero runtime dependencies in the core
packages. Documentation in English, short sentences, no marketing language. Never put tokens or secrets in errors,
logs or telemetry.
