# @agent-layers/adapter-llm-guard

Maps **LLM Guard** (Protect AI) → **GuardPort** (layer `guardrail`). Tiers: prototype, production. Maturity: experimental.

Calls the LLM Guard REST API. The `output` stage goes through `/analyze/output` (which requires a `prompt` field; the
guard has none, so it sends an empty one); every other stage goes through `/analyze/prompt`. An invalid result blocks and
names the failing scanners (a passing scanner reports a risk score of -1). A valid result whose sanitized text differs
is applied as a redaction. Default stages are `input`, `output` and `tool_result`: prompt scanners also catch injection
planted in tool results.

Fails closed: an unreachable service, a timeout, an unexpected body or a rejected token gives a `block` with the reason
`llm-guard unavailable: <cause>`. A missing token answers HTTP 403 and a wrong one HTTP 401; both read
`authentication failed`. The cause is one of `HTTP <status>`, `timeout`, `response too large`, `invalid response`,
`network error` (a failing label mapping: `llm-guard: label mapping failed`);
error text and the token never appear in reasons, and URLs with credentials are rejected at creation.

Verdicts that name scanners carry `labels` from the guard label vocabulary and the scanner names under
`ext["llm-guard.scanners"]`. Scanner names become labels through `in` mapping rules on `GuardVerdict` (source
`{ "scanners": [...] }`): by default `PromptInjection` and `InvisibleText` → `injection`, `Secrets` → `secret`,
`Anonymize` and `Sensitive` → `pii`, `Toxicity` → `toxicity`, the `Ban*`, `Code`, `Regex` and `MaliciousURLs` scanners
→ `policy`, anything else → `other`. Replace them per guard with `mappings.guardrails.<name>.in`; labels the stack's
vocabulary does not know become `other`.

Some scanners (`Secrets`, `Anonymize`) report the result as invalid but return the text with the finding replaced. List
them in `sanitizeScanners` to apply that text instead of blocking; if any other scanner fails too, the text is blocked.

Tested live against LLM Guard API 0.3.16 with `PromptInjection` and `Secrets` (`reference/guardrail`; the first start
downloads a model and takes a few minutes).

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | required | API base URL |
| `token` | string | none | Bearer token (the API's `AUTH_TOKEN`) |
| `scannersSuppress` | string[] | `[]` | Scanner class names to skip on every call |
| `sanitizeScanners` | string[] | `[]` | Scanners whose sanitized text is applied instead of a block |
| `stages` | string[] | `input`, `output`, `tool_result` | Stages the guard runs at |
| `onError` | `"block"` \| `"allow"` | `"block"` | Fail closed or open when the service fails |
| `headers` | object | none | Extra request headers |
| `timeoutMs` | integer | 30000 | Per-request timeout (scanners run models) |
| `maxResponseBytes` | integer | 1048576 | Largest answer read; a larger one is a failure (`onError`) |

Limits accept `${env:NAME}`; `timeoutMs` and `maxResponseBytes` also accept `"unbounded"`, which `agent-layers check`
fails on the production tier. The answer carries the sanitized text: raise `maxResponseBytes` for texts larger than
about 1 MiB.
Ranges and checks: [docs/limits.md](../../docs/limits.md).

```json
{
  "layers": {
    "guardrails": [
      {
        "adapter": "llm-guard",
        "options": { "url": "${env:LLM_GUARD_URL}", "token": "${secret:LLM_GUARD_TOKEN}", "sanitizeScanners": ["Secrets"] }
      }
    ]
  }
}
```
