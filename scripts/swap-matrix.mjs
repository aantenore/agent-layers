// Layer swap matrix: proves a layer is replaced by changing only configuration. Each cell of examples/swap/cells.json
// becomes a temporary profile that extends the base project's `test` profile and overrides the cell's slot(s); the CLI
// then runs `check` and `eval` on it, and the telemetry of the run shows whether the replacement adapter really ran.
//
//   node scripts/swap-matrix.mjs                       every cell without needs
//   node scripts/swap-matrix.mjs --only state-sqlite,guard-none
//   node scripts/swap-matrix.mjs --with docker,uv      also cells that need any docker service and uv (docker:<service> for one)
//   node scripts/swap-matrix.mjs --all                 every cell, whatever it needs
//   node scripts/swap-matrix.mjs --list                print the cells and their needs, then exit
//
// Cell: { id, layer, value | layers, description, needs?, observe? }. `value` is the replacement of the slot `layer`
// (null removes an optional slot); `layers` overrides several slots at once. `needs` entries are `docker:<service>`,
// `uv` or `model`; a cell with needs is skipped unless `--with` names them (`docker` covers every `docker:*`) or `--all`.
// `observe` says how the swap is seen in the run, one of:
//   { span, attr, equals }   a span of that name carries attr = equals in the telemetry written during the cell
//   { span, absent: true }   no span of that name was written
//   { output: "<regex>" }    the CLI output matches (for cells that replace the telemetry adapter)
//   { file: "<path>" }       the file exists after the run (path relative to the project folder; removed beforehand)
// A cell without `observe` is reported as "not observable": nothing in the run identifies its adapter.
// The base project is examples/minimal. Results go to examples/swap/.agent-layers/results.json and results.md.
// Exit code 1 when a selected cell fails.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readSync, closeSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readJson, rel, ROOT } from './lib/common.mjs';

const PROJECT = join(ROOT, 'examples', 'minimal');
const CELLS = join(ROOT, 'examples', 'swap', 'cells.json');
const OUT = join(ROOT, 'examples', 'swap', '.agent-layers');
const CLI = join(ROOT, 'packages', 'cli', 'src', 'cli.ts');
const NODE_ARGS = ['--conditions=@agent-layers/source', '--disable-warning=ExperimentalWarning'];
const CONFIG = 'agent-layers.json';
const TMP_CONFIG = 'agent-layers.swap.json';
const BASE_PROFILE = 'test';
const PROFILE_PREFIX = 'swap-';
const DATASET = 'evals/smoke.jsonl';
const MIN_SCORE = '1';
const TIMEOUT_S = Number(process.env.SWAP_TIMEOUT_S ?? 120);
const ERROR_LINE = /error|fail|cannot|not |invalid|unknown|refused|timeout|✗|✖/i;

const { values: opts } = parseArgs({
  options: { only: { type: 'string' }, with: { type: 'string' }, all: { type: 'boolean' }, list: { type: 'boolean' } },
  strict: true,
});
const csv = (s) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

const cells = readJson(CELLS);
const base = readJson(join(PROJECT, CONFIG));
const agent = Object.keys(base.agents)[0];
const slots = (cell) => cell.layers ?? { [cell.layer]: cell.value };

/** Layers of a profile with its `extends` chain applied (a child slot replaces the parent's; null removes it). */
function profileLayers(name, seen = []) {
  const p = base.profiles[name];
  if (!p || seen.includes(name)) return {};
  return { ...(p.extends ? profileLayers(p.extends, [...seen, name]) : {}), ...(p.layers ?? {}) };
}

/** Short label of a slot value: adapter names, `none` when empty or removed; knowledge maps list name:adapter. */
function label(v) {
  if (v == null || (Array.isArray(v) && !v.length)) return 'none';
  if (Array.isArray(v)) return v.map(label).join(' + ');
  if (typeof v.adapter === 'string') return v.adapter;
  return Object.entries(v).map(([k, x]) => `${k}:${label(x)}`).join(' + ');
}
const side = (layers) => Object.keys(layers).map((k) => `${k}=${label(layers[k])}`).join(', ');
const baseLayers = profileLayers(BASE_PROFILE);
const change = (cell) => {
  const to = slots(cell);
  return { from: side(Object.fromEntries(Object.keys(to).map((k) => [k, baseLayers[k]]))), to: side(to) };
};

