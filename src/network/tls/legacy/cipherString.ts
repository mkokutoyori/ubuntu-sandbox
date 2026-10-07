import {
  OPENSSL_CIPHER_TABLE, type OpensslCipherEntry, type OpensslEnc,
} from './opensslCipherTable';

const K_RSA = 0x01;
const K_DHE = 0x02;
const K_ECDHE = 0x04;

const A_RSA = 0x01;
const A_ECDSA = 0x08;

const E_3DES = 0x00000002;
const E_AES128 = 0x00000040;
const E_AES256 = 0x00000080;
const E_AES128GCM = 0x00001000;
const E_AES256GCM = 0x00002000;
const E_AES128CCM = 0x00004000;
const E_AES256CCM = 0x00008000;
const E_AES128CCM8 = 0x00010000;
const E_AES256CCM8 = 0x00020000;
const E_CHACHA20 = 0x00080000;
const E_NULL = 0x00000020;
const E_CAMELLIA128 = 0x00000100;
const E_CAMELLIA256 = 0x00000200;
const E_ARIA128GCM = 0x00100000;
const E_ARIA256GCM = 0x00200000;
const E_CAMELLIA = E_CAMELLIA128 | E_CAMELLIA256;
const E_ARIAGCM = E_ARIA128GCM | E_ARIA256GCM;
const E_AESGCM = E_AES128GCM | E_AES256GCM;
const E_AESCCM = E_AES128CCM | E_AES256CCM | E_AES128CCM8 | E_AES256CCM8;
const E_AES = E_AES128 | E_AES256 | E_AESGCM | E_AESCCM;
const E_CBC = E_3DES | E_CAMELLIA;

const M_SHA1 = 0x02;
const M_SHA256 = 0x10;
const M_SHA384 = 0x20;
const M_AEAD = 0x40;

const S_LOW = 0x02;
const S_MEDIUM = 0x04;
const S_HIGH = 0x08;
const S_FIPS = 0x10;
const S_NOT_DEFAULT = 0x20;
const STRONG_MASK = 0x1f;
const DEFAULT_MASK = 0x20;

export const SSL3_VERSION = 0x0300;
export const TLS1_VERSION = 0x0301;
export const TLS1_1_VERSION = 0x0302;
export const TLS1_2_VERSION = 0x0303;
export const TLS1_3_VERSION = 0x0304;

const ENC_BITS: Readonly<Record<OpensslEnc, number>> = {
  '3DES': E_3DES, AES128: E_AES128, AES256: E_AES256, AES128GCM: E_AES128GCM, AES256GCM: E_AES256GCM,
  AES128CCM: E_AES128CCM, AES256CCM: E_AES256CCM, AES128CCM8: E_AES128CCM8, AES256CCM8: E_AES256CCM8,
  CHACHA20: E_CHACHA20, CAMELLIA128: E_CAMELLIA128, CAMELLIA256: E_CAMELLIA256,
  ARIA128GCM: E_ARIA128GCM, ARIA256GCM: E_ARIA256GCM,
};

const MKEY_BITS = { RSA: K_RSA, DHE: K_DHE, ECDHE: K_ECDHE } as const;
const AUTH_BITS = { RSA: A_RSA, ECDSA: A_ECDSA } as const;
const MAC_BITS = { SHA1: M_SHA1, SHA256: M_SHA256, SHA384: M_SHA384, AEAD: M_AEAD } as const;
const MIN_TLS_VALUE = { SSL3: SSL3_VERSION, TLS1: TLS1_VERSION, TLS1_2: TLS1_2_VERSION } as const;
const FLAG_BITS = { LOW: S_LOW, MEDIUM: S_MEDIUM, HIGH: S_HIGH, FIPS: S_FIPS, NOT_DEFAULT: S_NOT_DEFAULT } as const;

export interface OpensslCipher {
  readonly entry: OpensslCipherEntry;
  readonly name: string;
  readonly standardName: string;
  readonly id: number;
  readonly mkey: number;
  readonly auth: number;
  readonly enc: number;
  readonly mac: number;
  readonly minTls: number;
  readonly algoStrength: number;
  readonly strengthBits: number;
  readonly aead: boolean;
}

