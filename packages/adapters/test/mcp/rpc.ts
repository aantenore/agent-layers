/** Fixture MCP server logic shared by the HTTP mock and the stdio script. */

export const TOOLS = [
  {
    name: 'echo', description: 'Echo the text', annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  { name: 'remove', description: 'Remove something', annotations: { destructiveHint: false }, inputSchema: { type: 'object' } },
  { name: 'wipe', description: 'Wipe everything', inputSchema: { type: 'object' } },
  { name: 'lookup_docs', description: 'Looks things up', inputSchema: { type: 'object' } },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object' } },
  { name: 'who/am i', description: 'Shows the authorization it received', inputSchema: { type: 'object' } },
  { name: 'headers', description: 'Structured copy of the headers it received', inputSchema: { type: 'object' } },
  { name: 'fixed', description: 'Structured content only', inputSchema: { type: 'object' } },
  { name: 'search', description: 'Search entries', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
];

export const ENTRIES = [
  { id: 'tide', text: 'The Zorblax tide gate closes at 14:20.', file: 'tide.md' },
  { id: 'vault', text: 'The vault code rotates every 9 days.', file: 'vault.md' },
  { id: 'quay', text: 'Quay nine is closed on Sundays.', file: 'quay.md' },
];

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

export interface Rpc { id?: number | string; method: string; params?: any }

/** Result of a request, or an error object `{ error }`; undefined for notifications. */
export function handleRpc(msg: Rpc, headers: Record<string, string | undefined> = {}): { result?: unknown; error?: { code: number; message: string } } | undefined {
  if (msg.id === undefined) return undefined;
  switch (msg.method) {
    case 'initialize':
      return { result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } } };
    case 'tools/list': {
      const page = msg.params?.cursor === 'p2';
      return { result: page ? { tools: TOOLS.slice(4) } : { tools: TOOLS.slice(0, 4), nextCursor: 'p2' } };
    }
    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params ?? {};
      switch (name) {
        case 'echo': return { result: text(`echo: ${args.text}`) };
        case 'remove': return { result: text('removed') };
        case 'wipe': return { result: text('wiped') };
        case 'lookup_docs': return { result: { content: [], structuredContent: { found: 1 } } };
        case 'fail': return { result: text('it broke', true) };
        case 'who/am i': return { result: text(`authorization=${headers.authorization ?? 'none'}`) };
        case 'headers': return { result: { content: [], structuredContent: { authorization: headers.authorization ?? null, apiKey: headers['x-api-key'] ?? null } } };
        case 'fixed': return { result: { content: [], structuredContent: { k: 'v' } } };
        case 'search': {
          const words = String(args.query ?? '').toLowerCase().split(/\W+/).filter(Boolean);
          const hits = ENTRIES.filter((e) => words.some((w) => e.text.toLowerCase().includes(w)));
          if (!hits.length) return { result: text('No information found for the query') };
          const body = hits.map((e) => `<entry><content>${e.text}</content><metadata>${JSON.stringify({ id: e.id, file: e.file })}</metadata></entry>`);
          return { result: text(JSON.stringify(body)) };
        }
        default: return { error: { code: -32602, message: `Unknown tool: ${name}` } };
      }
    }
    default:
      return { error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}