if (opts.list) {
  for (const c of cells) console.log(`${c.id.padEnd(26)} ${Object.keys(slots(c)).join('+').padEnd(26)} ${(c.needs ?? []).join(',') || '-'}`);
  process.exit(0);
}

const only = csv(opts.only);
const unknown = only.filter((id) => !cells.some((c) => c.id === id));
if (unknown.length) { console.error(`swap-matrix: unknown cell(s): ${unknown.join(', ')}`); process.exit(2); }
const provided = csv(opts.with);
const satisfied = (need) => opts.all || provided.includes(need) || provided.includes(need.split(':')[0]);
const selected = cells.filter((c) => !only.length || only.includes(c.id));

/** Bytes appended to `file` after `offset`, as text. */
function readFrom(file, offset) {
  if (!existsSync(file)) return '';
  const size = statSync(file).size;
  const buf = Buffer.alloc(Math.max(0, size - offset));
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); }
  return buf.toString('utf8');
}
const sizeOf = (file) => (existsSync(file) ? statSync(file).size : 0);

/** The telemetry file the base test profile writes (read by offset, so earlier content is left alone). */
const jsonl = baseLayers.telemetry?.find((t) => t.adapter === 'jsonl-telemetry')?.options?.path;
const telemetryFile = jsonl ? resolve(PROJECT, jsonl) : undefined;

function cli(argv) {
  const r = spawnSync(process.execPath, [...NODE_ARGS, CLI, ...argv], { cwd: PROJECT, encoding: 'utf8', timeout: TIMEOUT_S * 1000, killSignal: 'SIGKILL' });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error?.code === 'ETIMEDOUT') return { ok: false, output, error: `timeout after ${TIMEOUT_S}s` };
  if (r.error) return { ok: false, output, error: r.error.message };
  return { ok: r.status === 0, output, error: r.status === 0 ? '' : firstError(output) };
}

/** First line that reports a problem, else the last line of the output. */
function firstError(output) {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => ERROR_LINE.test(l)) ?? lines.at(-1) ?? 'no output').slice(0, 300);
}

/** Checks the cell's `observe` rule against the run. Returns { state: 'seen' | 'missing' | 'n/a' | 'not observable', note }. */
function observe(cell, run) {
  const o = cell.observe;
  if (!o) return { state: 'not observable', note: 'no attribute identifies this adapter' };
  if (o.file) {
    const seen = existsSync(resolve(PROJECT, o.file));
    return { state: seen ? 'seen' : 'missing', note: `${o.file} ${seen ? 'created' : 'not created'}` };
  }
  if (o.output) {
    const seen = new RegExp(o.output).test(run.output);
    return { state: seen ? 'seen' : 'missing', note: `output ${seen ? 'matches' : 'does not match'} /${o.output}/` };
  }
  if ('telemetry' in slots(cell) || !telemetryFile) return { state: 'n/a', note: 'telemetry file is not written in this cell' };
  const spans = run.telemetry.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r?.type === 'span' && r.name === o.span);
  if (o.absent) return { state: spans.length ? 'missing' : 'seen', note: `${spans.length} ${o.span} span(s) written` };
  const seen = spans.some((s) => s.attrs?.[o.attr] === o.equals);
  return { state: seen ? 'seen' : 'missing', note: `${o.attr}=${o.equals} on ${o.span}: ${seen ? 'found' : `not found in ${spans.length} span(s)`}` };
}

/** Profile of one cell: extends the base test profile and overrides only the cell's slots. */
const profileOf = (cell) => ({ description: cell.description, extends: BASE_PROFILE, layers: slots(cell) });

