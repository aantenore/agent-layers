import type { AgentSpec, AttrFilter, Document, IngestionPort, KnowledgePort, MemoryPort, RunEvent, RuntimePort, Stack, StatePort, ToolPort } from '@agent-layers/core';
import { Checks, testContext } from '../check.ts';
import { conforms } from '../schemas.ts';

export interface RuntimeFixtures { stack?: Stack; agent?: AgentSpec; input?: string }

export async function checkRuntime(port: RuntimePort, f: RuntimeFixtures = {}, c = new Checks()): Promise<Checks> {
  c.expect(typeof port.bind === 'function', 'bind must be a function');
  if (!f.stack || !f.agent) { c.skip('run: needs a stack and an agent fixture'); return c; }
  const agent = await c.attempt('bind', () => port.bind(f.stack!, f.agent!));
  if (!agent) return c;
  c.expect(agent.name === f.agent.name, 'bind: agent name must match the spec');
  const result = await c.attempt('run', () => agent.run(f.input ?? 'hello', testContext({ agent: f.agent!.name })));
  if (result) {
    c.all(conforms('run-result', result), 'run result');
    if (result.status !== 'completed') c.expect(typeof result.reason?.code === 'string' && result.reason.code.length > 0, `run: status ${result.status} needs a reason with a code`);
    c.produced('run', result);
  }
  return c;
}

export async function checkState(port: StatePort, _f: unknown = {}, c = new Checks()): Promise<Checks> {
  const id = `conformance-${Date.now()}`;
  const events: RunEvent[] = [{ type: 'run.start', runId: id, agent: 'conformance' }, { type: 'run.end', status: 'completed' }];
  await c.attempt('append', () => port.append(id, events.slice(0, 1)));
  await c.attempt('append again', () => port.append(id, events.slice(1)));
  const read = await c.attempt('read', () => port.read(id));
  c.expect(JSON.stringify(read) === JSON.stringify(events), 'read: must return appended events in order');
  c.produced('read', read);
  c.expect((await c.attempt('read unknown', () => port.read(`${id}-missing`)))?.length === 0, 'read: unknown session must be empty');
  c.expect((await c.attempt('list', () => port.list()))?.includes(id), 'list: must include the session');
  await c.attempt('delete', () => port.delete(id));
  c.expect((await c.attempt('read deleted', () => port.read(id)))?.length === 0, 'delete: events still present');
  return c;
}

export interface KnowledgeFixtures {
  query?: string;
  /** A passage among the results must contain this text. */
  expectText?: string;
  /** A filter on `attrs` that must narrow the result. */
  filter?: AttrFilter;
}

export async function checkKnowledge(port: KnowledgePort, f: KnowledgeFixtures = {}, c = new Checks()): Promise<Checks> {
  const text = f.query ?? 'test';
  const all = await c.attempt('search', () => port.search({ text, k: 5 }));
  if (!all) return c;
  if (!c.expect(Array.isArray(all), 'search: must resolve to an array')) return c;
  all.forEach((p, i) => c.all(conforms('passage', p), `passage[${i}]`));
  c.produced('search', all);
  c.expect(all.length <= 5, `search: returned ${all.length} passages for k=5`);
  const one = await c.attempt('search k=1', () => port.search({ text, k: 1 }));
  c.expect(!one || one.length <= 1, 'search: must respect k');
  if (f.expectText) c.expect(all.some((p) => p.text.includes(f.expectText!)), `search: no passage contains "${f.expectText}"`);
  if (f.filter) {
    const narrowed = await c.attempt('search with filter', () => port.search({ text, k: 5, filter: f.filter }));
    c.expect(!narrowed || narrowed.length < all.length || all.length === 0, 'filter: returned as many passages as without it');
  }
  return c;
}

export async function checkMemory(port: MemoryPort, _f: unknown = {}, c = new Checks()): Promise<Checks> {
  const scope = { caller: `conformance-${Date.now()}`, agent: 'conformance' };
  const ids = await c.attempt('remember', () => port.remember([{ text: 'The conformance parrot is called Quillby.' }], scope));
  c.expect(ids?.length === 1, 'remember: must return one id per item');
  const hits = await c.attempt('recall', () => port.recall({ text: 'parrot Quillby', scope }));
  c.expect(hits?.some((p) => p.text.includes('Quillby')), 'recall: remembered item not found');
  hits?.forEach((p, i) => c.all(conforms('passage', p), `recall passage[${i}]`));
  c.produced('recall', hits);
  const other = await c.attempt('recall other caller', () => port.recall({ text: 'parrot Quillby', scope: { ...scope, caller: `${scope.caller}-other` } }));
  c.expect(!other?.some((p) => p.text.includes('Quillby')), 'recall: leaked across callers');
  if (ids?.length) {
    await c.attempt('forget', () => port.forget(ids, scope));
    const after = await c.attempt('recall after forget', () => port.recall({ text: 'parrot Quillby', scope }));
    c.expect(!after?.some((p) => p.text.includes('Quillby')), 'forget: item still recalled');
  }
  return c;
}

export async function checkIngestion(port: IngestionPort, f: { docs?: Document[] } = {}, c = new Checks()): Promise<Checks> {
  const docs = f.docs ?? [{ id: `conformance-${Date.now()}`, text: 'Conformance document.' }];
  docs.forEach((d, i) => c.all(conforms('document', d), `fixture doc[${i}]`));
  const ids = await c.attempt('ingest', () => port.ingest(docs));
  c.expect(ids?.length === docs.length, 'ingest: must return one id per document');
  if (ids) await c.attempt('delete', () => port.delete(ids));
  return c;
}

export interface ToolFixtures {
  calls?: {
    name: string;
    args: Record<string, unknown>;
    /** Text the result must contain. */
    expect?: string;
    /** Expected `ok` of the result. */
    ok?: boolean;
  }[];
}

export async function checkTools(port: ToolPort, f: ToolFixtures = {}, c = new Checks()): Promise<Checks> {
  const specs = await c.attempt('listTools', () => port.listTools(testContext()));
  if (specs) {
    specs.forEach((s, i) => c.all(conforms('tool-spec', s), `tool[${i}]`));
    c.expect(new Set(specs.map((s) => s.name)).size === specs.length, 'listTools: names must be unique');
    c.produced('listTools', specs);
  }
  const unknown = await c.attempt('callTool unknown', () => port.callTool('__conformance_missing__', {}, testContext()));
  c.expect(unknown?.ok === false, 'callTool: an unknown tool must return ok: false, not throw');
  c.produced('callTool unknown', unknown);
  for (const call of f.calls ?? []) {
    const out = await c.attempt(`callTool ${call.name}`, () => port.callTool(call.name, call.args, testContext()));
    if (!out) continue;
    c.all(conforms('tool-result', out), `result of ${call.name}`);
    c.produced(`callTool ${call.name}`, out);
    if (call.expect) c.expect(typeof out.text === 'string' && out.text.includes(call.expect), `callTool ${call.name}: text lacks "${call.expect}"`);
    if (call.ok !== undefined) c.expect(out.ok === call.ok, `callTool ${call.name}: ok should be ${call.ok}`);
  }
  return c;
}