function toCipher(entry: OpensslCipherEntry): OpensslCipher {
  return {
    entry, name: entry.openssl, standardName: entry.standard, id: 0x03000000 | entry.code,
    mkey: MKEY_BITS[entry.mkey], auth: AUTH_BITS[entry.auth], enc: ENC_BITS[entry.enc],
    mac: MAC_BITS[entry.mac], minTls: MIN_TLS_VALUE[entry.minTls],
    algoStrength: entry.flags.reduce((bits, flag) => bits | FLAG_BITS[flag], 0),
    strengthBits: entry.strengthBits, aead: entry.mac === 'AEAD',
  };
}

export const ALL_CIPHERS: readonly OpensslCipher[] = OPENSSL_CIPHER_TABLE.map(toCipher);

export interface Tls13Cipher {
  readonly name: string;
  readonly id: number;
  readonly enc: number;
  readonly encLabel: string;
  readonly bits: number;
  readonly notDefault: boolean;
}

export const TLS13_CIPHERS: readonly Tls13Cipher[] = [
  { name: 'TLS_AES_128_GCM_SHA256', id: 0x03001301, enc: E_AES128GCM, encLabel: 'AESGCM(128)', bits: 128, notDefault: false },
  { name: 'TLS_AES_256_GCM_SHA384', id: 0x03001302, enc: E_AES256GCM, encLabel: 'AESGCM(256)', bits: 256, notDefault: false },
  { name: 'TLS_CHACHA20_POLY1305_SHA256', id: 0x03001303, enc: E_CHACHA20, encLabel: 'CHACHA20/POLY1305(256)', bits: 256, notDefault: false },
  { name: 'TLS_AES_128_CCM_SHA256', id: 0x03001304, enc: E_AES128CCM, encLabel: 'AESCCM(128)', bits: 128, notDefault: true },
  { name: 'TLS_AES_128_CCM_8_SHA256', id: 0x03001305, enc: E_AES128CCM8, encLabel: 'AESCCM8(128)', bits: 128, notDefault: true },
];

export const DEFAULT_TLS13_CIPHERSUITES = 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256';
export const DEFAULT_CIPHER_RULE = 'ALL:!COMPLEMENTOFDEFAULT:!eNULL';

interface Alias {
  readonly name: string;
  readonly mkey?: number;
  readonly auth?: number;
  readonly enc?: number;
  readonly mac?: number;
  readonly minTls?: number;
  readonly algoStrength?: number;
  readonly cipher?: OpensslCipher;
}

const NOT_ENULL = (~E_NULL) >>> 0;
const NOT_ANULL = (~0x04) >>> 0;

const GROUP_ALIASES: readonly Alias[] = [
  { name: 'ALL', enc: NOT_ENULL },
  { name: 'COMPLEMENTOFDEFAULT', algoStrength: S_NOT_DEFAULT },
  { name: 'kRSA', mkey: K_RSA },
  { name: 'kEDH', mkey: K_DHE },
  { name: 'kDHE', mkey: K_DHE },
  { name: 'DH', mkey: K_DHE },
  { name: 'kEECDH', mkey: K_ECDHE },
  { name: 'kECDHE', mkey: K_ECDHE },
  { name: 'ECDH', mkey: K_ECDHE },
  { name: 'aRSA', auth: A_RSA },
  { name: 'aECDSA', auth: A_ECDSA },
  { name: 'ECDSA', auth: A_ECDSA },
  { name: 'EDH', mkey: K_DHE, auth: NOT_ANULL },
  { name: 'DHE', mkey: K_DHE, auth: NOT_ANULL },
  { name: 'EECDH', mkey: K_ECDHE, auth: NOT_ANULL },
  { name: 'ECDHE', mkey: K_ECDHE, auth: NOT_ANULL },
  { name: 'RSA', mkey: K_RSA, auth: A_RSA },
  { name: '3DES', enc: E_3DES },
  { name: 'AES128', enc: E_AES128 | E_AES128GCM | E_AES128CCM | E_AES128CCM8 },
  { name: 'AES256', enc: E_AES256 | E_AES256GCM | E_AES256CCM | E_AES256CCM8 },
  { name: 'AES', enc: E_AES },
  { name: 'AESGCM', enc: E_AESGCM },
  { name: 'AESCCM', enc: E_AESCCM },
  { name: 'AESCCM8', enc: E_AES128CCM8 | E_AES256CCM8 },
  { name: 'CHACHA20', enc: E_CHACHA20 },
  { name: 'CAMELLIA128', enc: E_CAMELLIA128 },
  { name: 'CAMELLIA256', enc: E_CAMELLIA256 },
  { name: 'CAMELLIA', enc: E_CAMELLIA },
  { name: 'ARIA128', enc: E_ARIA128GCM },
  { name: 'ARIA256', enc: E_ARIA256GCM },
  { name: 'ARIA', enc: E_ARIAGCM },
  { name: 'ARIAGCM', enc: E_ARIAGCM },
  { name: 'CBC', enc: E_CBC },
  { name: 'SHA1', mac: M_SHA1 },
  { name: 'SHA', mac: M_SHA1 },
  { name: 'SHA256', mac: M_SHA256 },
  { name: 'SHA384', mac: M_SHA384 },
  { name: 'SSLv3', minTls: SSL3_VERSION },
  { name: 'TLSv1', minTls: TLS1_VERSION },
  { name: 'TLSv1.0', minTls: TLS1_VERSION },
  { name: 'TLSv1.2', minTls: TLS1_2_VERSION },
  { name: 'LOW', algoStrength: S_LOW },
  { name: 'MEDIUM', algoStrength: S_MEDIUM },
  { name: 'HIGH', algoStrength: S_HIGH },
  { name: 'FIPS', enc: NOT_ENULL, algoStrength: S_FIPS },
  { name: 'EDH-RSA-DES-CBC3-SHA', mkey: K_DHE, auth: A_RSA, enc: E_3DES, mac: M_SHA1, algoStrength: S_HIGH | S_FIPS },
];

