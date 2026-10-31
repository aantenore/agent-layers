import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { adapter as basicRuntime } from '@agent-layers/adapter-basic-runtime';
import { createMcpKnowledge, knowledgeAdapter as mcpKnowledge } from '@agent-layers/adapter-mcp';
import { adapter as markdownKnowledge, createMarkdownKnowledge } from '@agent-layers/adapter-markdown-knowledge';
import { adapter as mockModel } from '@agent-layers/adapter-mock-model';
import { checkAdapter } from '@agent-layers/conformance';
import { compose, resolveProfile } from '@agent-layers/core';
import { reachable } from '../../../lib/wait.mjs';
import { qdrantServer, QDRANT_COLLECTION, QDRANT_URL } from '../scripts/qdrant-server.mjs';

const layerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(layerDir, '../..');
try { process.loadEnvFile(resolve(repoRoot, '.env')); } catch { /* .env is optional */ }

const wikiDir = resolve(repoRoot, process.env.WIKI_DIR ?? 'reference/knowledge/wiki');
const qdrantOptions = { ...qdrantServer, tool: 'qdrant-find' };

const has = (cmd) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };

/** Why the Qdrant tests cannot run, or undefined when they can. */
async function qdrantSkipReason() {
  if (!(await reachable(`${QDRANT_URL}/readyz`))) return `Qdrant not reachable at ${QDRANT_URL}; run "make up LAYER=knowledge"`;
  if (!has('uvx')) return 'uvx is not installed (needed to start mcp-server-qdrant)';
}

/** Loads the sample docs when the collection is missing or empty (idempotent: ingest recreates the collection). */
async function ensureIngested() {
  const res = await fetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}`).catch(() => undefined);
  const points = res?.ok ? (await res.json()).result?.points_count : 0;
  if (points > 0) return;
  execFileSync('node', [resolve(layerDir, 'scripts/ingest.mjs')], { stdio: 'inherit', timeout: 600_000, env: process.env });
}

test('knowledge: wiki source conforms to the KnowledgePort contract', async () => {
  const report = await checkAdapter(markdownKnowledge, {
    options: { dir: wikiDir },
    fixtures: { query: 'Quillmere harbour tide gate closes', expectText: '19:40', filter: { file: 'harbour.md' } },
  });
  assert.deepEqual(report.failures, []);

  const wiki = createMarkdownKnowledge({ dir: wikiDir });
  const hits = await wiki.search({ text: 'When does the Zorblax tide gate close?', k: 3 });
  assert.ok(hits.some((p) => p.id === 'harbour.md#tide-gate'), `passage ids: ${hits.map((p) => p.id).join(', ')}`);
});

test('knowledge: Qdrant source (mcp-server-qdrant) conforms to the KnowledgePort contract', { timeout: 700_000 }, async (t) => {
  const reason = await qdrantSkipReason();
  if (reason) return t.skip(`SKIPPED: ${reason}`);
  await ensureIngested();
  const report = await checkAdapter(mcpKnowledge, {
    options: qdrantOptions,
    fixtures: { query: 'How often does the Aurelian Archive rotate its vault code?', expectText: '13 days', filter: { path: 'vault-protocol.md' } },
    limits: { timeoutMs: 120_000 },
  });
  assert.deepEqual(report.failures, []);

  const docs = createMcpKnowledge(qdrantOptions, { name: 'docs' });
  try {
    const hits = await docs.search({ text: 'How often does the Aurelian Archive rotate its vault code?', k: 3 });
    assert.ok(hits.some((p) => p.id === 'vault-protocol.md#rotation'), `passage ids: ${hits.map((p) => p.id).join(', ')}`);
  } finally {
    await docs.close();
  }
});

test('knowledge: an agent answers fictional facts through auto-retrieval', { timeout: 700_000 }, async (t) => {
  const reason = await qdrantSkipReason();
  const withQdrant = !reason;
  if (withQdrant) await ensureIngested();

  const searches = [];
  const recorder = {
    name: 'recorder',
    span: async (name, attrs, fn) => { searches.push({ name, attrs }); return fn({ setAttributes() {}, setAttribute() {}, end() {} }); },
    event() {},
    metric() {},
  };
  const config = {
    layers: {
      model: { adapter: 'mock-model' },
      runtime: { adapter: 'basic-runtime', options: { maxTurns: 3 } },
      knowledge: {
        wiki: { adapter: 'markdown-knowledge', options: { dir: wikiDir } },
        ...(withQdrant ? { docs: { adapter: 'mcp', options: qdrantOptions } } : {}),
      },
    },
    agents: {
      'wiki-librarian': { instructions: 'Answer from the reference material only.', model: 'mock', knowledge: ['wiki'] },
      ...(withQdrant ? { 'docs-librarian': { instructions: 'Answer from the reference material only.', model: 'mock', knowledge: ['docs'] } } : {}),
    },
  };
  const stack = await compose(resolveProfile(config), { adapters: [mockModel, basicRuntime, markdownKnowledge, mcpKnowledge], telemetry: [recorder] });
  try {
    const cases = [
      { agent: 'wiki-librarian', question: 'At what time does the Zorblax tide gate close in the evening?', expect: /19:40/, from: 'wiki' },
      ...(withQdrant
        ? [{ agent: 'docs-librarian', question: 'Every how many days does the vault code of the Aurelian Archive rotate?', expect: /\b13\b|thirteen/i, from: 'docs' }]
        : []),
    ];
    for (const c of cases) {
      searches.length = 0;
      const res = await (await stack.agent(c.agent)).run(c.question);
      assert.equal(res.status, 'completed', `status ${res.status}`);
      assert.match(res.output, c.expect, `answer lacks the fact: ${res.output}`);
      assert.ok(searches.some((s) => s.name === 'agent.knowledge.search' && s.attrs['agent.knowledge.source'] === c.from), `no knowledge search span for ${c.from}`);
    }
  } finally {
    await stack.close();
  }
  if (!withQdrant) t.diagnostic(`Qdrant half skipped: ${reason}`);
});
