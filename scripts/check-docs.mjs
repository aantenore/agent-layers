#!/usr/bin/env node
// Keeps the documentation aligned with the code. Zero dependencies; exits 1 with a short report on any error.
//
//   npm run docs:check        (also: make docs-check, CI lint job)
//
// Checks
//   links    relative Markdown links and #anchors resolve
//   layers   layer ids, numbers, names, questions and planes in docs match LAYERS (packages/core)
//   ports    every PORTS entry has a spec page with the same layer and version; every page is a port;
//            port names used in docs exist
//   env      .env.example, the environment table in docs/contracts.md and reference/*/compose.yml defaults agree
//   catalog  the adapter catalog in docs/adapters.md equals what scripts/gen-adapters-catalog.mjs generates
//   stale    forbidden strings: old paths, old layer folder names, old model name, assistant-tooling mentions
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ensureSourceCondition, importSource, proseLines, read, rel, ROOT, walk } from './lib/common.mjs';

ensureSourceCondition(import.meta.url);

const problems = new Map();
const warnings = [];
const fail = (check, file, line, msg) => {
  if (!problems.has(check)) problems.set(check, []);
  problems.get(check).push(`${file}${line ? `:${line}` : ''} ${msg}`);
};

// ---- inputs ---------------------------------------------------------------------------------------------------

const { LAYERS, PLANES } = await importSource('packages/core/src/layers.ts');
const { PORTS } = await importSource('packages/core/src/ports/catalog.ts');
const ids = LAYERS.map((l) => l.layer);
const byId = new Map(LAYERS.map((l) => [l.layer, l]));
const byNumber = new Map(LAYERS.map((l) => [l.number, l]));
const ID_RE = ids.join('|');
const baseName = (l) => l.name.replace(/\s*\(.*\)$/, '');
const planeName = new Map(PLANES.map((p) => [p.plane, p.name]));
const planeLabels = (l) => {
  const long = planeName.get(l.plane);
  return [long, long.replace(/ plane$/, ''), l.plane[0].toUpperCase() + l.plane.slice(1)];
};
const allPlaneLabels = new Set(LAYERS.flatMap(planeLabels));

const all = walk(ROOT).filter((f) => !f.endsWith('package-lock.json'));
const TEXT_EXT = /\.(md|mjs|js|ts|json|ya?ml|tf|sh|rego|jq|tpl|hcl|mk)$|(^|\/)(Makefile|CODEOWNERS|\.env\.example|\.gitignore)$/;
const texts = all.filter((f) => TEXT_EXT.test(rel(f)) && !rel(f).startsWith('scripts/check-docs'));
const markdown = all.filter((f) => f.endsWith('.md'));
const cache = new Map();
const lines = (f) => cache.get(f) ?? cache.set(f, read(f).split('\n')).get(f);

// ---- markdown helpers -----------------------------------------------------------------------------------------

const stripMd = (s) => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
const isRow = (line) => /^\s*\|.*\|\s*$/.test(line) && !/^\s*\|[\s:|-]+\|\s*$/.test(line);

/** GitHub-style heading slugs of a Markdown file, with -1, -2 suffixes for repeats. */
function anchorsOf(file) {
  const seen = new Map();
  const out = new Set();
  for (const line of proseLines(read(file))) {
    const m = line === null ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const slug = stripMd(m[1]).toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    out.add(n ? `${slug}-${n}` : slug);
  }
  return out;
}
const anchorCache = new Map();
const anchors = (f) => anchorCache.get(f) ?? anchorCache.set(f, anchorsOf(f)).get(f);

// ---- links ----------------------------------------------------------------------------------------------------

