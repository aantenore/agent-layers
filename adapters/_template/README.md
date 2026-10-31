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

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `deny` | string[] | `[]` | Words that make the guard block |

```json
{ "guardrails": [{ "adapter": "template", "options": { "deny": ["forbidden"] } }] }
```
