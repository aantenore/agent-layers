# @agent-layers/adapter-regex-guard

Maps **regular expressions** → **GuardPort** (layer `guardrail`). Tier: prototype.

Scans text at any guard stage for emails, phone numbers, IBANs, card numbers, API keys and prompt-injection phrases.
IBANs are redacted only when the mod-97 checksum holds and cards only when they pass the Luhn check, so ordinary numbers
are left alone. PII and secrets are replaced by `[EMAIL]`, `[PHONE]`, `[IBAN]`, `[CARD]` or `[SECRET]`, or block the
text with `piiAction: "block"`; injection phrases always block. The verdict `reason` names the detectors that fired,
never the matched values.

Pattern matching is a cheap first line of defence, not a classifier: phrases such as "you are now a ..." can also
appear in harmless text, and obfuscated PII is not detected.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `detect` | string[] | all | Subset of `email`, `phone`, `iban`, `card`, `apiKey`, `injection` |
| `piiAction` | `"redact"` \| `"block"` | `"redact"` | Action for email, phone, IBAN, card and apiKey hits |
| `stages` | string[] | all | Stages the guard runs at: `input`, `output`, `tool_args`, `tool_result` |
| `custom` | object[] | `[]` | Extra rules `{ name, pattern, flags?, action }`; a redacted match becomes `[NAME]` |

```json
{
  "layers": {
    "guardrails": [
      {
        "adapter": "regex-guard",
        "options": {
          "detect": ["email", "card", "apiKey", "injection"],
          "stages": ["input", "output", "tool_result"],
          "custom": [{ "name": "ticket", "pattern": "TCK-\\d{6}", "action": "redact" }]
        }
      }
    ]
  }
}
```
