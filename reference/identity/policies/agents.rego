# Tool-call authorization for agents. Input: an AccessRequest (see docs/contracts.md, L5).
#
#   data.agents.allow     boolean, used by the reinloop `opa` adapter (default path agents/allow)
#   data.agents.decision  { allow, reason }, the same decision with a reason (path agents/decision)
package agents

default allow := false

# Tool risks each user role may call. Exec tools are not listed for anyone.
user_risks := {
	"viewer": {"read"},
	"analyst": {"read", "write"},
}

risk := object.get(input, ["resource", "properties", "risk"], null)

roles := object.get(input, ["subject", "properties", "roles"], [])

allow if {
	input.subject.type == "user"
	some role in roles
	risk in user_risks[role]
}

# The agent's own (authenticated, client-credentials) identity: read tools only.
allow if {
	input.subject.type == "agent"
	input.subject.properties.authenticated == true
	risk == "read"
}

reason := "allowed" if {
	allow
} else := "exec tools are denied to everyone" if {
	risk == "exec"
} else := sprintf("%s %s may not call %v tools", [input.subject.type, input.subject.id, risk])

decision := {"allow": allow, "reason": reason}