interface Node {
  readonly cipher: OpensslCipher;
  active: boolean;
  prev: Node | null;
  next: Node | null;
}

interface Chain {
  head: Node | null;
  tail: Node | null;
}

const enum Rule { Add, Order, Delete, Bump, Kill }

function appendTail(chain: Chain, node: Node): void {
  if (node === chain.tail) return;
  if (node === chain.head) chain.head = node.next;
  if (node.prev) node.prev.next = node.next;
  if (node.next) node.next.prev = node.prev;
  chain.tail!.next = node;
  node.prev = chain.tail;
  node.next = null;
  chain.tail = node;
}

function appendHead(chain: Chain, node: Node): void {
  if (node === chain.head) return;
  if (node === chain.tail) chain.tail = node.prev;
  if (node.next) node.next.prev = node.prev;
  if (node.prev) node.prev.next = node.next;
  chain.head!.prev = node;
  node.next = chain.head;
  node.prev = null;
  chain.head = node;
}

interface Selector {
  cipherId: number;
  mkey: number;
  auth: number;
  enc: number;
  mac: number;
  minTls: number;
  algoStrength: number;
}

function applyRule(chain: Chain, rule: Rule, selector: Selector, strengthBits: number): void {
  const reverse = rule === Rule.Delete || rule === Rule.Bump;
  let next = reverse ? chain.tail : chain.head;
  const last = reverse ? chain.head : chain.tail;
  let node: Node | null = null;
  for (;;) {
    if (node === last) break;
    node = next;
    if (node === null) break;
    next = reverse ? node.prev : node.next;
    const cp = node.cipher;
    if (strengthBits >= 0) {
      if (strengthBits !== cp.strengthBits) continue;
    } else {
      if (selector.cipherId !== 0 && selector.cipherId !== cp.id) continue;
      if (selector.mkey && !(selector.mkey & cp.mkey)) continue;
      if (selector.auth && !(selector.auth & cp.auth)) continue;
      if (selector.enc && !(selector.enc & cp.enc)) continue;
      if (selector.mac && !(selector.mac & cp.mac)) continue;
      if (selector.minTls && selector.minTls !== cp.minTls) continue;
      if ((selector.algoStrength & STRONG_MASK) && !(selector.algoStrength & STRONG_MASK & cp.algoStrength)) continue;
      if ((selector.algoStrength & DEFAULT_MASK) && !(selector.algoStrength & DEFAULT_MASK & cp.algoStrength)) continue;
    }
    if (rule === Rule.Add) {
      if (!node.active) { appendTail(chain, node); node.active = true; }
    } else if (rule === Rule.Order) {
      if (node.active) appendTail(chain, node);
    } else if (rule === Rule.Delete) {
      if (node.active) { appendHead(chain, node); node.active = false; }
    } else if (rule === Rule.Bump) {
      if (node.active) appendHead(chain, node);
    } else {
      if (chain.head === node) chain.head = node.next;
      else if (node.prev) node.prev.next = node.next;
      if (chain.tail === node) chain.tail = node.prev;
      node.active = false;
      if (node.next) node.next.prev = node.prev;
      if (node.prev) node.prev.next = node.next;
      node.next = null;
      node.prev = null;
    }
  }
}

