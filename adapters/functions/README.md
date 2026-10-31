# @agent-layers/adapter-functions

Maps **JavaScript functions** → **ToolPort** (layer `tool`). Tier: prototype, production.

Turns plain functions into tools. Describe each one with `defineTool({ name, description, params, run })`, then
load them from a module named in the config or pass them from code with `functionTools(defs)`. Arguments are validated
against `params` before `run` is called. A string result becomes `{ ok: true, text }`, a `{ ok, text, data? }`
result is used as is, and any other value is returned as JSON text (and as `data`). A thrown error becomes a result with
`ok: false` the model can react to; abort errors are rethrown. `run` receives the call context, so a tool can read
`ctx.caller` or `await ctx.credentials.token(audience)`. Optional `risk`, `layer`, `audience` and `attrs` are copied to
the tool spec.

A module may export a `tools` array, a `default` array or object, or individual tool objects. It does not need to
import this package: plain objects with the right shape are enough.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `module` | string | none | Module with the tools: a path relative to the config directory, or a package specifier |
| `tools` | object[] | `[]` | Tool definitions passed from code (programmatic use only) |

```js
// tools.mjs
export const tools = [{
  name: 'add',
  description: 'Add two numbers',
  risk: 'read',
  params: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  run: ({ a, b }) => String(a + b),
}];
```

```json
{
  "layers": {
    "tools": {
      "local": { "adapter": "functions", "options": { "module": "./tools.mjs" } }
    }
  }
}
```
