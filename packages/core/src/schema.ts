/** A JSON Schema document (draft 2020-12). */
export type JsonSchema = Record<string, unknown>;

/**
 * Small JSON Schema validator for adapter options, configs and conformance checks.
 * Supports type, properties, required, additionalProperties, items, enum, const, anyOf, oneOf,
 * allOf, if/then, $ref to local #/$defs, min/max, minLength/maxLength, minItems/maxItems, pattern.
 * Unknown keywords are ignored. Returns one message per problem, prefixed with its JSON path.
 */
export function validate(schema: JsonSchema, value: unknown, path = '$'): string[] {
  const errors: string[] = [];
  check(schema, value, path, errors, schema);
  return errors;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
  return typeof value;
}

const matchesType = (expected: string, actual: string) => expected === actual || (expected === 'number' && actual === 'integer');

function resolveRef(ref: string, root: JsonSchema): JsonSchema | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = root;
  for (const part of ref.slice(2).split('/')) node = (node as Record<string, unknown> | undefined)?.[part];
  return node as JsonSchema | undefined;
}

function check(schema: JsonSchema, value: unknown, path: string, errors: string[], root: JsonSchema): void {
  if (!schema || typeof schema !== 'object') return;
  const sub = (s: JsonSchema) => { const e: string[] = []; check(s, value, path, e, root); return e; };

  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, root);
    if (target) check(target, value, path, errors, root);
  }
  if (Array.isArray(schema.anyOf) && !(schema.anyOf as JsonSchema[]).some((s) => sub(s).length === 0)) {
    errors.push(`${path}: does not match any allowed shape`);
    return;
  }
  if (Array.isArray(schema.oneOf) && (schema.oneOf as JsonSchema[]).filter((s) => sub(s).length === 0).length !== 1) {
    errors.push(`${path}: must match exactly one allowed shape`);
    return;
  }
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf as JsonSchema[]) check(s, value, path, errors, root);
  if (schema.if && typeof schema.if === 'object' && sub(schema.if as JsonSchema).length === 0 && schema.then) {
    check(schema.then as JsonSchema, value, path, errors, root);
  }

  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => matchesType(t, actual))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${actual}`);
      return;
    }
  }
  if ('const' in schema && value !== schema.const) errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    errors.push(`${path}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, i) => check(schema.items as JsonSchema, item, `${path}[${i}]`, errors, root));
    }
  }
  if (actual === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (obj[key] === undefined) errors.push(`${path}.${key}: required`);
    }
    for (const [key, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      if (props[key]) check(props[key], v, `${path}.${key}`, errors, root);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: unknown property`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        check(schema.additionalProperties as JsonSchema, v, `${path}.${key}`, errors, root);
      }
    }
  }
}
