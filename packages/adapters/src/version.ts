import { readFileSync } from 'node:fs';

/** Version of this package, read from its manifest: what the MCP server and client and the A2A agent cards report. */
export const PACKAGE_VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
