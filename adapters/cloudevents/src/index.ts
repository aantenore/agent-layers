import { randomUUID } from 'node:crypto';
import {
  ATTR, defineAdapter, globToRegExp, InboundRejected, noMappings, noopTelemetry, PORT_VERSIONS,
  type Caller, type InboundContext, type InboundRejection, type Mappings, type TelemetryPort, type Trigger, type TriggerPort, type TriggerSink,
} from '@agent-layers/core';

export interface CloudEventsRoute {
  /** Glob (`*`, `?`) on the CloudEvent `type`. */
  type: string;
  agent: string;
  /** Run input template; the event data as a string when omitted. */
  input?: string;
  /** Optional glob on the CloudEvent `source`. */
  source?: string;
}

export interface CloudEventsOptions {
  /** Path of the endpoint on the host server. */
  path?: string;
  /** First matching route wins. */
  routes: CloudEventsRoute[];
  /** The trigger's own service credential, verified through the identity layer for every event. */
  credential?: string;
}

/** Extension attribute values CloudEvents allows in JSON. */
type ExtensionValue = string | number | boolean;

/** The CloudEvent attributes the adapter reads. */
interface CloudEvent {
  id: string;
  source: string;
  type: string;
  time?: string;
  subject?: string;
  datacontenttype?: string;
  dataschema?: string;
  /** Extension attributes (names of 1 to 20 lower-case letters and digits, scalar values). */
  extensions: Record<string, ExtensionValue>;
  data?: unknown;
}

const DEFAULT_PATH = '/v1/events';
const REALM = 'agent-layers';

/** Raised while reading the request; becomes a 400 with the message. */
class InvalidEvent extends Error {}

function errorResponse(status: number, message: string, type: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { message, type } }, { status, headers });
}

const REJECTIONS: Record<InboundRejection, { status: number; type: string }> = {
  unauthenticated: { status: 401, type: 'authentication_error' },
  forbidden: { status: 403, type: 'permission_error' },
  not_found: { status: 404, type: 'not_found_error' },
  invalid: { status: 400, type: 'invalid_request_error' },
};

function rejection(kind: InboundRejection, message: string): Response {
  const { status, type } = REJECTIONS[kind];
  return errorResponse(status, message, type, kind === 'unauthenticated' ? { 'www-authenticate': `Bearer realm="${REALM}"` } : {});
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isJsonType = (t: string) => t === 'application/json' || t.endsWith('+json');
/** Attributes that are not extensions. */
const CONTEXT_ATTRIBUTES = new Set(['specversion', 'id', 'source', 'type', 'time', 'subject', 'datacontenttype', 'dataschema', 'data', 'data_base64']);
const EXTENSION_NAME = /^[a-z0-9]{1,20}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function attribute(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new InvalidEvent(`missing CloudEvents attribute "${name}"`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new InvalidEvent(`CloudEvents attribute "${name}" must be a string`);
  return value;
}

function checked(get: (name: string) => unknown, names: Iterable<string>, data: unknown): CloudEvent {
  if (get('specversion') !== '1.0') throw new InvalidEvent('unsupported or missing specversion (only "1.0" is accepted)');
  const event: CloudEvent = { id: attribute(get('id'), 'id'), source: attribute(get('source'), 'source'), type: attribute(get('type'), 'type'), extensions: {} };
  const time = optionalString(get('time'), 'time');
  if (time && RFC3339.test(time) && !Number.isNaN(Date.parse(time))) event.time = time;
  const subject = optionalString(get('subject'), 'subject');
  if (subject) event.subject = subject;
  const datacontenttype = optionalString(get('datacontenttype'), 'datacontenttype');
  if (datacontenttype) event.datacontenttype = datacontenttype;
  const dataschema = optionalString(get('dataschema'), 'dataschema');
  if (dataschema) event.dataschema = dataschema;
  for (const name of names) {
    if (CONTEXT_ATTRIBUTES.has(name) || !EXTENSION_NAME.test(name)) continue;
    const value = get(name);
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') event.extensions[name] = value;
  }
  if (data !== undefined) event.data = data;
  return event;
}

async function structuredEvent(req: Request): Promise<CloudEvent> {
  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    throw new InvalidEvent('the body is not valid JSON');
  }
  if (!isRecord(body)) throw new InvalidEvent('the body must be a JSON object');
  if (body.data !== undefined && body.data_base64 !== undefined) throw new InvalidEvent('"data" and "data_base64" are mutually exclusive');
  if (body.data_base64 !== undefined && typeof body.data_base64 !== 'string') throw new InvalidEvent('"data_base64" must be a string');
  return checked((name) => body[name], Object.keys(body), body.data ?? body.data_base64);
}

async function binaryEvent(req: Request, contentType: string): Promise<CloudEvent> {
  const header = (name: string) => req.headers.get(`ce-${name}`) ?? undefined;
  const names = [...req.headers.keys()].filter((h) => h.startsWith('ce-')).map((h) => h.slice(3));
  // Validate the attributes before reading the body.
  const event = checked(header, names, undefined);
  // In binary mode the Content-Type header is the data content type.
  const declared = req.headers.get('content-type')?.trim();
  if (declared) event.datacontenttype = declared;
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length === 0) return event;
  if (isJsonType(contentType)) {
    try {
      event.data = JSON.parse(buf.toString('utf8'));
    } catch {
      throw new InvalidEvent('the body is not valid JSON');
    }
  } else if (contentType.startsWith('text/')) event.data = buf.toString('utf8');
  else event.data = buf.toString('base64');
  return event;
}

