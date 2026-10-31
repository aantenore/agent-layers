import { randomUUID } from 'node:crypto';
import {
  defineAdapter, globToRegExp, InboundRejected, PORT_VERSIONS,
  type InboundContext, type InboundRejection, type Identity, type TriggerPort, type TriggerSink,
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

/** The CloudEvent attributes the adapter reads. */
interface CloudEvent {
  id: string;
  source: string;
  type: string;
  time?: string;
  subject?: string;
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

function checked(get: (name: string) => unknown, data: unknown): CloudEvent {
  if (get('specversion') !== '1.0') throw new InvalidEvent('unsupported or missing specversion (only "1.0" is accepted)');
  const event: CloudEvent = { id: attribute(get('id'), 'id'), source: attribute(get('source'), 'source'), type: attribute(get('type'), 'type') };
  const time = optionalString(get('time'), 'time');
  if (time && RFC3339.test(time) && !Number.isNaN(Date.parse(time))) event.time = time;
  const subject = optionalString(get('subject'), 'subject');
  if (subject) event.subject = subject;
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
  return checked((name) => body[name], body.data ?? body.data_base64);
}

async function binaryEvent(req: Request, contentType: string): Promise<CloudEvent> {
  const header = (name: string) => req.headers.get(`ce-${name}`) ?? undefined;
  // Validate the attributes before reading the body.
  const event = checked(header, undefined);
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

/** Factory: usable directly from code, without the registry. */
export function createCloudEventsTrigger(options: CloudEventsOptions, name = 'cloudevents'): TriggerPort {
  const path = options.path ?? DEFAULT_PATH;
  const routes = options.routes.map((r) => ({
    type: globToRegExp(r.type),
    ...(r.source ? { source: globToRegExp(r.source) } : {}),
    agent: r.agent,
    input: r.input ?? '{{data}}',
  }));

  async function identityFor(sink: TriggerSink, ctx: InboundContext): Promise<{ identity?: Identity } | Response> {
    if (options.credential === undefined) return ctx.identity ? { identity: ctx.identity } : {};
    // The configured credential is the run identity: no fallback to the caller or to anonymous.
    try {
      if (!sink.verify) throw new Error('no identity layer');
      return { identity: await sink.verify(options.credential) };
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

            const who = await identityFor(sink, ctx);
            if (who instanceof Response) return who;
            try {
              const { runId } = await sink.accept({
                id: randomUUID(),
                type: event.type,
                source: event.source,
                ...(event.time ? { time: event.time } : {}),
                agent: route.agent,
                data: renderInput(route.input, event),
              }, who);
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
  create: (options, ctx) => createCloudEventsTrigger(options, ctx.name),
});

export const adapters = [adapter];