function plainSelector(partial: Partial<Selector>): Selector {
  return { cipherId: 0, mkey: 0, auth: 0, enc: 0, mac: 0, minTls: 0, algoStrength: 0, ...partial };
}

function strengthSort(chain: Chain): void {
  let max = 0;
  for (let node = chain.head; node; node = node.next) {
    if (node.active && node.cipher.strengthBits > max) max = node.cipher.strengthBits;
  }
  const uses = new Array<number>(max + 1).fill(0);
  for (let node = chain.head; node; node = node.next) {
    if (node.active) uses[node.cipher.strengthBits]++;
  }
  for (let i = max; i >= 0; i--) {
    if (uses[i] > 0) applyRule(chain, Rule.Order, plainSelector({}), i);
  }
}

export interface CipherListOptions {
  readonly isAvailable?: (cipher: OpensslCipher) => boolean;
  readonly tls13Suites?: string;
  readonly isTls13Available?: (cipher: Tls13Cipher) => boolean;
}

export type CipherListResult =
  | {
    readonly ok: true;
    readonly ciphers: readonly OpensslCipher[];
    readonly tls13: readonly Tls13Cipher[];
    readonly securityLevel: number | null;
  }
  | { readonly ok: false; readonly error: string; readonly reason: 'invalid command' | 'no cipher match' };

export function openSslErrorText(reason: 'invalid command' | 'no cipher match'): string {
  const code = reason === 'invalid command' ? 280 : 185;
  return `error:${(0x0a000000 + code).toString(16).toUpperCase().padStart(8, '0')}:SSL routines::${reason}`;
}

function isItemSeparator(ch: string): boolean {
  return ch === ':' || ch === ' ' || ch === ';' || ch === ',';
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9\-.=]/.test(ch);
}

interface RuleContext {
  securityLevel: number | null;
}

function buildAliases(chain: Chain): Alias[] {
  const enabled = { mkey: 0, auth: 0, enc: 0, mac: 0 };
  for (let node = chain.head; node; node = node.next) {
    enabled.mkey |= node.cipher.mkey;
    enabled.auth |= node.cipher.auth;
    enabled.enc |= node.cipher.enc;
    enabled.mac |= node.cipher.mac;
  }
  const aliases: Alias[] = [];
  for (const alias of GROUP_ALIASES) {
    if (alias.mkey && !(alias.mkey & enabled.mkey)) continue;
    if (alias.auth && !(alias.auth & enabled.auth)) continue;
    if (alias.enc && !(alias.enc & enabled.enc)) continue;
    if (alias.mac && !(alias.mac & enabled.mac)) continue;
    aliases.push(alias);
  }
  const explicit: Alias[] = [];
  for (let node = chain.head; node; node = node.next) {
    const c = node.cipher;
    explicit.push({ name: c.name, mkey: c.mkey, auth: c.auth, enc: c.enc, mac: c.mac, minTls: c.minTls, algoStrength: c.algoStrength, cipher: c });
  }
  return [...explicit, ...aliases];
}

