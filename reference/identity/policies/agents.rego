# Tool-call authorization for agents. Input: an AccessRequest (see spec/schemas/access-request.json).
#
#   data.agents.decision  { allow, reason }, the decision the `opa` adapter reads (default path agents/decision)
#   data.agents.allow     boolean, the same decision without a reason
#
# Only authenticated subjects are allowed: an anonymous or unauthenticated request is always denied.
package agents

default allow := false

# Tool risks each user role may call. Exec tools are not listed for anyone.
user_risks := {
	"viewer": {"read"},
	"analyst": {"read", "write"},
}

authenticated if input.subject.properties.authenticated == true

risk := object.get(input, ["resource", "properties", "risk"], null)

roles := object.get(input, ["subject", "properties", "roles"], [])

allow if {
	authenticated
	input.subject.type == "user"
	some role in roles
	risk in user_risks[role]
}

# The agent's own (authenticated, client-credentials) identity: read tools only.
allow if {
	authenticated
	input.subject.type == "agent"
	risk == "read"
}

reason := "allowed" if {
	allow
} else := "exec tools are denied to everyone" if {
	risk == "exec"
} else := sprintf("%s %s may not call %v tools", [input.subject.type, input.subject.id, risk])

decision := {"allow": allow, "reason": reason}
