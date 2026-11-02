import type { PortBase } from './base.ts';

/** A JSON value: what a store keeps. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** A stored value. Schema: spec/schemas/store-entry.json. */
export interface StoreEntry {
  value: JsonValue;
  /** Positive integer; grows with every write of the key and is never reused for it, even after a delete or an expiry. */
  version: number;
  /** ISO 8601 time after which the key reads as absent; absent: no expiry. */
  expiresAt?: string;
}

/** A key of a listing, with its current version. */
export interface StoreKey { key: string; version: number; expiresAt?: string }

/** A write refused because the key's version is not `ifVersion`: `version` is the current one, absent for no key. */
export interface StoreConflict { ok: false; version?: number }

export type StoreSetResult = { ok: true; version: number } | StoreConflict;
export type StoreDeleteResult = { ok: true; existed: boolean } | StoreConflict;

export interface StoreSetOptions {
  /** Write only when the key's current version is this one; `0` means "only when the key is absent". */
  ifVersion?: number;
  /** The key expires this many milliseconds after the write; absent: no expiry. */
  ttlMs?: number;
}

/**
 * Durable small JSON values by key, with versions for compare-and-set. Keys are `<namespace>.<name>`, so components
 * sharing a store cannot collide; the `sdk` namespace is the core's.
 */
export interface StorePort extends PortBase {
  get(key: string): Promise<StoreEntry | undefined>;
  set(key: string, value: JsonValue, opts?: StoreSetOptions): Promise<StoreSetResult>;
  delete(key: string, opts?: { ifVersion?: number }): Promise<StoreDeleteResult>;
  /** Keys that start with `prefix`, in key order, after `after` when given; at most `limit` (capped by the adapter). */
  list?(prefix: string, opts?: { limit?: number; after?: string }): Promise<StoreKey[]>;
}
