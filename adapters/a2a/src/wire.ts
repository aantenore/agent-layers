/**
 * A2A wire shapes. The adapter speaks A2A 1.0 (PascalCase JSON-RPC methods, ProtoJSON enums) and, for clients that
 * have not moved yet, the 0.3 JSON-RPC methods with their `kind`-tagged shapes. Everything else in the adapter works on
 * the version-neutral values below.
 */

export const A2A_VERSION = '1.0';
export const LEGACY_VERSION = '0.3';
export type WireVersion = typeof A2A_VERSION | typeof LEGACY_VERSION;

export type TaskState = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled' | 'rejected' | 'input-required' | 'auth-required';
export type Role = 'user' | 'agent';

export interface MessageValue { messageId: string; role: Role; text: string; contextId?: string; taskId?: string }
/** Key of the task `metadata` entry that carries the run figures, in the SDK language's names. */
export const METADATA_KEY = 'agent-layers';
/** Run figures a task carries in `metadata["agent-layers"]`: token usage and cost in US dollars. */
export interface TaskRunMetadata { usage?: { inputTokens: number; outputTokens: number }; costUsd?: number }
export interface TaskValue { id: string; contextId: string; state: TaskState; timestamp: string; answer?: string; status?: MessageValue; metadata?: TaskRunMetadata }

/** JSON-RPC method names per version → the operation. */
export const METHODS: Record<string, { op: 'send' | 'stream' | 'get' | 'cancel'; version: WireVersion }> = {
  SendMessage: { op: 'send', version: A2A_VERSION },
  SendStreamingMessage: { op: 'stream', version: A2A_VERSION },
  GetTask: { op: 'get', version: A2A_VERSION },
  CancelTask: { op: 'cancel', version: A2A_VERSION },
  'message/send': { op: 'send', version: LEGACY_VERSION },
  'message/stream': { op: 'stream', version: LEGACY_VERSION },
  'tasks/get': { op: 'get', version: LEGACY_VERSION },
  'tasks/cancel': { op: 'cancel', version: LEGACY_VERSION },
};

export const METHOD_OF: Record<WireVersion, Record<'send' | 'get', string>> = {
  [A2A_VERSION]: { send: 'SendMessage', get: 'GetTask' },
  [LEGACY_VERSION]: { send: 'message/send', get: 'tasks/get' },
};

/** JSON-RPC error codes of A2A. */
export const ERRORS = { taskNotFound: -32001, taskNotCancelable: -32002, unsupported: -32004, versionNotSupported: -32009 } as const;

export const TERMINAL: readonly TaskState[] = ['completed', 'failed', 'canceled', 'rejected'];
export const INTERRUPTED: readonly TaskState[] = ['input-required', 'auth-required'];

const stateWire = (s: TaskState, v: WireVersion) => (v === A2A_VERSION ? `TASK_STATE_${s.toUpperCase().replace('-', '_')}` : s);
const roleWire = (r: Role, v: WireVersion) => (v === A2A_VERSION ? (r === 'user' ? 'ROLE_USER' : 'ROLE_AGENT') : r);
const textPart = (text: string, v: WireVersion) => (v === A2A_VERSION ? { text } : { kind: 'text', text });

/** State from either version's spelling (`TASK_STATE_COMPLETED`, `completed`); undefined when unknown. */
export function stateOf(raw: unknown): TaskState | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.replace(/^TASK_STATE_/, '').toLowerCase().replace('_', '-');
  return (['submitted', 'working', 'completed', 'failed', 'canceled', 'cancelled', 'rejected', 'input-required', 'auth-required'] as const).includes(s as never)
    ? (s === 'cancelled' ? 'canceled' : s as TaskState) : undefined;
}

/** Text of a message or artifact: its text parts, and data parts as JSON, one per line. */
export function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts.map((p: Record<string, unknown>) => {
    if (typeof p?.text === 'string') return p.text;
    if (p && 'data' in p && p.data !== undefined && (p.kind === undefined || p.kind === 'data')) return JSON.stringify(p.data);
    return '';
  }).filter(Boolean).join('\n');
}

export function messageWire(m: MessageValue, v: WireVersion): Record<string, unknown> {
  return {
    ...(v === LEGACY_VERSION ? { kind: 'message' } : {}),
    messageId: m.messageId,
    role: roleWire(m.role, v),
    parts: [textPart(m.text, v)],
    ...(m.contextId ? { contextId: m.contextId } : {}),
    ...(m.taskId ? { taskId: m.taskId } : {}),
  };
}

