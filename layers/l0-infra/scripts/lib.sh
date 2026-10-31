# Shared helpers for the OpenBao scripts. Sourced, not executed.
# Needs: bash, curl, jq.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

BAO_ADDR="${BAO_ADDR:-http://127.0.0.1:${OPENBAO_PORT:-8200}}"
BAO_TOKEN="${BAO_TOKEN:-${OPENBAO_DEV_ROOT_TOKEN:-dev-root-token}}"
BAO_MOUNT="${BAO_MOUNT:-secret}"            # KV v2 mount
AGENTS_ENV="${AGENTS_ENV:-dev}"             # path segment: secret/agents/<env>/<group>
BAO_PREFIX="agents/${AGENTS_ENV}"

die() { echo "error: $*" >&2; exit 1; }

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done

# bao_api METHOD PATH [JSON_BODY] -> response body on stdout, non-zero on HTTP errors
bao_api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -f -X "$method" -H "X-Vault-Token: ${BAO_TOKEN}" "${BAO_ADDR}/v1/${path}")
  [ -n "$body" ] && args+=(-H "Content-Type: application/json" -d "$body")
  curl "${args[@]}"
}