function lookup(data: unknown, path: string): unknown {
  let cur = data;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** `{{type}}`, `{{source}}`, `{{id}}`, `{{subject}}`, `{{time}}`, `{{data}}`, `{{data.a.b}}`; unknown names stay as written. */
export function renderInput(template: string, event: CloudEvent): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, name: string) => {
    switch (name) {
      case 'type': case 'source': case 'id': case 'subject': case 'time': return event[name] ?? '';
      case 'data': return text(event.data);
      default: return name.startsWith('data.') ? text(lookup(event.data, name.slice(5))) : whole;
    }
  });
}

/** The event as a flat document, the way structured mode writes it: what `mappings.in` rules read. */
function nativeOf(event: CloudEvent): Record<string, unknown> {
  const { extensions, data, ...attributes } = event;
  return { specversion: '1.0', ...attributes, ...extensions, ...(data !== undefined ? { data } : {}) };
}

/**
 * The `ext` of the trigger: the upstream event id (kept, to deduplicate redeliveries), the subject, the data content
 * type and schema, and the extension attributes as one object.
 */
function extOf(event: CloudEvent): Record<string, unknown> {
  return {
    'cloudevents.id': event.id,
    ...(event.subject ? { 'cloudevents.subject': event.subject } : {}),
    ...(event.datacontenttype ? { 'cloudevents.datacontenttype': event.datacontenttype } : {}),
    ...(event.dataschema ? { 'cloudevents.dataschema': event.dataschema } : {}),
    ...(Object.keys(event.extensions).length ? { 'cloudevents.extensions': event.extensions } : {}),
  };
}

/** Collaborators the registry hands the adapter; absent when it is used directly from code. */
export interface CloudEventsContext { mappings?: Mappings; telemetry?: TelemetryPort }

