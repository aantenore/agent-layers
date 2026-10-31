#!/usr/bin/env bash
# Writes the platform secrets into OpenBao (KV v2) under secret/agents/<env>/<group>.
#
# Values come from, in order: the process environment, the repository .env, .env.example.
# Defaults: OpenBao at http://127.0.0.1:8200 with the dev root token. Override with BAO_ADDR / BAO_TOKEN.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# group -> variables stored under it
GROUPS_MAP=(
  "identity:OIDC_CLIENT_SECRET"
  "guardrails:LLM_GUARD_TOKEN"
  "gateway:GATEWAY_KEY"
  "telemetry:LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY"
)

# value_of NAME: environment first, then .env, then .env.example
value_of() {
  local name="$1" file line
  if [ -n "${!name:-}" ]; then printf '%s' "${!name}"; return 0; fi
  for file in "$REPO_ROOT/.env" "$REPO_ROOT/.env.example"; do
    [ -f "$file" ] || continue
    line="$(grep -m1 "^${name}=" "$file" || true)"
    if [ -n "$line" ]; then printf '%s' "${line#*=}"; return 0; fi
  done
  return 1
}

curl -sS -f -o /dev/null -H "X-Vault-Token: ${BAO_TOKEN}" "${BAO_ADDR}/v1/sys/health?standbyok=true" \
  || die "OpenBao not reachable at ${BAO_ADDR} (run: make infra-up)"

for entry in "${GROUPS_MAP[@]}"; do
  group="${entry%%:*}"
  data='{}'
  for name in ${entry#*:}; do
    value="$(value_of "$name")" || die "no value for ${name} in the environment, .env or .env.example"
    data="$(jq -c --arg k "$name" --arg v "$value" '. + {($k): $v}' <<<"$data")"
  done
  bao_api POST "${BAO_MOUNT}/data/${BAO_PREFIX}/${group}" "$(jq -c '{data: .}' <<<"$data")" >/dev/null
  echo "seeded ${BAO_MOUNT}/${BAO_PREFIX}/${group}"
done
