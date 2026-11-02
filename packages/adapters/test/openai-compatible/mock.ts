import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Seen { path: string; headers: IncomingMessage['headers']; body: Record<string, any> }
export type Handler = (seen: Seen, res: ServerResponse) => void | Promise<void>;

const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Writes a text in awkward pieces: odd sizes, and splits inside multi-byte characters. */
export async function writeSplit(res: ServerResponse, text: string, size = 7): Promise<void> {
  const bytes = Buffer.from(text, 'utf8');
  for (let i = 0; i < bytes.length; i += size) {
    res.write(bytes.subarray(i, i + size));
    await sleep(2);
  }
}

/** Default behaviour: a plain answer, a tool call when asked for one, an SSE stream when `stream` is set. */
export const defaultHandler: Handler = async ({ body }, res) => {
  const wantsTool = body.tool_choice === 'required' && body.tools?.length;
  const message = wantsTool
    ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: body.tools[0].function.name, arguments: {} } }] }
    : { role: 'assistant', content: 'OK' };
  if (!body.stream) {
    return json(res, { id: 'cmpl-1', object: 'chat.completion', model: body.model, choices: [{ index: 0, message, finish_reason: wantsTool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  await writeSplit(res, `: keep-alive\n\n${ev({ id: 'cmpl-1', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' } }] })}${ev({ id: 'cmpl-1', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}data: [DONE]\n\n`);
  res.end();
};

/** Mock OpenAI-style server on a random port. Records every request. */
export async function startMock(handler: Handler = defaultHandler) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const entry: Seen = { path: req.url ?? '', headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {} };
      seen.push(entry);
      Promise.resolve(handler(entry, res)).catch(() => res.destroy());
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return {
    url,
    seen,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export { json };
