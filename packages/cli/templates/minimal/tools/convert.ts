// Tools are plain objects: name, description, JSON Schema of the arguments (params), risk, and a run function
// that returns text or { ok, text }.
// The functions adapter loads this module (see layers.tools in agent-layers.json).
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
];
