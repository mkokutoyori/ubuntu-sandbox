import {
  LEGACY_CIPHER_SUITES, isImplementedLegacySuite, type LegacySuiteDefinition,
} from './legacyCipherSuites';

export type CipherListResult =
  | { readonly ok: true; readonly suites: readonly LegacySuiteDefinition[] }
  | { readonly ok: false; readonly error: string };

const IMPLEMENTED: readonly LegacySuiteDefinition[] = LEGACY_CIPHER_SUITES.filter(isImplementedLegacySuite);

const UNCLASSIFIED_STRENGTH_CIPHERS: ReadonlySet<string> = new Set(['3DES_EDE_CBC']);

type Predicate = (suite: LegacySuiteDefinition) => boolean;

const KEYWORDS: Readonly<Record<string, Predicate>> = {
  ALL: (s) => IMPLEMENTED.includes(s),
  DEFAULT: (s) => IMPLEMENTED.includes(s) && !UNCLASSIFIED_STRENGTH_CIPHERS.has(s.cipher),
  HIGH: (s) => IMPLEMENTED.includes(s) && !UNCLASSIFIED_STRENGTH_CIPHERS.has(s.cipher),
  kRSA: (s) => s.keyExchange === 'RSA',
  RSA: (s) => s.keyExchange === 'RSA',
  aRSA: (s) => s.keyExchange !== 'ECDHE_ECDSA',
  aECDSA: (s) => s.keyExchange === 'ECDHE_ECDSA',
  ECDSA: (s) => s.keyExchange === 'ECDHE_ECDSA',
  ECDHE: (s) => s.keyExchange === 'ECDHE_RSA' || s.keyExchange === 'ECDHE_ECDSA',
  EECDH: (s) => s.keyExchange === 'ECDHE_RSA' || s.keyExchange === 'ECDHE_ECDSA',
  kECDHE: (s) => s.keyExchange === 'ECDHE_RSA' || s.keyExchange === 'ECDHE_ECDSA',
  DHE: (s) => s.keyExchange === 'DHE_RSA',
  EDH: (s) => s.keyExchange === 'DHE_RSA',
  kDHE: (s) => s.keyExchange === 'DHE_RSA',
  kEDH: (s) => s.keyExchange === 'DHE_RSA',
  AESGCM: (s) => s.cipher === 'AES_128_GCM' || s.cipher === 'AES_256_GCM',
  AES128: (s) => s.cipher === 'AES_128_GCM' || s.cipher === 'AES_128_CBC',
  AES256: (s) => s.cipher === 'AES_256_GCM' || s.cipher === 'AES_256_CBC',
  AES: (s) => s.cipher.startsWith('AES'),
  '3DES': (s) => s.cipher === '3DES_EDE_CBC',
  RC4: (s) => s.cipher === 'RC4_128',
  SHA1: (s) => s.mac === 'SHA1',
  SHA: (s) => s.mac === 'SHA1',
  SHA256: (s) => s.mac === 'SHA256',
  SHA384: (s) => s.mac === 'SHA384',
  TLSv1: (s) => s.minVersion === '1.0',
  'TLSv1.0': (s) => s.minVersion === '1.0',
  'TLSv1.2': (s) => s.minVersion === '1.2',
  eNULL: () => false,
  NULL: () => false,
  aNULL: () => false,
  MD5: () => false,
  CHACHA20: () => false,
  MEDIUM: () => false,
  LOW: () => false,
};

function keyBits(suite: LegacySuiteDefinition): number {
  switch (suite.cipher) {
    case 'AES_256_GCM': case 'AES_256_CBC': return 256;
    case '3DES_EDE_CBC': return 112;
    default: return 128;
  }
}

function matcher(token: string): Predicate {
  const exact = IMPLEMENTED.find((suite) => suite.opensslName === token);
  if (exact) return (s) => s === exact;
  const parts = token.split('+');
  const predicates = parts.map((part) => KEYWORDS[part]);
  if (predicates.some((p) => p === undefined)) return () => false;
  return (s) => predicates.every((p) => p(s));
}

export function expandCipherString(spec: string): CipherListResult {
  let active: LegacySuiteDefinition[] = [];
  const killed = new Set<LegacySuiteDefinition>();
  for (const raw of spec.split(/[:, ]+/).filter((t) => t.length > 0)) {
    if (raw.startsWith('@')) {
      if (raw === '@STRENGTH') {
        active = [...active].sort((a, b) => keyBits(b) - keyBits(a));
        continue;
      }
      return { ok: false, error: `${raw} is not evaluated by this simulator` };
    }
    const op = raw[0] === '!' || raw[0] === '-' || raw[0] === '+' ? raw[0] : '';
    const token = op ? raw.slice(1) : raw;
    const matches = IMPLEMENTED.filter(matcher(token));
    if (op === '!') {
      for (const suite of matches) killed.add(suite);
      active = active.filter((s) => !matches.includes(s));
    } else if (op === '-') {
      active = active.filter((s) => !matches.includes(s));
    } else if (op === '+') {
      const moved = active.filter((s) => matches.includes(s));
      active = [...active.filter((s) => !matches.includes(s)), ...moved];
    } else {
      for (const suite of matches) {
        if (!killed.has(suite) && !active.includes(suite)) active.push(suite);
      }
    }
  }
  if (active.length === 0) return { ok: false, error: 'no cipher match' };
  return { ok: true, suites: active };
}

export function verboseCipherLine(suite: LegacySuiteDefinition): string {
  const kx = suite.keyExchange === 'RSA' ? 'RSA' : suite.keyExchange === 'DHE_RSA' ? 'DH' : 'ECDH';
  const au = suite.keyExchange === 'ECDHE_ECDSA' ? 'ECDSA' : 'RSA';
  const bits = keyBits(suite);
  const enc = suite.cipher.includes('GCM') ? `AESGCM(${bits})`
    : suite.cipher === '3DES_EDE_CBC' ? '3DES(168)' : `AES(${bits})`;
  const mac = suite.mac === 'AEAD' ? 'AEAD' : suite.mac;
  const version = suite.minVersion === '1.2' ? 'TLSv1.2' : 'SSLv3';
  return `${suite.opensslName.padEnd(30)} ${version.padEnd(7)} Kx=${kx.padEnd(8)} Au=${au.padEnd(5)} Enc=${enc.padEnd(12)} Mac=${mac}`;
}