function runCell(cell) {
  const profile = `${PROFILE_PREFIX}${cell.id}`;
  const tmp = join(PROJECT, TMP_CONFIG);
  const evalOut = join(OUT, 'eval', `${cell.id}.jsonl`);
  const result = { id: cell.id, layer: Object.keys(slots(cell)).join('+'), ...change(cell), description: cell.description, status: 'pass', check: '-', eval: '-', observed: '-', note: '' };
  const started = Date.now();
  try {
    writeFileSync(tmp, `${JSON.stringify({ ...base, profiles: { ...base.profiles, [profile]: profileOf(cell) } }, null, 2)}\n`);
    if (cell.observe?.file) for (const suffix of ['', '-wal', '-shm']) rmSync(resolve(PROJECT, cell.observe.file) + suffix, { force: true });
    mkdirSync(join(OUT, 'eval'), { recursive: true });
    const common = ['--config', TMP_CONFIG, '--profile', profile];

    const check = cli(['check', ...common]);
    result.check = check.ok ? 'pass' : 'fail';
    if (!check.ok) return { ...result, status: 'fail', note: `check: ${check.error}` };

    const offset = telemetryFile ? sizeOf(telemetryFile) : 0;
    const ev = cli(['eval', DATASET, '--agent', agent, ...common, '--out', evalOut, '--min', MIN_SCORE]);
    result.eval = ev.ok ? 'pass' : 'fail';
    if (!ev.ok) return { ...result, status: 'fail', note: `eval: ${ev.error}` };

    const seen = observe(cell, { output: ev.output, telemetry: telemetryFile ? readFrom(telemetryFile, offset) : '' });
    result.observed = seen.state;
    result.note = seen.note;
    if (seen.state === 'missing') return { ...result, status: 'fail', note: `adapter not observed: ${seen.note}` };
    return result;
  } finally {
    rmSync(tmp, { force: true });
    result.durationMs = Date.now() - started;
  }
}

// The temporary config must not outlive the run, even when it is interrupted.
const cleanup = () => rmSync(join(PROJECT, TMP_CONFIG), { force: true });
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

const results = [];
for (const cell of selected) {
  const missing = (cell.needs ?? []).filter((n) => !satisfied(n));
  let r;
  if (missing.length) {
    r = { id: cell.id, layer: Object.keys(slots(cell)).join('+'), ...change(cell), description: cell.description, status: 'skipped', check: '-', eval: '-', observed: '-', note: `needs ${missing.join(', ')}` };
  } else {
    r = runCell(cell);
  }
  results.push(r);
  console.log(`${r.status.padEnd(7)} ${r.id}${r.status === 'pass' ? ` (${r.observed})` : r.note ? `: ${r.note}` : ''}`);
}

const cellRow = (r) => `| ${r.id} | ${r.layer} | ${r.from} → ${r.to} | ${r.status === 'skipped' ? 'skipped' : r.check} | ${r.status === 'skipped' ? 'skipped' : r.eval} | ${r.observed} | ${r.note.replace(/\|/g, '\\|')} |`;
const count = (s) => results.filter((r) => r.status === s).length;
const md = [
  '# Layer swap matrix',
  '',
  `Base: \`${rel(PROJECT)}\`, profile \`${BASE_PROFILE}\`, agent \`${agent}\`, dataset \`${DATASET}\`. ${count('pass')} passed, ${count('fail')} failed, ${count('skipped')} skipped.`,
  '',
  '| Cell | Layer | From → to | Check | Eval | Adapter observed | Note |',
  '|---|---|---|---|---|---|---|',
  ...results.map(cellRow),
  '',
].join('\n');
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'results.json'), `${JSON.stringify({ base: { project: rel(PROJECT), profile: BASE_PROFILE, agent, dataset: DATASET }, results }, null, 2)}\n`);
writeFileSync(join(OUT, 'results.md'), md);
console.log(`${count('pass')} passed, ${count('fail')} failed, ${count('skipped')} skipped -> ${rel(join(OUT, 'results.md'))}`);
process.exit(count('fail') ? 1 : 0);