/** Factory: usable directly from code, without the registry. */
export function createCloudEventsTrigger(options: CloudEventsOptions, name = 'cloudevents', { mappings = noMappings(name), telemetry = noopTelemetry }: CloudEventsContext = {}): TriggerPort {
  const path = options.path ?? DEFAULT_PATH;
  const routes = options.routes.map((r) => ({
    type: globToRegExp(r.type),
    ...(r.source ? { source: globToRegExp(r.source) } : {}),
    agent: r.agent,
    input: r.input ?? '{{data}}',
  }));

  async function callerFor(sink: TriggerSink, ctx: InboundContext): Promise<{ caller?: Caller } | Response> {
    if (options.credential === undefined) return ctx.caller ? { caller: ctx.caller } : {};
    // The configured credential is the run caller: no fallback to the HTTP caller or to anonymous.
    try {
      if (!sink.verify) throw new Error('no identity layer');
      return { caller: await sink.verify(options.credential) };
    } catch {
      return rejection('unauthenticated', 'the service credential of this trigger was not accepted');
    }
  }

  return {
    name,
    mount(sink) {
      return {
        routes: [{
          path,
          methods: ['POST'],
          async handle(req, ctx) {
            const contentType = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
            if (contentType === 'application/cloudevents-batch+json') {
              return errorResponse(415, 'batch mode is not supported: send one event per request', 'invalid_request_error');
            }
            let event: CloudEvent;
            try {
              event = contentType === 'application/cloudevents+json' ? await structuredEvent(req) : await binaryEvent(req, contentType);
            } catch (err) {
              if (err instanceof InvalidEvent) return errorResponse(400, err.message, 'invalid_request_error');
              throw err;
            }
            const route = routes.find((r) => r.type.test(event.type) && (!r.source || r.source.test(event.source)));
            if (!route) return errorResponse(404, `no route for event type "${event.type}"`, 'not_found_error');

            const who = await callerFor(sink, ctx);
            if (who instanceof Response) return who;
            try {
              // The SDK id is unique per delivery (the reference host uses it as the run id); redeliveries of one
              // upstream event share `ext["cloudevents.id"]` and `source`.
              const trigger = mappings.in<Trigger>(nativeOf(event), {
                id: randomUUID(),
                kind: event.type,
                source: event.source,
                ...(event.time ? { at: event.time } : {}),
                agent: route.agent,
                data: renderInput(route.input, event),
                ext: extOf(event),
              });
              const { runId } = await telemetry.span('cloudevents.receive', { [ATTR.layer]: 'interface', [ATTR.triggerKind]: trigger.kind, [ATTR.name]: route.agent }, () => sink.accept(trigger, who));
              return Response.json({ runId, agent: route.agent, eventId: event.id }, { status: 202 });
            } catch (err) {
              if (err instanceof InboundRejected) return rejection(err.kind, err.message);
              return errorResponse(500, 'internal error', 'server_error');
            }
          },
        }],
      };
    },
  };
}

/** Descriptor: what the registry and the CLI see. */
export const adapter = defineAdapter<'TriggerPort', CloudEventsOptions>({
  layer: 'interface',
  port: 'TriggerPort',
  name: 'cloudevents',
  direction: 'inbound',
  maps: { standard: 'CloudEvents 1.0 HTTP binding' },
  portVersion: PORT_VERSIONS.TriggerPort,
  tiers: ['prototype', 'production'],
  description: 'Receives CloudEvents over HTTP (structured and binary mode) and starts an agent run per event.',
  optionsSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', pattern: '^/' },
      routes: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', minLength: 1 },
            agent: { type: 'string', minLength: 1 },
            input: { type: 'string' },
            source: { type: 'string', minLength: 1 },
          },
          required: ['type', 'agent'],
          additionalProperties: false,
        },
      },
      credential: { type: 'string', minLength: 1 },
    },
    required: ['routes'],
    additionalProperties: false,
  },
  ext: {
    produces: ['cloudevents.id', 'cloudevents.subject', 'cloudevents.datacontenttype', 'cloudevents.dataschema', 'cloudevents.extensions'],
  },
  mappingDefaults: { in: { shape: 'Trigger' } },
  create: (options, ctx) => createCloudEventsTrigger(options, ctx.name, { mappings: ctx.mappings, telemetry: ctx.telemetry }),
});

export const adapters = [adapter];
