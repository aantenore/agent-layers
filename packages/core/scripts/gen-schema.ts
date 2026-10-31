// Writes the stack config JSON Schema from its TypeScript definition (src/config-schema.ts).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configSchema } from '../src/config-schema.ts';

const text = `${JSON.stringify(configSchema, null, 2)}\n`;
for (const target of ['../schema/agent-layers.schema.json', '../../../spec/schemas/stack-config.json']) {
  writeFileSync(fileURLToPath(new URL(target, import.meta.url)), text);
}
