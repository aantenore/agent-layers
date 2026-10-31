// Copies spec/schemas into the package so published builds carry the source of truth with them.
import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

cpSync(fileURLToPath(new URL('../../../spec/schemas/', import.meta.url)), fileURLToPath(new URL('../schemas/', import.meta.url)), { recursive: true });
