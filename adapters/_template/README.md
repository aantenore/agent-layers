# @agent-layers/adapter-template

Maps **a word list** → **GuardPort** (layer `guardrail`). Tier: prototype.

A copyable skeleton. To start a new adapter:

1. Copy this folder to `adapters/<name>`, where `<name>` is the standard or technology the adapter maps
   (`openai-compatible`, `presidio`, `qdrant`, ...).
2. Rename the package to `@agent-layers/adapter-<name>`, drop `"private": true`, and set `name` in the descriptor to
   `<name>`: a stack config then uses it with `"adapter": "<name>"`.
3. Implement the port in `src/index.ts`: a factory function plus a `defineAdapter` descriptor that declares the layer,
   port, direction, what it maps, port version, tiers and an options schema.
4. Make `test/conformance.test.ts` pass, then add a live contract test against the pinned upstream version.

## What the skeleton shows

- **Limits.** `maxTextChars` is declared once in `LIMITS` with `defineLimits`, spread into the options schema with
  `limitProperties` and set as the descriptor's `limits`; the code reads it with `limitValue`. Once the package is
  published, `npm run docs:check` asks for its row in [docs/limits.md](../../docs/limits.md) and prints it ready to
  paste.
- **`ext`.** The verdict carries `template.word`, a key in the adapter's namespace, declared in `ext.produces`.
  Conformance checks that the adapter writes no undeclared key.
- **Mappings.** `mappingDefaults.in` names the shape the adapter builds (`GuardVerdict`). The factory passes the native
  result (`{ word }`) through `mappings.in`, so a stack config can add rules without code, for example
  `"mappings": { "guardrails.template": { "in": [{ "from": "/word", "to": "/labels", "map": { "forbidden": ["policy"] } }] } }`.
  Drop `mappingDefaults` when the adapter translates nothing.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `deny` | string[] | `[]` | Words that make the guard block |
| `maxTextChars` | integer | `100000` | Longest text inspected; longer text is blocked. Accepts `"unbounded"` |

```json
{ "guardrails": [{ "adapter": "template", "options": { "deny": ["forbidden"] } }] }
```

## Maturity checklist

The levels are defined in [docs/adapters.md](../../docs/adapters.md#maturity). Before asking for a level:

- experimental
  - [ ] `defineAdapter` descriptor with `layer`, `port`, `name`, `direction`, `maps`, `portVersion`, `tiers` and
    `optionsSchema`
  - [ ] every timeout, size, count or truncation length is a declared limit with a row in docs/limits.md
  - [ ] `ext` keys namespaced and declared in `ext.produces` / `ext.reads`
  - [ ] `test/conformance.test.ts` reports no failures
  - [ ] README with what it maps, tiers, options table and a config snippet; `npm run docs:adapters` run
- beta
  - [ ] conformance passing in CI
  - [ ] upstream version pinned, with a live contract test that skips when the service is down
  - [ ] an owner in CODEOWNERS
- stable
  - [ ] beta for at least one minor release of its port without breaking changes
  - [ ] every option documented
  - [ ] used in a reference setup
