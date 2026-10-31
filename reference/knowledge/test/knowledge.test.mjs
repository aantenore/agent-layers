import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { reinloop } from '../../../lib/reinloop.mjs';
import { reachable } from '../../../lib/wait.mjs';
import { qdrantServer, QDRANT_COLLECTION, QDRANT_URL } from '../scripts/qdrant-server.mjs';

const layerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(layerDir, '../..');
try { process.loadEnvFile(resolve(repoRoot, '.env')); } catch { /* .env is optional */ }

const wikiDir = resolve(repoRoot, process.env.WIKI_DIR ?? 'reference/knowledge/wiki');
const llmBase = (process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1').replace(/\/$/, '');
const llmModel = process.env.LLM_MODEL ?? 'qwen3:4b';

const qdrantUp = () => reachable(`${QDRANT_URL}/readyz`);

/** Loads the sample docs when the collection is missing or empty (idempotent: ingest recreates the collection). */
async function ensureIngested() {
  const res = await fetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}`).catch(() => undefined);
  const points = res?.ok ? (await res.json()).result?.points_count : 0;
  if (points > 0) return;
  execFileSync('node', [resolve(layerDir, 'scripts/ingest.mjs')], { stdio: 'inherit', timeout: 600_000, env: process.env });
}

async function llmSkipReason() {
  try {
    const res = await fetch(`${llmBase}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return `LLM endpoint ${llmBase} answered HTTP ${res.status}`;
    const ids = ((await res.json()).data ?? []).map((m) => m.id);
    if (!ids.includes(llmModel)) return `model "${llmModel}" is not available at ${llmBase}; run "ollama pull ${llmModel}"`;
  } catch {
    return `Ollama not reachable at ${llmBase}; start it with "ollama serve"`;
  }
}

test('knowledge: wiki source conforms to the KnowledgeSource contract', async () => {
  const failures = await reinloop.checkKnowledgeSource(reinloop.wikiKnowledge({ dir: wikiDir }), {
    query: 'When does the Zorblax tide gate close?',
    expectId: 'harbour.md#tide-gate',
  });
  assert.deepEqual(failures, []);
});

test('knowledge: Qdrant source (mcp-server-qdrant) conforms to the KnowledgeSource contract', { timeout: 700_000 }, async (t) => {
  if (!(await qdrantUp())) return t.skip(`SKIPPED: Qdrant not reachable at ${QDRANT_URL}; run "make up LAYER=knowledge"`);
  await ensureIngested();
  const source = reinloop.mcpKnowledge({
    name: 'docs',
    tool: 'qdrant-find',
    connect: () => reinloop.McpClient.connect('qdrant', qdrantServer),
  });
  try {
    const failures = await reinloop.checkKnowledgeSource(source, {
      query: 'How often does the Aurelian Archive rotate its vault code?',
      expectId: 'vault-protocol.md#rotation',
    });
    assert.deepEqual(failures, []);
  } finally {
    await source.close();
  }
});

test('knowledge: an agent answers fictional facts through auto-retrieval', { timeout: 600_000 }, async (t) => {
  const reason = await llmSkipReason();
  if (reason) return t.skip(`SKIPPED: ${reason}`);
  const withQdrant = await qdrantUp();
  if (withQdrant) await ensureIngested();

  const env = { ...process.env, REINLOOP_MODEL: `ollama/${llmModel}`, OLLAMA_BASE_URL: llmBase };
  const { config, baseDir } = await reinloop.loadConfig(resolve(layerDir, 'reinloop.json'), { env });
  config.knowledge.sources.wiki.dir = wikiDir;
  if (!withQdrant) delete config.knowledge.sources.docs;
  const runtime = await reinloop.createRuntime(config, { env, baseDir });
  try {
    const cases = [
      { sink: reinloop.collectSink(), question: 'At what time does the Zorblax tide gate close in the evening?', expect: /19:40/, from: 'wiki', id: 'harbour.md#tide-gate' },
      ...(withQdrant
        ? [{ sink: reinloop.collectSink(), question: 'Every how many days does the vault code of the Aurelian Archive rotate?', expect: /\b13\b|thirteen/i, from: 'docs', id: 'vault-protocol.md#rotation' }]
        : []),
    ];
    for (const c of cases) {
      const res = await runtime.run('librarian', c.question, { sinks: [c.sink] });
      assert.equal(res.status, 'completed', `status ${res.status}: ${res.reason ?? ''}`);
      assert.match(res.output, c.expect, `answer lacks the fact: ${res.output}`);
      const retrieved = c.sink.events.filter((e) => e.type === 'knowledge_retrieval' && e.data.source === c.from);
      assert.ok(retrieved.some((e) => e.data.ids.includes(c.id)), `no knowledge_retrieval event with ${c.id}`);
    }
  } finally {
    await runtime.close();
  }
});
