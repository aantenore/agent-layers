#!/usr/bin/env bash
# Renders a .env from OpenBao: the base file (default .env.example) with every secret found under
# secret/agents/<env>/ substituted, or appended when the base does not define it.
#
# Usage: env-from-openbao.sh [-o FILE] [-b BASE] [-f]
#   -o FILE  write to FILE (mode 600) instead of stdout
#   -b BASE  base env file (default: <repo>/.env.example)
#   -f       overwrite FILE if it exists
# Environment: BAO_ADDR, BAO_TOKEN, BAO_MOUNT, AGENTS_ENV (see lib.sh). The token needs list on the
# metadata path and read on the data paths.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

out="" base="$REPO_ROOT/.env.example" force=0
while getopts "o:b:fh" opt; do
  case "$opt" in
    o) out="$OPTARG" ;;
    b) base="$OPTARG" ;;
    f) force=1 ;;
    *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
  esac
done
[ -f "$base" ] || die "base file not found: $base"
if [ -n "$out" ] && [ -e "$out" ] && [ "$force" -ne 1 ]; then
  die "$out exists; pass -f to overwrite"
fi

groups="$(bao_api LIST "${BAO_MOUNT}/metadata/${BAO_PREFIX}" | jq -r '.data.keys[]')" \
  || die "cannot list ${BAO_MOUNT}/${BAO_PREFIX} at ${BAO_ADDR} (run: make secrets-seed)"

secrets='{}'
for group in $groups; do
  group="${group%/}"
  part="$(bao_api GET "${BAO_MOUNT}/data/${BAO_PREFIX}/${group}" | jq -c '.data.data')"
  secrets="$(jq -c -s 'add' <<<"${secrets}${part}")"
done

render() {
  jq -Rrn --argjson s "$secrets" -f "$(dirname "${BASH_SOURCE[0]}")/render-env.jq" "$base"
}

if [ -z "$out" ]; then
  render
else
  ( umask 077; render > "$out" )
  echo "wrote $out" >&2
fi
