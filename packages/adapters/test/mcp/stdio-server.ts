import { createInterface } from 'node:readline';
import { handleRpc } from './rpc.ts';

// Mimics a server that logs to stdout noise and to stderr, as real ones do.
console.error('fixture mcp server started');
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'tools/call' && msg.params?.name === 'crash') process.exit(3);
  const out = handleRpc(msg);
  process.stdout.write('not json noise\n');
  if (out) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...out })}\n`);
});
