import {
  defineAdapter, PORT_VERSIONS, recordingTelemetry, messageText, type CallContext, type CallPart, type GuardPort,
  type GuardVerdict, type ModelPort, type ModelReply, type ModelRequest, type TelemetryRecord, type ToolPort,
} from '../src/index.ts';

export const ctx = (over: Partial<CallContext> = {}): CallContext => ({ runId: 'run-1', agent: 'tester', ...over });

/** Telemetry that keeps every record for assertions. */
export function recorder() {
  const records: TelemetryRecord[] = [];
  return { records, telemetry: recordingTelemetry((r) => records.push(r)) };
}

export function reply(text: string | null, calls: CallPart[] = []): ModelReply {
  return {
    model: 'fake',
    message: { role: 'assistant', parts: [...(text ? [{ type: 'text' as const, text }] : []), ...calls] },
    finish: calls.length ? 'tools' : 'end',
    usage: { inputTokens: 3, outputTokens: 2 },
  };
}

/** Text of the nth message of a request. */
export const textAt = (req: ModelRequest, i: number): string => messageText(req.messages[i]);

/** Model that records requests and answers with `answer(req)`. */
export function fakeModel(answer: (req: ModelRequest) => ModelReply = () => reply('ok'), log?: string[]) {
  const requests: ModelRequest[] = [];
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
    listTools: async () => specs.map((s) => ({ name: s.name, description: s.name, params: { type: 'object' }, ...(s.risk ? { risk: s.risk } : {}) })),
    async callTool(name, args, c) {
      log.push({ name, args, ctx: c });
      if (!specs.some((s) => s.name === name)) return { ok: false, text: 'unknown' };
      return { ok: true, text: `${name} done with ${JSON.stringify(args)}` };
    },
  };
}

/** Descriptor for tests: creates whatever `make` returns. */
export function testAdapter<P extends keyof typeof PORT_VERSIONS>(port: P, layer: Parameters<typeof defineAdapter>[0]['layer'], name: string, make: (o: any, c: any) => any, tiers: ('prototype' | 'production')[] = ['prototype']) {
  return defineAdapter({ port, layer, name, direction: 'outbound', maps: { technology: 'test double' }, portVersion: PORT_VERSIONS[port], tiers, optionsSchema: { type: 'object' }, create: make } as never);
}
