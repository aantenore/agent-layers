# @agent-layers/adapter-rules-authorization

Maps **local rule list** → **AuthorizationPort** (layer `identity`). Tier: prototype, production.

Decides whether a tool call, or an approval action, is allowed from an ordered list of rules; the first rule that
matches wins. Rules match tool name globs, risk levels, actions and the caller's kind, roles, scopes and delegation
chain. The core asks the ApprovalPort before it reaches this port, so an `ask` rule that arrives here counts as not
allowed without approval. When no rule matches, the `default` decides for a tool call (deny unless set); any other
action is denied.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `rules` | object[] | required | Rules with `effect` (`allow`, `ask`, `deny`), optional `tools` globs, `risk` list, `actions` list and `when` (`roles`, `scopes`, `kind`, `authenticated`, `actor`, `actors`, `delegated`, `issuer`) |
| `default` | `allow` \| `deny` | `deny` | Decision for a tool call when no rule matches; other actions are always denied then |

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
| `issuer` | string[] | Globs on the issuer that vouches for an actor (`Actor.issuer`): with `actor` or `actors`, an actor matches only when its issuer matches too. Actor ids are unique per issuer only; an actor without `issuer` never matches a rule that gives one |

A question whose actor chain is malformed (an entry without an id or with an unknown kind, or a chain that is not a list)
is denied before any rule is evaluated.

RFC 8693 says only the current actor counts for access control and prior actors are informational. So `actor` looks
at the current actor only, and a prior actor matters only to a rule that asks for it with `actors`. A caller without
actors never matches `actor` or `actors`.

Actions (AuthorizationPort 1.3.0): tool calls ask `call`; the gateway's approval routes ask `list` to read approvals
and `decide` to decide or cancel one, on a target of kind `approval` whose `risk` is the risk of the call being
approved ([docs/gateway.md](../../docs/gateway.md#approvals)); the run routes ask `resume` and `cancel` on a target
of kind `run`, and acting on another caller's run asks `decide` ([docs/gateway.md](../../docs/gateway.md#runs)). A rule with `actions` matches those actions (a core
value also matches values added `like` it in the stack's `vocabularies`); a rule without `actions` matches tool calls
only. So the catch-all rules below never let anyone decide an approval: only the first rule does, for operators.

```json
{
  "layers": {
    "authorization": {
      "adapter": "rules-authorization",
      "options": {
        "rules": [
          { "effect": "allow", "actions": ["decide", "list"], "when": { "roles": ["operator"] } },
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
