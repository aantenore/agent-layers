import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Io } from '../io.ts';

/** Delegates to @agent-layers/gateway when it is installed. */
export async function gateway(io: Io, argv: string[]): Promise<number> {
  let entry: string;
  try {
    entry = createRequire(join(io.cwd, 'package.json')).resolve('@agent-layers/gateway');
  } catch {
    io.err('The gateway is provided by @agent-layers/gateway, which is not installed.');
    io.err('It hosts a composed stack over the network: the model port as an OpenAI-compatible API, tools as an MCP server, and the configured channels.');
    return 1;
  }
  const mod = await import(pathToFileURL(entry).href) as { main?: (argv: string[]) => Promise<number> };
  if (typeof mod.main !== 'function') { io.err('@agent-layers/gateway does not export main()'); return 1; }
  return mod.main(argv);
}
