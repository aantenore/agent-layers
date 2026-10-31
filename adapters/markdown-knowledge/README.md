# @agent-layers/adapter-markdown-knowledge

Maps **Markdown files** → **KnowledgePort** (layer `knowledge`). Tier: prototype, production.

Reads the Markdown files below a directory, splits them into chunks at `#`, `##` and `###` headings and ranks the chunks
with BM25, giving extra weight to query terms that appear in the heading. Each passage carries the heading path
(for example `Port of Quillmere > Tide gate`), its file as `source`, and `metadata` with `file`, `heading` and `title`.
Files are read on the first search and cached; call `refresh()` on the instance to reload them. The query filter
`{ "source": "guide/*" }` takes one glob or an array of globs over the relative file path.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `dir` | string | required | Directory with the Markdown files, relative to the config directory |
| `extensions` | string[] | `[".md"]` | File extensions to load |
| `k` | integer | `4` | Passages returned when the query does not set `k` |

Limits accept `${env:NAME}`. Ranges and checks: [docs/limits.md](../../docs/limits.md).

```json
{
  "layers": {
    "knowledge": {
      "wiki": { "adapter": "markdown-knowledge", "options": { "dir": "docs/wiki", "k": 5 } }
    }
  }
}
```