function statusWire(t: TaskValue, v: WireVersion) {
  return { state: stateWire(t.state, v), timestamp: t.timestamp, ...(t.status ? { message: messageWire(t.status, v) } : {}) };
}

function artifactWire(t: TaskValue, v: WireVersion) {
  return { artifactId: `${t.id}-answer`, name: 'answer', parts: [textPart(t.answer ?? '', v)] };
}

export function taskWire(t: TaskValue, v: WireVersion): Record<string, unknown> {
  return {
    ...(v === LEGACY_VERSION ? { kind: 'task' } : {}),
    id: t.id,
    contextId: t.contextId,
    status: statusWire(t, v),
    ...(t.answer !== undefined ? { artifacts: [artifactWire(t, v)] } : {}),
    ...(t.metadata && Object.keys(t.metadata).length ? { metadata: { [METADATA_KEY]: t.metadata } } : {}),
  };
}

const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Usage and cost from `metadata["agent-layers"]` of a task (`metadata` is the task's whole bag), when the remote agent
 * reports them; malformed values are ignored.
 */
export function runMetadata(raw: unknown): TaskRunMetadata {
  const bag = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[METADATA_KEY] : undefined;
  const m = bag && typeof bag === 'object' ? bag as Record<string, unknown> : {};
  const u = m.usage && typeof m.usage === 'object' ? m.usage as Record<string, unknown> : undefined;
  const usage = u && count(u.inputTokens) && count(u.outputTokens) ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens } : undefined;
  return { ...(usage ? { usage } : {}), ...(count(m.costUsd) ? { costUsd: m.costUsd } : {}) };
}

/** Result of a send: 1.0 wraps the task (`{ task }`); 0.3 returns it bare. */
export const sendResult = (t: TaskValue, v: WireVersion) => (v === A2A_VERSION ? { task: taskWire(t, v) } : taskWire(t, v));
export const getResult = (t: TaskValue, v: WireVersion) => taskWire(t, v);

/** Stream events: the task at the start, the answer as an artifact, the final status. */
export function streamEvent(kind: 'task' | 'artifact' | 'status', t: TaskValue, v: WireVersion): Record<string, unknown> {
  if (kind === 'task') return v === A2A_VERSION ? { task: taskWire(t, v) } : taskWire(t, v);
  if (kind === 'artifact') {
    const body = { taskId: t.id, contextId: t.contextId, artifact: artifactWire(t, v), lastChunk: true };
    return v === A2A_VERSION ? { artifactUpdate: body } : { kind: 'artifact-update', ...body };
  }
  const body = { taskId: t.id, contextId: t.contextId, status: statusWire(t, v) };
  return v === A2A_VERSION ? { statusUpdate: body } : { kind: 'status-update', ...body, final: TERMINAL.includes(t.state) || INTERRUPTED.includes(t.state) };
}

/** Longest native state kept in `ext["a2a.state"]`. */
const MAX_NATIVE_STATE = 64;

/**
 * Reads a send or get result of either version into a task, or a direct message reply. `raw` is the wire document
 * (for mappings). A state this adapter does not know reads as `failed`, with the native value in `native`.
 */
export function readResult(result: unknown): { task?: TaskValue & { text: string; native?: string }; message?: string; raw?: unknown } {
  const r = result as Record<string, any> | undefined;
  if (!r || typeof r !== 'object') return {};
  const msg = r.message ?? (r.kind === 'message' ? r : undefined);
  if (msg && !r.task && !r.status) return { message: partsText(msg.parts), raw: msg };
  const t = r.task ?? r;
  const rawState = t?.status?.state;
  const known = stateOf(rawState);
  if (typeof t?.id !== 'string' || (!known && typeof rawState !== 'string')) return {};
  const state: TaskState = known ?? 'failed';
  const native = known ? undefined : rawState.slice(0, MAX_NATIVE_STATE);
  const answer = (Array.isArray(t.artifacts) ? t.artifacts : []).map((a: Record<string, unknown>) => partsText(a?.parts)).filter(Boolean).join('\n');
  const statusText = partsText(t.status?.message?.parts);
  const metadata = runMetadata(t.metadata);
  return {
    raw: t,
    task: { id: t.id, contextId: String(t.contextId ?? ''), state, timestamp: String(t.status?.timestamp ?? ''), text: answer || statusText, ...(native !== undefined ? { native } : {}), ...(Object.keys(metadata).length ? { metadata } : {}) },
  };
}
