# @agent-layers/adapter-markdown-knowledge

Maps **Markdown files** → **KnowledgePort** (layer `knowledge`). Tier: prototype, production.

Reads the Markdown files below a directory, splits them into chunks at `#`, `##` and `###` headings and ranks the chunks
with BM25, giving extra weight to query terms that appear in the heading. Each passage text starts with the heading path
(for example `Port of Quillmere > Tide gate`); `source` is the instance name, `title` the document title, `attrs` hold
`file` (relative POSIX path) and `heading`, and `score` is the raw BM25 score (the core fuses scores across sources).
Files are read on the first search and cached; call `refresh()` on the instance to reload them. The query filter works
on `attrs`: a string is a glob (`{ "file": "guide/*" }`), a list means any of, and a passage without the key does not
match.

Mappings: `in` rules on `Passage` (instance key `knowledge.<name>`). The source document of a rule is the chunk
`{ file, slug, heading, title, body }`; for example `{ "from": "/file", "to": "/url" }`. The filter sees the mapped
`attrs`.

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
