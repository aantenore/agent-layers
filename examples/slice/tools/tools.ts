// The tools of the slice, identical in every profile. The functions adapter loads this module.
import type { ToolDef } from '@agent-layers/adapter-functions';

export const tools: ToolDef[] = [
  {
    name: 'convert_temperature',
    description: 'Converts a temperature from degrees Celsius to degrees Fahrenheit.',
    risk: 'read',
    params: {
      type: 'object',
      properties: { celsius: { type: ['number', 'string'], description: 'Degrees Celsius' } },
      required: ['celsius'],
      additionalProperties: false,
    },
    run: async ({ celsius }) => {
      const c = Number(celsius);
      if (!Number.isFinite(c)) return { ok: false, text: 'celsius must be a number' };
      return { ok: true, text: `${c} °C is ${Math.round((c * 9 / 5 + 32) * 10) / 10} °F` };
    },
  },
  {
    // A write tool: authorization decides who may call it, and it acts for the caller with a token for its audience.
    name: 'save_note',
    description: 'Saves a short note for the caller.',
    risk: 'write',
    audience: 'tools-api',
    params: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The note' } },
      required: ['text'],
      additionalProperties: false,
    },
    run: async ({ text }, ctx) => {
      if (!ctx.credentials) return { ok: false, text: 'no credentials for this run' };
      // The token is requested to prove the caller can obtain one; it is never returned or logged.
      await ctx.credentials.token('tools-api');
      return { ok: true, text: `Saved a note of ${String(text).length} characters for ${ctx.caller?.id ?? 'nobody'}.` };
    },
  },
];
