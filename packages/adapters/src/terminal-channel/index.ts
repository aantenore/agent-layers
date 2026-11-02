import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { defineAdapter, PORT_VERSIONS, stopReasonOf, type ChannelHandle, type ChannelHost, type ChannelPort, type RunResult } from '@agent-layers/core';

export interface TerminalChannelOptions {
  /** Agent to talk to at start (default: the first agent of the host). */
  agent?: string;
  /** Prompt shown before each line (default `> `). */
  prompt?: string;
  /** Print the greeting line when the session starts (default true). */
  banner?: boolean;
}

export interface TerminalStreams {
  input?: Readable;
  output?: Writable;
}

/** Error text is not shown: only the stop code of the error. */
const errorLine = (err: unknown) => `[error] ${stopReasonOf(err).code}`;

/**
 * A run that did not complete, from its status and `reason.code` (and `reason.by`); the reason's detail is internal and
 * not shown. A waiting run also prints what the agent said so far: it is what the person is asked.
 */
function incomplete(result: RunResult): string[] {
  const { code, by } = result.reason ?? {};
  const head = `[${result.status}]${code ? ` ${code}` : ''}${by ? ` (${by})` : ''}`;
  return result.status === 'waiting' && result.output ? [head, result.output] : [head];
}

/** Channel that serves the stack's agents on a terminal: one line in, one answer out, in order. */
export function createTerminalChannel(options: TerminalChannelOptions = {}, streams: TerminalStreams = {}, name = 'terminal-channel'): ChannelPort & Required<Pick<ChannelPort, 'serve'>> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  const prompt = options.prompt ?? '> ';
  const print = (text: string) => { output.write(`${text}\n`); };

  return {
    name,
    async serve(host: ChannelHost, opts): Promise<ChannelHandle> {
      let agent = options.agent ?? host.agents()[0];
      if (!agent) throw new Error('terminal-channel: the stack has no agents');
      const sessionId = randomUUID();
      const abort = new AbortController();
      const rl = createInterface({ input, output, prompt });
      let ended = false;
      let stopping = false;
      rl.on('close', () => { ended = true; });
      /** Explicit stop: also cancels the run in flight. End of input lets it finish. */
      const stop = () => { stopping = true; abort.abort(); rl.close(); };
      rl.on('SIGINT', stop);
      if (opts?.signal?.aborted) stop();
      else opts?.signal?.addEventListener('abort', stop, { once: true });

      /** Handles one line; returns false when the session should end. */
      async function handle(line: string): Promise<boolean> {
        if (line === '/exit') return false;
        if (line === '/agents') print(host.agents().join(', '));
        else if (line.startsWith('/agent ')) {
          const next = line.slice(7).trim();
          if (host.agents().includes(next)) { agent = next; print(`Talking to ${agent}.`); }
          else print(`[error] unknown agent "${next}"`);
        } else {
          try {
            const result = await host.run(agent!, line, { sessionId, signal: abort.signal });
            if (result.status === 'completed') print(result.output);
            else for (const line of incomplete(result)) print(line);
          } catch (err) {
            if (!stopping) print(errorLine(err));
          }
        }
        return true;
      }

      async function loop(): Promise<void> {
        if (options.banner ?? true) print(`Talking to ${agent}. /agents, /agent <name>, /exit.`);
        if (!ended) rl.prompt();
        for await (const raw of rl) {
          const line = raw.trim();
          if (line && !(await handle(line))) break;
          if (stopping) break;
          if (!ended) rl.prompt();
        }
        rl.close();
      }

      const done = loop().catch((err: unknown) => { rl.close(); print(errorLine(err)); });
      return {
        done,
        async close() {
          stop();
          await done;
        },
      };
    },
  };
}

export const adapter = defineAdapter<'ChannelPort', TerminalChannelOptions>({
  layer: 'interface',
  port: 'ChannelPort',
  name: 'terminal-channel',
  direction: 'inbound',
  maps: { technology: 'terminal (stdin/stdout)' },
  portVersion: PORT_VERSIONS.ChannelPort,
  tiers: ['prototype'],
  description: 'Chat with the stack\'s agents on stdin/stdout. For development and demos.',
  optionsSchema: {
    type: 'object',
    properties: {
      agent: { type: 'string', minLength: 1 },
      prompt: { type: 'string' },
      banner: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  create: (options, ctx) => createTerminalChannel(options, {}, ctx.name),
});

export const adapters = [adapter];
