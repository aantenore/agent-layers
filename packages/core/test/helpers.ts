import {
  defineAdapter, PORT_VERSIONS, recordingTelemetry, type CallContext, type ChatRequest, type ChatResponse, type GuardPort,
  type GuardVerdict, type ModelPort, type TelemetryRecord, type ToolPort,
} from '../src/index.ts';

export const ctx = (over: Partial<CallContext> = {}): CallContext => ({ runId: 'run-1', agent: 'tester', ...over });

/** Telemetry that keeps every record for assertions. */
export function recorder() {
  const records: TelemetryRecord[] = [];
  return { records, telemetry: recordingTelemetry((r) => records.push(r)) };
}

export function reply(content: string | null, extra: Partial<ChatResponse['choices'][number]['message']> = {}): ChatResponse {
  return { model: 'fake', choices: [{ index: 0, message: { role: 'assistant', content, ...extra }, finish_reason: extra.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
}

/** Model that records requests and answers with `answer(req)`. */
export function fakeModel(answer: (req: ChatRequest) => ChatResponse = () => reply('ok'), log?: string[]) {
  const requests: ChatRequest[] = [];
  const model: ModelPort = {
    name: 'fake',
    async chat(req) {
      log?.push('model');
      requests.push(structuredClone(req));
      return answer(req);
    },
  };
  return { model, requests };
}

/** Guard that applies `verdict(text, stage)`, logging its calls. */
export function fakeGuard(name: string, verdict: (text: string, stage: string) => GuardVerdict, log?: string[], stages?: GuardPort['stages']): GuardPort {
  return { name, ...(stages ? { stages } : {}), async check(i) { log?.push(`${name}:${i.stage}`); return verdict(i.text, i.stage); } };
}

export function fakeTools(specs: { name: string; risk?: 'read' | 'write' | 'exec' }[], log: { name: string; args: unknown; ctx: CallContext }[] = []): ToolPort {
  return {
    listTools: async () => specs.map((s) => ({ name: s.name, description: s.name, inputSchema: { type: 'object' }, ...(s.risk ? { risk: s.risk } : {}) })),
    async callTool(name, args, c) {
      log.push({ name, args, ctx: c });
      if (!specs.some((s) => s.name === name)) return { content: 'unknown', isError: true };
      return { content: `${name} done with ${JSON.stringify(args)}` };
    },
  };
}

/** Descriptor for tests: creates whatever `make` returns. */
export function testAdapter<P extends keyof typeof PORT_VERSIONS>(port: P, layer: Parameters<typeof defineAdapter>[0]['layer'], name: string, make: (o: any) => any, tiers: ('prototype' | 'production')[] = ['prototype']) {
  return defineAdapter({ port, layer, name, direction: 'outbound', maps: { technology: 'test double' }, portVersion: PORT_VERSIONS[port], tiers, optionsSchema: { type: 'object' }, create: make } as never);
}