function processRuleString(rule: string, chain: Chain, aliases: readonly Alias[], context: RuleContext): boolean {
  let l = 0;
  let retval = true;
  for (;;) {
    let ch = rule[l] ?? '';
    if (ch === '') break;
    let action = Rule.Add;
    let special = false;
    if (ch === '-') { action = Rule.Delete; l++; }
    else if (ch === '+') { action = Rule.Order; l++; }
    else if (ch === '!') { action = Rule.Kill; l++; }
    else if (ch === '@') { special = true; l++; }
    if (isItemSeparator(ch)) { l++; continue; }

    let mkey = 0;
    let auth = 0;
    let enc = 0;
    let mac = 0;
    let minTls = 0;
    let algoStrength = 0;
    let cipherId = 0;
    let found = false;
    let word = '';

    for (;;) {
      ch = rule[l] ?? '';
      const start = l;
      while (isWordChar(ch)) { l++; ch = rule[l] ?? ''; }
      word = rule.slice(start, l);
      if (word.length === 0) return false;
      if (special) break;

      let multi = false;
      if (ch === '+') { multi = true; l++; }

      const alias = aliases.find((candidate) => candidate.name === word);
      found = alias !== undefined;
      if (!alias) break;

      if (alias.mkey) {
        if (mkey) { mkey &= alias.mkey; if (!mkey) { found = false; break; } } else mkey = alias.mkey;
      }
      if (alias.auth) {
        if (auth) { auth &= alias.auth; if (!auth) { found = false; break; } } else auth = alias.auth;
      }
      if (alias.enc) {
        if (enc) { enc &= alias.enc; if (!enc) { found = false; break; } } else enc = alias.enc;
      }
      if (alias.mac) {
        if (mac) { mac &= alias.mac; if (!mac) { found = false; break; } } else mac = alias.mac;
      }
      const strong = (alias.algoStrength ?? 0) & STRONG_MASK;
      if (strong) {
        if (algoStrength & STRONG_MASK) {
          algoStrength &= (strong | ~STRONG_MASK) >>> 0;
          if (!(algoStrength & STRONG_MASK)) { found = false; break; }
        } else {
          algoStrength = strong;
        }
      }
      const defaultBits = (alias.algoStrength ?? 0) & DEFAULT_MASK;
      if (defaultBits) {
        if (algoStrength & DEFAULT_MASK) {
          algoStrength &= (defaultBits | ~DEFAULT_MASK) >>> 0;
          if (!(algoStrength & DEFAULT_MASK)) { found = false; break; }
        } else {
          algoStrength |= defaultBits;
        }
      }
      if (alias.cipher) {
        cipherId = alias.cipher.id;
      } else if (alias.minTls) {
        if (minTls !== 0 && minTls !== alias.minTls) { found = false; break; }
        minTls = alias.minTls;
      }
      if (!multi) break;
    }

    if (special) {
      let ok = false;
      if (word === 'STRENGTH') {
        strengthSort(chain);
        ok = true;
      } else if (word.length === 10 && word.startsWith('SECLEVEL=')) {
        const level = word.charCodeAt(9) - 48;
        if (level >= 0 && level <= 5) { context.securityLevel = level; ok = true; }
      }
      if (!ok) retval = false;
      while (l < rule.length && !isItemSeparator(rule[l])) l++;
    } else if (found) {
      applyRule(chain, action, { cipherId, mkey, auth, enc, mac, minTls, algoStrength }, -1);
    } else {
      while (l < rule.length && !isItemSeparator(rule[l])) l++;
    }
    if (l >= rule.length) break;
  }
  return retval;
}

function parseTls13(list: string, available: (cipher: Tls13Cipher) => boolean): Tls13Cipher[] {
  const out: Tls13Cipher[] = [];
  for (const name of list.split(':')) {
    const cipher = TLS13_CIPHERS.find((candidate) => candidate.name === name);
    if (cipher && available(cipher) && !out.includes(cipher)) out.push(cipher);
  }
  return out;
}

