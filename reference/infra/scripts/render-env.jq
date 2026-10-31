# Merges a secrets object ($s) into the lines of an env file (input, raw): known keys are replaced in place,
# unknown keys are appended. Values with whitespace, #, quotes, $ or backslashes are single-quoted.
def key: capture("^(?<k>[A-Za-z_][A-Za-z0-9_]*)=").k;
def isvar: test("^[A-Za-z_][A-Za-z0-9_]*=");
def val:
  if type != "string" or test("\n") then error("unsupported secret value")
  elif test("[\\s#\"$\\\\']") then
    if test("'") then error("value needs quoting but contains a single quote") else "'" + . + "'" end
  else . end;

($s | map_values(val)) as $q
| [inputs] as $lines
| ($lines | map(if isvar then (key) as $k | if ($q | has($k)) then $k + "=" + $q[$k] else . end else . end)) as $body
| ($body | map(select(isvar) | key)) as $present
| $body[], ($q | keys[] | select(. as $k | $present | index($k) | not) | . + "=" + $q[.])
