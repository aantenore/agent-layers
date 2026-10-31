# @agent-layers/adapter-presidio

Maps **Microsoft Presidio** → **GuardPort** (layer `guardrail`). Tiers: prototype, production. Maturity: experimental.

Finds PII with the Presidio analyzer (`POST /analyze`) and rewrites it with the anonymizer (`POST /anonymize`), or blocks
the text. Verdict reasons name entity types (`PII redacted: EMAIL_ADDRESS`), never the matched values. Verdicts carry
`labels` from the guard label vocabulary and the entity types found under `ext["presidio.entities"]` (identifier-like
names only). If Presidio cannot be reached or answers badly the guard fails closed: the verdict is `block` with the
reason `presidio unavailable: <cause>`, where the cause is one of `HTTP <status>`, `redirects are not followed (HTTP
<status>)`, `timeout`, `response too large`, `invalid response`, `network error`. `onError` applies only to these
failures: a label mapping that fails on a detection keeps the `block` or `redact` verdict, labelled `other`, with
`ext["presidio.mappingError"]` set. Redirects are never followed, so the text and headers stay with the configured
host. Error text and response bodies are never copied into reasons: they can echo URLs, headers or the text that was
sent. URLs with credentials are rejected at creation.

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
| `maxResponseBytes` | integer | 1048576 | Largest analyzer or anonymizer answer read; a larger one is a failure (`onError`) |

Limits accept `${env:NAME}`; `timeoutMs` and `maxResponseBytes` also accept `"unbounded"`, which `agent-layers check`
fails on the production tier. The anonymizer answers the whole text: raise `maxResponseBytes` if guarded texts are
larger than about 1 MiB.
Ranges and checks: [docs/limits.md](../../docs/limits.md).

## Labels

Entity types become labels through `in` mapping rules on `GuardVerdict` (source `{ "entities": [...] }`). The default
maps Presidio's predefined entity types (`EMAIL_ADDRESS`, `PHONE_NUMBER`, `CREDIT_CARD`, `PERSON`, `IBAN_CODE`,
national ids...) to `pii` and anything else (custom recognizers) to `other`. Replace it per guard in the stack config;
labels the stack's vocabulary does not know become `other`:

```json
{ "mappings": { "guardrails.pii": { "in": [{ "from": "/entities", "to": "/labels", "map": { "MEDICAL_LICENSE": "pii.health", "*": "pii" } }] } },
  "vocabularies": { "guardLabel": { "add": { "pii.health": { "like": "pii" } } } } }
```

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
