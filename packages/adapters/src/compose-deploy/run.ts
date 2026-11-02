import { spawn } from 'node:child_process';

export interface RunResult { code: number; stdout: string; stderr: string }
export interface RunOptions {
  cwd: string;
  /** Aborting stops the command: SIGTERM, then SIGKILL after `killGraceMs`. */
  signal?: AbortSignal;
  /** Wait between SIGTERM and SIGKILL (default {@link KILL_GRACE_MS}). */
  killGraceMs?: number;
}
/** Runs a command to completion. Never rejects for a failing command: the exit code says so. */
export type Run = (cmd: string, args: string[], opts: RunOptions) => Promise<RunResult>;

/** How long a command may take to exit after SIGTERM before it is killed with SIGKILL. */
export const KILL_GRACE_MS = 5000;

/** Default runner: a plain child process with output captured. */
export const spawnRun: Run = (cmd, args, { cwd, signal, killGraceMs = KILL_GRACE_MS }) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    };
    const done = (result: RunResult) => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', stop);
      resolve(result);
    };
    child.stdout.on('data', (d: Buffer) => { stdout += d; });
    child.stderr.on('data', (d: Buffer) => { stderr += d; });
    child.on('error', (err) => done({ code: -1, stdout, stderr: `${stderr}${err.message}` }));
    child.on('close', (code) => done({ code: code ?? -1, stdout, stderr }));
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  });

/** Command line for display: arguments with unusual characters are single-quoted. */
export const shellLine = (parts: readonly string[]): string =>
  parts.map((p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`)).join(' ');
