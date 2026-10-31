import type { Layer } from '../layers.ts';
import type { PortBase } from './base.ts';

/** A service to run. Secrets are references resolved by the target, never values. */
export interface ServiceSpec {
  name: string;
  /** Layer the service belongs to; lets a target use its reference setup for that layer. */
  layer?: Layer;
  image?: string;
  env?: Record<string, string>;
  secretRefs?: string[];
  ports?: number[];
  health?: { url?: string; command?: string[] };
}

export interface DeployArtifact { path: string; content: string }
export interface DeployPlan { artifacts: DeployArtifact[]; steps: string[] }
export interface Endpoint { service: string; url: string }
export interface DeployOptions { profile?: string; signal?: AbortSignal; dryRun?: boolean }

/** Turn service specs into running endpoints. */
export interface DeployPort extends PortBase {
  plan(services: ServiceSpec[], opts?: DeployOptions): Promise<DeployPlan>;
  up(services: ServiceSpec[], opts?: DeployOptions): Promise<Endpoint[]>;
  down(services: ServiceSpec[], opts?: DeployOptions): Promise<void>;
}

/** Resolve a secret reference to its value. Values never reach logs or traces. */
export interface SecretPort extends PortBase {
  get(ref: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
}
