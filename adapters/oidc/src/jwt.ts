import { constants, createPublicKey, verify as cryptoVerify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { OidcError } from './http.ts';

/** A JSON Web Key from a JWKS (RFC 7517). Only public members are used. */
export interface Jwk { kty: string; kid?: string; use?: string; alg?: string; key_ops?: string[]; crv?: string; [member: string]: unknown }

export interface DecodedJwt {
  header: { alg: string; kid?: string; typ?: string; crit?: unknown; [k: string]: unknown };
  payload: Record<string, unknown>;
  signingInput: Buffer;
  signature: Buffer;
}

interface AlgSpec { kty: 'RSA' | 'EC' | 'OKP'; hash: string | null; pss?: boolean; curve?: string }

/** Asymmetric JWS algorithms (RFC 7518, RFC 8037). `none` and the symmetric `HS*` are never accepted. */
export const JWS_ALGORITHMS: Readonly<Record<string, AlgSpec>> = Object.freeze({
  RS256: { kty: 'RSA', hash: 'sha256' },
  RS384: { kty: 'RSA', hash: 'sha384' },
  RS512: { kty: 'RSA', hash: 'sha512' },
  PS256: { kty: 'RSA', hash: 'sha256', pss: true },
  PS384: { kty: 'RSA', hash: 'sha384', pss: true },
  PS512: { kty: 'RSA', hash: 'sha512', pss: true },
  ES256: { kty: 'EC', hash: 'sha256', curve: 'prime256v1' },
  ES384: { kty: 'EC', hash: 'sha384', curve: 'secp384r1' },
  ES512: { kty: 'EC', hash: 'sha512', curve: 'secp521r1' },
  EdDSA: { kty: 'OKP', hash: null, curve: 'ed25519' },
});

/** Largest compact JWT accepted, in characters. */
export const MAX_TOKEN_CHARS = 16_384;
const MIN_RSA_BITS = 2048;
const B64URL = /^[A-Za-z0-9_-]+$/;

const invalid = (why: string) => new OidcError('invalid_token', why);

function segment(part: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw invalid(`malformed token ${what}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`malformed token ${what}`);
  return value as Record<string, unknown>;
}

/** Splits and decodes a compact JWS (RFC 7515) without verifying it. */
export function decodeJwt(token: string): DecodedJwt {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_CHARS) throw invalid('malformed token');
  const parts = token.split('.');
  if (parts.length !== 3 || !B64URL.test(parts[0]!) || !B64URL.test(parts[1]!) || !(parts[2] === '' || B64URL.test(parts[2]!))) throw invalid('malformed token');
  const header = segment(parts[0]!, 'header');
  const payload = segment(parts[1]!, 'payload');
  if (typeof header.alg !== 'string') throw invalid('token header has no "alg"');
  if (header.kid !== undefined && typeof header.kid !== 'string') throw invalid('token header "kid" must be a string');
  return {
    header: header as DecodedJwt['header'],
    payload,
    signingInput: Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'),
    signature: Buffer.from(parts[2]!, 'base64url'),
  };
}

/** Throws unless `alg` is an asymmetric algorithm that is on the allow-list. */
export function checkAlgorithm(alg: string, allowed: readonly string[]): AlgSpec {
  if (alg === 'none' || /^HS/i.test(alg)) throw invalid(`token algorithm "${alg}" is not accepted`);
  const spec = Object.hasOwn(JWS_ALGORITHMS, alg) ? JWS_ALGORITHMS[alg] : undefined;
  if (!spec || !allowed.includes(alg)) throw invalid(`token algorithm "${alg}" is not allowed`);
  return spec;
}

/** Keys of a JWKS that may verify a token signed with `alg` (and `kid`, when the token names one). */
export function candidateKeys(keys: readonly Jwk[], alg: string, kid: string | undefined): Jwk[] {
  const spec = JWS_ALGORITHMS[alg];
  if (!spec) return [];
  return keys.filter((k) =>
    !!k && typeof k === 'object' && k.kty === spec.kty &&
    (kid === undefined || k.kid === kid) &&
    (k.use === undefined || k.use === 'sig') &&
    (k.alg === undefined || k.alg === alg) &&
    (!Array.isArray(k.key_ops) || k.key_ops.includes('verify')));
}

const imported = new WeakMap<Jwk, Map<string, KeyObject>>();

/** Imports the public part of a JWK and checks that it fits the algorithm (key type, curve, RSA size). */
export function importKey(jwk: Jwk, alg: string): KeyObject {
  const cached = imported.get(jwk)?.get(alg);
  if (cached) return cached;
  const spec = JWS_ALGORITHMS[alg];
  if (!spec) throw invalid(`token algorithm "${alg}" is not supported`);
  // Public members only: a JWKS must never carry private parts, and verification never needs them.
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, oth: _oth, k: _k, ...pub } = jwk;
  let key: KeyObject;
  try {
    key = createPublicKey({ key: pub as JsonWebKey, format: 'jwk' });
  } catch {
    throw invalid('signing key cannot be imported');
  }
  const details = key.asymmetricKeyDetails;
  if (spec.kty === 'RSA' && (key.asymmetricKeyType !== 'rsa' || (details?.modulusLength ?? 0) < MIN_RSA_BITS)) throw invalid('signing key is not an RSA key of at least 2048 bits');
  if (spec.kty === 'EC' && (key.asymmetricKeyType !== 'ec' || details?.namedCurve !== spec.curve)) throw invalid(`signing key curve does not match ${alg}`);
  if (spec.kty === 'OKP' && key.asymmetricKeyType !== spec.curve) throw invalid(`signing key type does not match ${alg}`);
  let byAlg = imported.get(jwk);
  if (!byAlg) imported.set(jwk, (byAlg = new Map()));
  byAlg.set(alg, key);
  return key;
}

/** Verifies the JWS signature of a decoded token with one public key. */
export function verifySignature(jwt: DecodedJwt, key: KeyObject): boolean {
  const spec = JWS_ALGORITHMS[jwt.header.alg];
  if (!spec || !jwt.signature.length) return false;
  try {
    if (spec.kty === 'RSA') {
      return cryptoVerify(spec.hash, jwt.signingInput, spec.pss
        ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }
        : { key, padding: constants.RSA_PKCS1_PADDING }, jwt.signature);
    }
    if (spec.kty === 'EC') return cryptoVerify(spec.hash, jwt.signingInput, { key, dsaEncoding: 'ieee-p1363' }, jwt.signature);
    return cryptoVerify(null, jwt.signingInput, key, jwt.signature);
  } catch {
    return false;
  }
}

/** `exp` of a JWT read without verification: for cache timing only, never for trust. */
export function unverifiedExpiry(token: string): number | undefined {
  try {
    const exp = decodeJwt(token).payload.exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : undefined;
  } catch {
    return undefined;
  }
}
