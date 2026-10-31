# @agent-layers/adapter-presidio

Maps **Microsoft Presidio** → **GuardPort** (layer `guardrail`). Tiers: prototype, production. Maturity: experimental.

Finds PII with the Presidio analyzer (`POST /analyze`) and rewrites it with the anonymizer (`POST /anonymize`), or blocks
the text. Verdict reasons name entity types (`PII redacted: EMAIL_ADDRESS`), never the matched values. If Presidio cannot
be reached or answers badly the guard fails closed: the verdict is `block` with the reason `presidio unavailable: <cause>`.
Response bodies are never copied into reasons, because services often echo the text they were sent.

Tested live against Presidio 2.2.362 (`reference/guardrail`).

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `analyzerUrl` | string | required | Analyzer base URL |
| `anonymizerUrl` | string | none | Anonymizer base URL; required when `action` is `redact` |
| `action` | `"redact"` \| `"block"` | `"redact"` | What to do with text that has findings |
| `language` | string | `"en"` | Language of the text |
| `entities` | string[] | all | Entity types to look for, e.g. `["EMAIL_ADDRESS", "PHONE_NUMBER"]` |
| `scoreThreshold` | number | analyzer default | Ignore findings scored below this, 0 to 1 |
| `operators` | object | anonymizer default (`<ENTITY>`) | Anonymizer operators per entity, `DEFAULT` for the rest |
| `stages` | string[] | all | `input`, `output`, `tool_args`, `tool_result` |
| `onError` | `"block"` \| `"allow"` | `"block"` | Fail closed or open when Presidio fails |
| `headers` | object | none | Extra request headers |
| `timeoutMs` | integer | 10000 | Per-request timeout |

Leave `entities` unset only if you want everything: the default list includes `DATE_TIME`, `PERSON` and `URL`, which
makes ordinary sentences ("see you today") come back redacted.

```json
{
  "layers": {
    "guardrails": [
      {
        "adapter": "presidio",
        "options": {
          "analyzerUrl": "${env:PRESIDIO_ANALYZER_URL}",
          "anonymizerUrl": "${env:PRESIDIO_ANONYMIZER_URL}",
          "entities": ["EMAIL_ADDRESS", "PHONE_NUMBER", "CREDIT_CARD"],
          "operators": { "DEFAULT": { "type": "replace", "new_value": "[PII]" } }
        }
      }
    ]
  }
}
```
