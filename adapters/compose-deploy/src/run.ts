import { spawn } from 'node:child_process';

export interface RunResult { code: number; stdout: string; stderr: string }
export interface RunOptions { cwd: string; signal?: AbortSignal }
/** Runs a command to completion. Never rejects for a failing command: the exit code says so. */
export type Run = (cmd: string, args: string[], opts: RunOptions) => Promise<RunResult>;

/** Default runner: a plain child process with output captured. */
export const spawnRun: Run = (cmd, args, { cwd, signal }) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(cmd, args, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d: Buffer) => { stdout += d; });
    child.stderr.on('data', (d: Buffer) => { stderr += d; });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

/** Command line for display: arguments with unusual characters are single-quoted. */
export const shellLine = (parts: readonly string[]): string =>
  parts.map((p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`)).join(' ');
