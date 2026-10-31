# Tool-call authorization for agents. Input: an AccessQuestion in SDK names (see spec/schemas/access-question.json):
# input.caller {kind, id, roles, scopes}, input.action, input.target {kind, id, layer, risk, agent, attrs}.
#
#   data.agents.decision  { allow, reason }, the decision the `opa` adapter reads (default path agents/decision)
#   data.agents.allow     boolean, the same decision without a reason
#
# Only authenticated callers are allowed: the anonymous caller (or a caller of any other kind) is always denied.
package agents

default allow := false

# Tool risks each user role may call. Exec tools are not listed for anyone.
user_risks := {
	"viewer": {"read"},
	"analyst": {"read", "write"},
}

kind := object.get(input, ["caller", "kind"], "anonymous")

# A verified user or agent; the `opa` adapter sends every other caller as the explicit anonymous caller.
authenticated if kind in {"user", "agent"}

risk := object.get(input, ["target", "risk"], null)

roles := object.get(input, ["caller", "roles"], [])

allow if {
	authenticated
	kind == "user"
	some role in roles
	risk in user_risks[role]
}

# The agent's own (authenticated, client-credentials) identity: read tools only.
allow if {
	authenticated
	kind == "agent"
	risk == "read"
}

reason := "allowed" if {
	allow
} else := "exec tools are denied to everyone" if {
	risk == "exec"
} else := sprintf("%s %s may not call %v tools", [kind, object.get(input, ["caller", "id"], "anonymous"), risk])

decision := {"allow": allow, "reason": reason}
