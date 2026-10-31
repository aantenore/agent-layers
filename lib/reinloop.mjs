import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// REINLOOP_SRC: path to a reinloop checkout's src/index.ts (Node runs .ts natively).
// Without it, the installed `reinloop` package is used.
export const reinloop = await import(
  process.env.REINLOOP_SRC ? pathToFileURL(resolve(process.env.REINLOOP_SRC)).href : 'reinloop'
);
