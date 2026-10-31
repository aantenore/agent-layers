# Run with: docker compose -f reference/identity/compose.yml exec opa /opa test /policies -v
package agents_test

import data.agents

req(kind, roles, risk) := {
	"caller": {"kind": kind, "id": "x", "roles": roles, "scopes": []},
	"action": "call",
	"target": {"kind": "tool", "id": "t", "layer": "tool", "risk": risk, "agent": "a"},
}

anonymous := {"kind": "anonymous", "id": "anonymous", "roles": [], "scopes": []}

test_viewer_reads if agents.allow with input as req("user", ["viewer"], "read")

test_viewer_cannot_write if not agents.allow with input as req("user", ["viewer"], "write")

test_analyst_writes if agents.allow with input as req("user", ["analyst"], "write")

test_exec_denied_to_users if not agents.allow with input as req("user", ["analyst", "viewer"], "exec")

test_agent_reads if agents.allow with input as req("agent", [], "read")

test_agent_cannot_write if not agents.allow with input as req("agent", [], "write")

test_anonymous_denied if {
	r := json.patch(req("user", ["analyst"], "read"), [{"op": "replace", "path": "/caller", "value": anonymous}])
	not agents.allow with input as r
}

test_anonymous_with_roles_denied if {
	r := json.patch(req("anonymous", ["analyst"], "read"), [{"op": "replace", "path": "/caller/id", "value": "anonymous"}])
	not agents.allow with input as r
}

test_unknown_kind_denied if not agents.allow with input as req("service", ["analyst"], "read")

test_missing_caller_denied if {
	r := json.remove(req("agent", [], "read"), ["/caller"])
	not agents.allow with input as r
}

test_target_attrs_do_not_change_risk if {
	r := json.patch(req("user", ["viewer"], "write"), [{"op": "add", "path": "/target/attrs", "value": {"risk": "read"}}])
	not agents.allow with input as r
}

test_reason if {
	d := agents.decision with input as req("user", ["viewer"], "exec")
	d == {"allow": false, "reason": "exec tools are denied to everyone"}
}

test_reason_names_the_caller if {
	d := agents.decision with input as req("user", ["viewer"], "write")
	d == {"allow": false, "reason": "user x may not call write tools"}
}

test_anonymous_reason if {
	d := agents.decision with input as {"caller": anonymous, "action": "call", "target": {"kind": "tool", "id": "t", "layer": "tool", "risk": "read", "agent": "a"}}
	d == {"allow": false, "reason": "anonymous anonymous may not call read tools"}
}