for (const file of markdown) {
  const text = proseLines(read(file));
  text.forEach((raw, i) => {
    if (raw === null) return;
    const line = raw.replace(/`[^`]*`/g, '');
    const targets = [...line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
    const def = /^\s*\[[^\]]+\]:\s*(\S+)/.exec(line);
    if (def) targets.push(def[1]);
    for (const target of targets) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('<')) continue;
      const [rawPath, anchor] = target.split('#');
      let path;
      try { path = decodeURIComponent(rawPath.split('?')[0]); } catch { path = rawPath; }
      const dest = path === '' ? file : resolve(path.startsWith('/') ? ROOT : dirname(file), path.replace(/^\//, ''));
      if (!existsSync(dest)) { fail('links', rel(file), i + 1, `broken link: ${target}`); continue; }
      if (anchor && dest.endsWith('.md') && statSync(dest).isFile() && !anchors(dest).has(decodeURIComponent(anchor).toLowerCase())) {
        fail('links', rel(file), i + 1, `missing anchor: ${target}`);
      }
    }
  });
}

// ---- layers ---------------------------------------------------------------------------------------------------

const questionOwner = new Map(LAYERS.map((l) => [l.question, l.layer]));
const afterRe = new RegExp(`^\\s*\`?(${ID_RE})\\b`);
const beforeRe = new RegExp(`\`?\\b(${ID_RE})\\b\`?\\s*[(,]\\s*$`);
const tickIdRe = new RegExp(`\`(${ID_RE})\``, 'g');

for (const file of markdown) {
  proseLines(read(file)).forEach((line, i) => {
    if (line === null) return;
    const where = [rel(file), i + 1];
    const row = isRow(line) ? splitRow(line) : null;
    for (const m of line.matchAll(/(?<![\w`-])L(\d+)(?![\w`])/g)) {
      const n = Number(m[1]);
      const id = afterRe.exec(line.slice(m.index + m[0].length))?.[1]
        ?? beforeRe.exec(line.slice(0, m.index))?.[1]
        ?? (row?.includes(`L${n}`) ? [...line.matchAll(tickIdRe)][0]?.[1] : undefined);
      if (!id) fail('layers', ...where, `L${n} is not tied to a layer id (write "L${n} <id>" or "\`<id>\` (L${n})")`);
      else if (byId.get(id).number !== n) fail('layers', ...where, `\`${id}\` is L${byId.get(id).number}, not L${n}`);
    }
    if (!row) return;
    const rowIds = new Set([...line.matchAll(tickIdRe)].map((m) => m[1]));
    if (rowIds.size !== 1) return;
    const id = [...rowIds][0];
    const layer = byId.get(id);
    for (const cell of row) {
      const text = stripMd(cell);
      const owner = questionOwner.get(text);
      if (owner && owner !== id) fail('layers', ...where, `question "${text}" belongs to \`${owner}\`, not \`${id}\``);
      if (allPlaneLabels.has(text) && !planeLabels(layer).includes(text)) fail('layers', ...where, `plane "${text}" does not match \`${id}\` (${planeLabels(layer)[0]})`);
      const named = row.some((c) => questionOwner.has(stripMd(c))) && new RegExp(`^(.+?)\\s*\\(\`${id}\`[,)]`).exec(cell);
      if (named && !stripMd(named[1]).includes(baseName(layer))) fail('layers', ...where, `layer name "${stripMd(named[1])}" should contain "${baseName(layer)}" for \`${id}\``);
    }
    for (const port of new Set(line.match(/\b[A-Z][A-Za-z]+Port\b/g) ?? [])) {
      if (PORTS[port] && PORTS[port].layer !== id) fail('layers', ...where, `${port} belongs to \`${PORTS[port].layer}\`, not \`${id}\``);
    }
  });
}

// ---- ports ----------------------------------------------------------------------------------------------------

const specDir = join(ROOT, 'spec/ports');
const pages = new Set(readdirSync(specDir).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => f.replace(/\.md$/, '')));
for (const port of Object.keys(PORTS)) if (!pages.has(port)) fail('ports', 'spec/ports', null, `${port} has no page ${port}.md`);
for (const page of pages) if (!PORTS[page]) fail('ports', `spec/ports/${page}.md`, null, 'page is not a port in packages/core PORTS');
for (const port of Object.keys(PORTS)) {
  if (!pages.has(port)) continue;
  const file = join(specDir, `${port}.md`);
  const m = /^Layer: `(\w+)` \(L(\d+) (.+?)\) · Version: (\S+)/m.exec(read(file));
  const info = PORTS[port];
  const layer = byId.get(info.layer);
  if (!m) { fail('ports', rel(file), null, 'missing "Layer: `<id>` (L<n> <name>) · Version: <v>" line'); continue; }
  if (m[1] !== info.layer) fail('ports', rel(file), null, `layer \`${m[1]}\`, core says \`${info.layer}\``);
  if (Number(m[2]) !== layer.number || m[3] !== layer.name) fail('ports', rel(file), null, `"L${m[2]} ${m[3]}" should be "L${layer.number} ${layer.name}"`);
  if (m[4] !== info.version) fail('ports', rel(file), null, `version ${m[4]}, core says ${info.version}`);
}
for (const file of markdown) {
  lines(file).forEach((line, i) => {
    if (isRow(line)) {
      const m = /\[(\w+Port)\]\(\1\.md\)/.exec(line);
      if (m && PORTS[m[1]]) {
        const cells = splitRow(line).map(stripMd);
        const version = cells.find((c) => /^\d+\.\d+\.\d+$/.test(c));
        if (version && version !== PORTS[m[1]].version) fail('ports', rel(file), i + 1, `${m[1]} is ${PORTS[m[1]].version}, not ${version}`);
        if (cells.length > 3 && !cells.includes(PORTS[m[1]].description)) fail('ports', rel(file), i + 1, `${m[1]} description differs from core`);
      }
    }
  });
  const flat = read(file);
  for (const port of new Set(flat.match(/\b[A-Z][A-Za-z]+Port\b/g) ?? [])) {
    if (!PORTS[port] && !['TriggerHandle'].includes(port)) {
      const idx = lines(file).findIndex((l) => l.includes(port));
      fail('ports', rel(file), idx + 1, `unknown port name ${port}`);
    }
  }
}

// ---- env ------------------------------------------------------------------------------------------------------

{
  const envLines = lines(join(ROOT, '.env.example'));
  const env = new Map();
  let section = null;
  for (const line of envLines) {
    const head = new RegExp(`^#\\s+(${ID_RE})\\b`).exec(line);
    if (head) section = head[1];
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) env.set(m[1], { value: m[2], layer: section });
  }
  const contracts = join(ROOT, 'docs/contracts.md');
  const docLines = lines(contracts);
  const tableOf = (headingRe) => {
    const start = docLines.findIndex((l) => headingRe.test(l));
    const out = new Map();
    if (start < 0) { fail('env', 'docs/contracts.md', null, `section ${headingRe} not found`); return out; }
    for (let i = start + 1; i < docLines.length; i++) {
      const h = /^(#+)\s/.exec(docLines[i]);
      if (h) break;
      if (!isRow(docLines[i])) continue;
      const [layer, name, value] = splitRow(docLines[i]).map((c) => c.replace(/^`|`$/g, ''));
      if (/^[A-Z][A-Z0-9_]*$/.test(name)) out.set(name, { layer, value, line: i + 1 });
    }
    return out;
  };
  const main = tableOf(/^## Host ports and environment/);
  const extra = tableOf(/^### Compose overrides/);
  for (const [name, e] of env) {
    const d = main.get(name);
    if (!d) fail('env', 'docs/contracts.md', null, `${name} is in .env.example but not in the environment table`);
    else {
      if (d.value !== e.value) fail('env', 'docs/contracts.md', d.line, `${name} default "${d.value}" differs from .env.example "${e.value}"`);
      if (d.layer !== e.layer) fail('env', 'docs/contracts.md', d.line, `${name} is under \`${d.layer}\` but .env.example puts it under \`${e.layer}\``);
    }
  }
  for (const [name, d] of main) if (!env.has(name)) fail('env', 'docs/contracts.md', d.line, `${name} is documented but not in .env.example`);

  const composeDefaults = new Map();
  for (const file of all.filter((f) => /reference\/[^/]+\/compose\.yml$/.test(f))) {
    for (const m of read(file).matchAll(/\$\{([A-Z][A-Z0-9_]*):-([^}]*)\}/g)) {
      if (!composeDefaults.has(m[1])) composeDefaults.set(m[1], []);
      composeDefaults.get(m[1]).push({ value: m[2], file: rel(file) });
    }
  }
  const documented = new Map([...main, ...extra]);
  for (const [name, uses] of composeDefaults) {
    const want = env.get(name)?.value ?? documented.get(name)?.value;
    if (want === undefined) continue;
    for (const u of uses) if (u.value !== want) fail('env', u.file, null, `${name} defaults to "${u.value}" here, docs and .env.example say "${want}"`);
  }
  for (const [name, d] of extra) {
    if (!composeDefaults.has(name)) fail('env', 'docs/contracts.md', d.line, `${name} is listed as a compose override but no compose file reads it`);
    if (env.has(name)) fail('env', 'docs/contracts.md', d.line, `${name} is in .env.example; list it in the main table`);
  }
  for (const file of texts) {
    lines(file).forEach((line, i) => {
      for (const m of line.matchAll(/LLM_MODEL(?::-|=)([^\s}"'`]+)/g)) {
        if (m[1] !== 'qwen3:4b') fail('env', rel(file), i + 1, `LLM_MODEL=${m[1]}, expected qwen3:4b`);
      }
    });
  }
}

// ---- catalog --------------------------------------------------------------------------------------------------

{
  const { expectedDoc, DOC } = await import('./gen-adapters-catalog.mjs');
  const expected = await expectedDoc();
  if (expected === null) fail('catalog', 'docs/adapters.md', null, 'adapters:begin / adapters:end markers not found');
  else if (expected !== read(DOC)) fail('catalog', 'docs/adapters.md', null, 'adapter catalog is out of date; run npm run docs:adapters');
  else if (/\| load error \|/.test(read(DOC))) warnings.push('docs/adapters.md lists adapters that fail to load (see "Not loaded")');
  const planned = read(DOC).split('### Planned')[1] ?? '';
  for (const row of planned.split('\n').filter((l) => l.startsWith('|'))) {
    const first = row.split('|')[1]?.trim() ?? '';
    for (const m of first.matchAll(/(?:^|, )`([a-z0-9-]+)`(?=,|$)/g)) {
      if (existsSync(join(ROOT, 'adapters', m[1]))) warnings.push(`docs/adapters.md: planned adapter "${m[1]}" exists in adapters/; move it out of Planned`);
    }
  }
}

// ---- stale strings --------------------------------------------------------------------------------------------

{
  const scoped = (f) => /^(README\.md|CONTRIBUTING\.md|CODEOWNERS|Makefile|\.env\.example|docs\/|spec\/|reference\/|examples\/|\.github\/)/.test(rel(f));
  const rules = [
    { re: /qwen2\.5:3b/, msg: '`qwen2.5:3b` (default model is qwen3:4b)', skip: (l) => /licen[sc]/i.test(l) },
    { re: /\bcontracts\//, msg: '`contracts/` path (now spec/schemas)' },
    { re: /layers\/l\d/, msg: '`layers/l<n>` path (now reference/<id>)' },
    { re: /docs\/layers\/L\d/, msg: '`docs/layers/L<n>` path (now docs/layers/<id>.md)' },
    { re: /LAYER=l\d/, msg: 'old LAYER=l<n>-* name (use the layer id)' },
    { re: /\bl\d{1,2}-(infra|llm|harness|knowledge|tools?|identity|guardrails?|cache-router|telemetry|eval)\b/, msg: 'old layer folder name' },
  ];
  for (const file of texts.filter(scoped)) {
    lines(file).forEach((line, i) => {
      for (const r of rules) if (r.re.test(line) && !(r.skip?.(line))) fail('stale', rel(file), i + 1, r.msg);
    });
  }
  const banned = [
    { re: /\bClaude\b/, msg: 'assistant name' },
    { re: /\bAnthropic\b(?! Messages|-compatible)/, msg: 'Anthropic outside the API name' },
    { re: /\bAI[- ]assistants?\b/i, msg: '"AI assistant"' },
    { re: /\bcoding[- ]agents?\b/i, msg: '"coding agent"' },
  ];
  for (const file of texts) {
    lines(file).forEach((line, i) => {
      for (const r of banned) if (r.re.test(line)) fail('stale', rel(file), i + 1, r.msg);
    });
  }
}

// ---- report ---------------------------------------------------------------------------------------------------

const ORDER = ['links', 'layers', 'ports', 'env', 'catalog', 'stale'];
let total = 0;
for (const check of ORDER) {
  const list = problems.get(check) ?? [];
  total += list.length;
  if (!list.length) continue;
  console.error(`\n[${check}] ${list.length} problem${list.length === 1 ? '' : 's'}`);
  for (const p of list.slice(0, 20)) console.error(`  ${p}`);
  if (list.length > 20) console.error(`  ... ${list.length - 20} more`);
}
for (const w of warnings) console.error(`warning: ${w}`);
if (total) {
  console.error(`\ndocs-check: ${total} problem${total === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log(`docs-check: ok (${markdown.length} Markdown files, ${warnings.length} warning${warnings.length === 1 ? '' : 's'})`);