export function createCipherList(ruleString: string, options: CipherListOptions = {}): CipherListResult {
  const available = options.isAvailable ?? (() => true);
  const nodes: Node[] = ALL_CIPHERS.filter(available).map((cipher) => ({ cipher, active: false, prev: null, next: null }));
  const chain: Chain = { head: null, tail: null };
  nodes.forEach((node, index) => {
    node.prev = index > 0 ? nodes[index - 1] : null;
    node.next = index < nodes.length - 1 ? nodes[index + 1] : null;
  });
  chain.head = nodes[0] ?? null;
  chain.tail = nodes[nodes.length - 1] ?? null;

  const add = (selector: Partial<Selector>, rule: Rule = Rule.Add): void => applyRule(chain, rule, plainSelector(selector), -1);
  add({ mkey: K_ECDHE, auth: A_ECDSA });
  add({ mkey: K_ECDHE });
  add({ mkey: K_ECDHE }, Rule.Delete);
  add({ enc: E_AESGCM });
  add({ enc: E_CHACHA20 });
  add({ enc: (E_AES ^ E_AESGCM) >>> 0 });
  add({});
  add({ mac: 0x01 }, Rule.Order);
  add({ auth: 0x04 }, Rule.Order);
  add({ mkey: K_RSA }, Rule.Order);
  add({ mkey: 0x08 }, Rule.Order);
  add({ enc: 0x04 }, Rule.Order);
  strengthSort(chain);
  add({ minTls: TLS1_2_VERSION }, Rule.Bump);
  add({ mac: M_AEAD }, Rule.Bump);
  add({ mkey: K_DHE | K_ECDHE }, Rule.Bump);
  add({ mkey: K_DHE | K_ECDHE, mac: M_AEAD }, Rule.Bump);
  add({}, Rule.Delete);

  const aliases = buildAliases(chain);
  const context: RuleContext = { securityLevel: null };
  let ok = true;
  let rest = ruleString;
  if (ruleString.startsWith('DEFAULT')) {
    ok = processRuleString(DEFAULT_CIPHER_RULE, chain, aliases, context);
    rest = ruleString.slice(7);
    if (rest.startsWith(':')) rest = rest.slice(1);
  }
  if (ok && rest.length > 0) ok = processRuleString(rest, chain, aliases, context);
  if (!ok) return { ok: false, error: openSslErrorText('invalid command'), reason: 'invalid command' };

  const ciphers: OpensslCipher[] = [];
  for (let node = chain.head; node; node = node.next) if (node.active) ciphers.push(node.cipher);
  if (ciphers.length === 0) return { ok: false, error: openSslErrorText('no cipher match'), reason: 'no cipher match' };
  const tls13 = parseTls13(options.tls13Suites ?? DEFAULT_TLS13_CIPHERSUITES, options.isTls13Available ?? (() => true));
  return { ok: true, ciphers, tls13, securityLevel: context.securityLevel };
}

export function protocolString(minTls: number): string {
  switch (minTls) {
    case TLS1_3_VERSION: return 'TLSv1.3';
    case TLS1_2_VERSION: return 'TLSv1.2';
    case TLS1_1_VERSION: return 'TLSv1.1';
    case TLS1_VERSION: return 'TLSv1';
    case SSL3_VERSION: return 'SSLv3';
    default: return 'unknown';
  }
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

const ENC_LABEL: Readonly<Record<OpensslEnc, string>> = {
  '3DES': '3DES(168)', AES128: 'AES(128)', AES256: 'AES(256)', AES128GCM: 'AESGCM(128)', AES256GCM: 'AESGCM(256)',
  AES128CCM: 'AESCCM(128)', AES256CCM: 'AESCCM(256)', AES128CCM8: 'AESCCM8(128)', AES256CCM8: 'AESCCM8(256)',
  CHACHA20: 'CHACHA20/POLY1305(256)', CAMELLIA128: 'Camellia(128)', CAMELLIA256: 'Camellia(256)',
  ARIA128GCM: 'ARIAGCM(128)', ARIA256GCM: 'ARIAGCM(256)',
};

export function cipherDescription(cipher: OpensslCipher): string {
  const version = protocolString(cipher.minTls);
  const kx = cipher.entry.mkey === 'RSA' ? 'RSA' : cipher.entry.mkey === 'DHE' ? 'DH' : 'ECDH';
  return `${pad(cipher.name, 30)} ${pad(version, 7)} Kx=${pad(kx, 8)} Au=${pad(cipher.entry.auth, 5)} `
    + `Enc=${pad(ENC_LABEL[cipher.entry.enc], 22)} Mac=${pad(cipher.entry.mac, 4)}\n`;
}

export function tls13Description(cipher: Tls13Cipher): string {
  return `${pad(cipher.name, 30)} ${pad('TLSv1.3', 7)} Kx=${pad('any', 8)} Au=${pad('any', 5)} `
    + `Enc=${pad(cipher.encLabel, 22)} Mac=${pad('AEAD', 4)}\n`;
}

export function cipherByOpensslName(name: string): OpensslCipher | undefined {
  return ALL_CIPHERS.find((cipher) => cipher.name === name);
}

export function cipherByStandardName(name: string): OpensslCipher | undefined {
  return ALL_CIPHERS.find((cipher) => cipher.standardName === name);
}

export function cipherByCode(code: number): OpensslCipher | undefined {
  return ALL_CIPHERS.find((cipher) => (cipher.id & 0xffff) === code);
}
