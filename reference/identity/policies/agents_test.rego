# Run with: docker compose -f reference/identity/compose.yml exec opa /opa test /policies -v
package agents_test

import data.agents

req(type, roles, risk) := {
	"subject": {"type": type, "id": "x", "properties": {"roles": roles, "scopes": [], "authenticated": true}},
	"action": {"name": "call"},
	"resource": {"type": "tool", "id": "t", "properties": {"risk": risk, "agent": "a"}},
}

test_viewer_reads if agents.allow with input as req("user", ["viewer"], "read")

test_viewer_cannot_write if not agents.allow with input as req("user", ["viewer"], "write")

test_analyst_writes if agents.allow with input as req("user", ["analyst"], "write")

test_exec_denied_to_users if not agents.allow with input as req("user", ["analyst", "viewer"], "exec")

test_agent_reads if agents.allow with input as req("agent", [], "read")

test_agent_cannot_write if not agents.allow with input as req("agent", [], "write")

test_unauthenticated_agent_denied if {
	r := json.patch(req("agent", [], "read"), [{"op": "replace", "path": "/subject/properties/authenticated", "value": false}])
	not agents.allow with input as r
}

test_unauthenticated_user_denied if {
	r := json.patch(req("user", ["analyst"], "read"), [{"op": "replace", "path": "/subject/properties/authenticated", "value": false}])
	not agents.allow with input as r
}

test_anonymous_denied if {
	r := {
		"subject": {"type": "anonymous", "id": "anonymous", "properties": {"roles": [], "scopes": [], "authenticated": false}},
		"action": {"name": "call"},
		"resource": {"type": "tool", "id": "t", "properties": {"risk": "read", "agent": "a"}},
	}
	not agents.allow with input as r
}

test_reason if {
	d := agents.decision with input as req("user", ["viewer"], "exec")
	d == {"allow": false, "reason": "exec tools are denied to everyone"}
}
