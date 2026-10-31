# @agent-layers/adapter-rules-authorization

Maps **local rule list** → **AuthorizationPort** (layer `identity`). Tier: prototype, production.

Decides whether a tool call is allowed from an ordered list of rules; the first rule that matches wins. Rules match
tool name globs, risk levels and the caller's kind, roles and scopes. The core asks the ApprovalPort before it reaches
this port, so an `ask` rule that arrives here counts as not allowed without approval. When no rule matches, the
`default` decides (deny unless set).

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `rules` | object[] | required | Rules with `effect` (`allow`, `ask`, `deny`), optional `tools` globs, `risk` list and `when` (`roles`, `scopes`, `kind`, `authenticated`) |
| `default` | `allow` \| `deny` | `deny` | Decision when no rule matches |

`when.authenticated: true` matches any verified subject (user or agent) and never an anonymous caller; scope allow and
`ask` rules with it so the default posture stays anonymous denied.

```json
{
  "layers": {
    "authorization": {
      "adapter": "rules-authorization",
      "options": {
        "rules": [
          { "effect": "deny", "tools": ["shell__*"] },
          { "effect": "ask", "risk": ["write", "exec"], "when": { "authenticated": true } },
          { "effect": "allow", "risk": ["read"], "when": { "authenticated": true } }
        ],
        "default": "deny"
      }
    }
  }
}
```
