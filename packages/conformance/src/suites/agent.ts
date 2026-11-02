import {
  ApprovalPending, PORT_VERSIONS, versionAtLeast,
  type AgentSpec, type AttrFilter, type CallContext, type Caller, type Document, type IngestionPort, type KnowledgePort, type MemoryPort, type RunEvent, type RunnableAgent,
  type RunResult, type RuntimePort, type Stack, type StatePort, type ToolPort,
} from '@agent-layers/core';
import { Checks, testContext } from '../check.ts';
import { conforms } from '../schemas.ts';

export interface RuntimeFixtures {
  stack?: Stack;
  agent?: AgentSpec;
  input?: string;
  /** An input that makes the agent call a tool: enables the approval check (a pending approval ends the run `waiting`). */
  toolInput?: string;
  /**
   * RuntimePort version the runtime implements (`checkAdapter` passes its descriptor's; default: the core's). The
   * behaviour checks (abort, stream ≡ run, caller, approval) apply from 1.1.0.
   */
  portVersion?: string;
}

const CONFORMANCE_CALLER: Caller = { id: 'conformance-user', kind: 'user', roles: [], scopes: [] };

/**
 * The fixture stack seen through recorders: every model and tool call context is kept, and with `pending` every tool
 * call throws `ApprovalPending`, as the stack's governed tools do for a call waiting for a person.
 */
function probeStack(stack: Stack, contexts: CallContext[], pending: boolean): Stack {
  const probe = Object.create(stack) as Stack;
  return Object.assign(probe, {
    modelFor(agent: AgentSpec) {
      const model = stack.modelFor(agent);
      return Object.assign(Object.create(model), {
        chat: (req: Parameters<typeof model.chat>[0], ctx: CallContext) => { contexts.push(ctx); return model.chat(req, ctx); },
        ...(model.stream ? { stream: (req: Parameters<typeof model.chat>[0], ctx: CallContext) => { contexts.push(ctx); return model.stream!(req, ctx); } } : {}),
      });
    },
    toolsFor(agent: AgentSpec): ToolPort {
      const tools = stack.toolsFor(agent);
      return {
        ...(tools.name ? { name: tools.name } : {}),
        listTools: (ctx) => tools.listTools(ctx),
        async callTool(name, args, ctx) {
          contexts.push(ctx);
          if (pending) throw new ApprovalPending('conformance-approval', { by: 'conformance', tool: name });
          return tools.callTool(name, args, ctx);
        },
      };
    },
  });
}

/** The events of a streamed run, or undefined when it threw (recorded as a failure). */
async function collect(c: Checks, agent: RunnableAgent, input: string, ctx: Partial<CallContext>): Promise<RunEvent[] | undefined> {
  return c.attempt('stream', async () => {
    const events: RunEvent[] = [];
    for await (const e of agent.stream!(input, ctx)) events.push(e);
    return events;
  });
}

/** Abort, stream ≡ run, caller propagation and approval checks; each needs what the run fixtures give. */
async function checkRunBehaviour(port: RuntimePort, f: RuntimeFixtures, agent: RunnableAgent, result: RunResult, c: Checks): Promise<void> {
  const input = f.input ?? 'hello';
  const name = f.agent!.name;

  // A run whose signal is already aborted ends promptly as a result: stopped, reason aborted (or timeout).
  const aborted = await c.attempt('run aborted', () => agent.run(input, testContext({ agent: name, signal: AbortSignal.abort() })));
  if (aborted) c.expect(aborted.status === 'stopped' && ['aborted', 'timeout'].includes(String(aborted.reason?.code)), `run aborted: status ${aborted.status} (${aborted.reason?.code ?? 'no reason'}), expected stopped with reason aborted`);

  // The streamed run ends like the run: a final run.end with the same status, and the same text when it completes.
  if (agent.stream) {
    const events = await collect(c, agent, input, testContext({ agent: name }));
    if (events) {
      events.forEach((e, i) => c.all(conforms('run-event', e), `stream event[${i}]`));
      const end = events.at(-1);
      if (c.expect(end?.type === 'run.end', 'stream: the last event must be run.end')) {
        c.expect((end as { status?: string }).status === result.status, `stream: ended ${(end as { status?: string }).status}, the run ended ${result.status}`);
      }
      const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
      if (result.status === 'completed') c.expect(text === result.output, 'stream: the text events differ from the run output');
    }
  } else c.skip('stream: the runtime does not stream');

  // The caller flows into every model and tool call the run makes.
  const contexts: CallContext[] = [];
  const probed = await c.attempt('bind (probe)', () => port.bind(probeStack(f.stack!, contexts, false), f.agent!));
  if (probed) {
    await c.attempt('run with a caller', () => probed.run(input, testContext({ agent: name, caller: CONFORMANCE_CALLER })));
    if (!contexts.length) c.skip('caller: the run made no model or tool call through the stack');
    else c.expect(contexts.every((x) => x.caller?.id === CONFORMANCE_CALLER.id), 'caller: a model or tool call of the run did not carry the run caller');
  }

  // A tool call waiting for an approval ends the run waiting (needs_input), or the runtime lets ApprovalPending through.
  if (!f.toolInput) { c.skip('approval: needs a toolInput fixture'); return; }
  const calls: CallContext[] = [];
  const pending = await c.attempt('bind (pending approval)', () => port.bind(probeStack(f.stack!, calls, true), f.agent!));
  if (!pending) return;
  let waiting: RunResult | undefined;
  let thrown: unknown;
  await c.attempt('run (pending approval)', async () => {
    try { waiting = await pending.run(f.toolInput!, testContext({ agent: name })); } catch (err) { thrown = err; }
  });
  if (thrown !== undefined) c.expect(thrown instanceof ApprovalPending, `approval: the run threw ${thrown instanceof Error ? thrown.name : String(thrown)}`);
  else if (waiting) {
    c.expect(waiting.status === 'waiting' && waiting.reason?.code === 'needs_input', `approval: status ${waiting.status} (${waiting.reason?.code ?? 'no reason'}), expected waiting with needs_input`);
    c.produced('run (pending approval)', waiting);
  }
}

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
    if (versionAtLeast(f.portVersion ?? PORT_VERSIONS.RuntimePort, '1.1.0')) await checkRunBehaviour(port, f, agent, result, c);
    else c.skip(`behaviour: RuntimePort ${f.portVersion} predates the abort, stream, caller and approval checks (1.1.0)`);
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
