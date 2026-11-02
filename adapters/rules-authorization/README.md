# @agent-layers/adapter-rules-authorization

Maps **local rule list** → **AuthorizationPort** (layer `identity`). Tier: prototype, production.

Decides whether a tool call is allowed from an ordered list of rules; the first rule that matches wins. Rules match
tool name globs, risk levels and the caller's kind, roles, scopes and delegation chain. The core asks the ApprovalPort before it reaches
this port, so an `ask` rule that arrives here counts as not allowed without approval. When no rule matches, the
`default` decides (deny unless set).

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `rules` | object[] | required | Rules with `effect` (`allow`, `ask`, `deny`), optional `tools` globs, `risk` list and `when` (`roles`, `scopes`, `kind`, `authenticated`, `actor`, `actors`, `delegated`) |
| `default` | `allow` \| `deny` | `deny` | Decision when no rule matches |

`when.authenticated: true` matches any verified caller (user or agent) and never an anonymous one; scope allow and
`ask` rules with it so the default posture stays anonymous denied. `risk` takes core values (`read`, `write`, `exec`)
and values added in the stack's `vocabularies` block: a rule on a core value also matches the values added `like` it,
and a risk the stack does not know counts as `exec`. Decisions are `{ allowed, reason }`; the reason stays inside the
stack.

Delegation (`Caller.actors`, set by an identity adapter such as `oidc` from the RFC 8693 `act` claim, first delegate first,
the agent presenting the credential last):

| `when` field | Type | Matches |
|---|---|---|
| `actor` | string[] | Globs on the id of the current actor, the last of `actors`. Never matches a caller without actors |
| `actors` | string[] | Globs on the id of any actor of the chain, prior ones included |
| `delegated` | boolean | `true`: the caller has at least one actor; `false`: it has none |

RFC 8693 says only the current actor counts for access control and prior actors are informational. So `actor` looks
at the current actor only, and a prior actor matters only to a rule that asks for it with `actors`. A caller without
actors never matches `actor` or `actors`.

```json
{
  "layers": {
    "authorization": {
      "adapter": "rules-authorization",
      "options": {
        "rules": [
          { "effect": "deny", "tools": ["shell__*"] },
          { "effect": "ask", "risk": ["write", "exec"], "when": { "authenticated": true } },
          { "effect": "allow", "tools": ["docs__*"], "when": { "actor": ["notes-agent"] } },
          { "effect": "deny", "when": { "actors": ["untrusted-*"] } },
          { "effect": "allow", "risk": ["read"], "when": { "authenticated": true } }
        ],
        "default": "deny"
      }
    }
  }
}
```
