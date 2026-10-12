import {
  CERTIFICATE_TYPE_NAMES, CIPHER_NAMES, CURVE_NAMES, GNUTLS_SUITES, GROUP_KINDS, GROUP_NAMES, KEYWORDS, KEY_EXCHANGE_NAMES, MAC_NAMES,
  MODIFIER_NAMES, PROFILE_RANK, SIGNATURE_NAMES, SIGNATURE_VERSIONS, SOURCE_LISTS, UNSUPPORTED_VERSIONS, VERSION_NAMES,
  type GnutlsNameTable, type GnutlsPriorityLists, type GnutlsSuite,
} from './gnutlsPriorityData';
import { LEVEL_OF_PROFILE, minimumDhPrimeBits, type VerificationProfile, type VerificationSettings } from './gnutlsVerificationProfile';

export type { GnutlsPriorityLists, GnutlsSuite };

export interface GnutlsPriority extends GnutlsPriorityLists {
  readonly suites: readonly GnutlsSuite[];
  readonly offeredSuites: readonly GnutlsSuite[];
  readonly negotiableGroups: readonly string[];
  readonly modifiers: readonly string[];
  readonly clientCertificateTypes: readonly string[];
  readonly serverCertificateTypes: readonly string[];
  readonly verification: VerificationSettings;
  readonly minimumDhPrimeBits: number;
}

export type GnutlsPriorityParse =
  | { readonly ok: true; readonly priority: GnutlsPriority }
  | { readonly ok: false; readonly kind: 'syntax'; readonly at: string }
  | { readonly ok: false; readonly kind: 'insufficient' };

type ListName = keyof GnutlsPriorityLists;
type CertificateTypeList = 'client' | 'server';

interface PriorityState {
  lists: Record<ListName, string[]>;
  certificateTypes: Record<CertificateTypeList, string[]>;
  modifiers: string[];
  verification: { profile: VerificationProfile | null; allowSha1: boolean; allowBroken: boolean; allowMd5: boolean };
  level: number;
}

const TLS13 = 'VERS-TLS1.3';
const TLS12 = 'VERS-TLS1.2';
const DTLS12 = 'VERS-DTLS1.2';
const NONE_KEYWORD = 'NONE';
const MAX_ELEMENTS = 128;
const DEFAULT_CERTIFICATE_TYPES: readonly string[] = ['X509'];
const ALL_CERTIFICATE_TYPES: readonly string[] = ['X509', 'RAWPK'];
const PRE_SHARED_KEY_EXCHANGES: readonly string[] = ['PSK', 'DHE-PSK', 'ECDHE-PSK'];
const CREDENTIAL_KEY_EXCHANGES: readonly string[] = ['PSK', 'DHE-PSK', 'ECDHE-PSK', 'RSA-PSK', 'ANON-DH', 'ANON-ECDH'];
const ELLIPTIC_KEY_EXCHANGES: readonly string[] = ['ECDHE-RSA', 'ECDHE-ECDSA', 'ECDHE-PSK', 'ANON-ECDH', 'VKO-GOST-12'];
const FINITE_FIELD_KEY_EXCHANGES: readonly string[] = ['DHE-RSA', 'DHE-DSS', 'DHE-PSK', 'ANON-DH'];
const UNNAMED_GROUP = /#\d+$/;
const SPACE_CHARACTERS = /^[\t\n\v\f\r ]+/;

const SOURCE = SOURCE_LISTS as Readonly<Record<string, readonly string[]>>;

function copyOf(items: readonly string[]): string[] {
  return [...items];
}

function addAll(list: string[], items: readonly string[]): string[] {
  const grown = [...list];
  for (const item of items) if (!grown.includes(item)) grown.push(item);
  return grown;
}

function removeAll(list: string[], items: readonly string[]): string[] {
  return list.filter((entry) => !items.includes(entry));
}

function addOne(list: string[], item: string): string[] {
  return list.includes(item) ? list : [...list, item];
}

function removeOne(list: string[], item: string): string[] {
  return list.filter((entry) => entry !== item);
}

function lookup(table: GnutlsNameTable, name: string): string | null | undefined {
  const key = name.toUpperCase();
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function initialState(startsWithNone: boolean): PriorityState {
  return {
    lists: startsWithNone
      ? { protocols: [], ciphers: [], macs: [], kx: [], groups: [], signatures: [] }
      : {
        protocols: copyOf(SOURCE.VERS), ciphers: [], macs: [], kx: [],
        groups: copyOf(SOURCE.GROUP), signatures: copyOf(SOURCE.SIGN),
      },
    certificateTypes: startsWithNone
      ? { client: [], server: [] }
      : { client: copyOf(DEFAULT_CERTIFICATE_TYPES), server: copyOf(DEFAULT_CERTIFICATE_TYPES) },
    modifiers: [],
    verification: { profile: null, allowSha1: false, allowBroken: false, allowMd5: false },
    level: 0,
  };
}

function applyKeyword(state: PriorityState, name: string, additive: boolean): boolean {
  const keyword = KEYWORDS[name.toUpperCase()];
  if (keyword === undefined) return false;
  const put = (list: ListName, items: readonly string[]): void => {
    state.lists[list] = additive ? addAll(state.lists[list], items) : copyOf(items);
  };
  if (keyword.protocols !== null) put('protocols', keyword.protocols);
  put('ciphers', keyword.ciphers);
  put('kx', keyword.kx);
  put('macs', keyword.macs);
  put('signatures', keyword.signatures);
  put('groups', keyword.groups);
  if (state.level === 0 || state.level > keyword.level) state.level = keyword.level;
  const wanted = keyword.profile as VerificationProfile | null;
  const current = state.verification.profile;
  if (wanted !== null && (current === null || PROFILE_RANK[current] > PROFILE_RANK[wanted])) state.verification.profile = wanted;
  return true;
}

interface Operation {
  readonly adding: boolean;
  readonly one: (list: ListName, item: string) => void;
  readonly all: (list: ListName, items: readonly string[]) => void;
  readonly given: (list: ListName, items: readonly string[]) => void;
}

function operationFor(state: PriorityState, sign: string): Operation {
  const adding = sign === '+';
  return {
    adding,
    one: (list, item) => {
      state.lists[list] = adding ? addOne(state.lists[list], item) : removeOne(state.lists[list], item);
    },
    all: (list, items) => {
      state.lists[list] = adding ? addAll(state.lists[list], items) : [];
    },
    given: (list, items) => {
      state.lists[list] = adding ? addAll(state.lists[list], items) : removeAll(state.lists[list], items);
    },
  };
}

function applyCertificateTypes(state: PriorityState, operation: Operation, name: string): boolean {
  const upper = name.toUpperCase();
  const change = (which: CertificateTypeList, canonical: string | null): void => {
    const list = state.certificateTypes[which];
    if (canonical === null) {
      state.certificateTypes[which] = operation.adding ? addAll(list, ALL_CERTIFICATE_TYPES) : [];
    } else {
      state.certificateTypes[which] = operation.adding ? addOne(list, canonical) : removeOne(list, canonical);
    }
  };
  const named = (rest: string): string | undefined => {
    const found = lookup(CERTIFICATE_TYPE_NAMES, rest);
    return found === undefined || found === null ? undefined : found;
  };
  if (upper.startsWith('CTYPE-ALL')) {
    change('client', null);
    change('server', null);
    return true;
  }
  for (const [prefix, which] of [['CTYPE-CLI-', 'client'], ['CTYPE-SRV-', 'server']] as const) {
    if (!upper.startsWith(prefix)) continue;
    if (upper.startsWith(`${prefix}ALL`)) {
      change(which, null);
      return true;
    }
    const canonical = named(name.slice(prefix.length));
    if (canonical === undefined) return false;
    change(which, canonical);
    return true;
  }
  const canonical = named(name.slice('CTYPE-'.length));
  if (canonical !== undefined) {
    change('client', canonical);
    change('server', canonical);
    return true;
  }
  return upper.startsWith('CTYPE-OPENPGP');
}

function applyVersion(operation: Operation, name: string): boolean {
  const upper = name.toUpperCase();
  if (upper.startsWith('VERS-TLS-ALL')) {
    operation.given('protocols', SOURCE['VERS-TLS']);
  } else if (upper.startsWith('VERS-DTLS-ALL')) {
    operation.given('protocols', operation.adding ? SOURCE['VERS-DTLS-ADD'] : SOURCE['VERS-DTLS-REMOVE']);
  } else if (upper.startsWith('VERS-ALL')) {
    operation.all('protocols', SOURCE.VERS);
  } else {
    const canonical = lookup(VERSION_NAMES, name.slice('VERS-'.length));
    if (canonical === undefined || canonical === null) return false;
    operation.one('protocols', canonical);
  }
  return true;
}

function applyGroup(operation: Operation, name: string): boolean {
  const upper = name.toUpperCase();
  if (upper.startsWith('GROUP-ALL')) operation.all('groups', SOURCE.GROUP);
  else if (upper.startsWith('GROUP-DH-ALL')) operation.given('groups', SOURCE['GROUP-DH']);
  else if (upper.startsWith('GROUP-EC-ALL')) operation.given('groups', SOURCE['GROUP-EC']);
  else if (upper.startsWith('GROUP-GOST-ALL')) operation.given('groups', SOURCE['GROUP-GOST']);
  else {
    const canonical = lookup(GROUP_NAMES, name.slice('GROUP-'.length));
    if (canonical === undefined || canonical === null) return false;
    operation.one('groups', canonical);
  }
  return true;
}

function applyCurve(operation: Operation, name: string): boolean {
  if (name.toUpperCase().startsWith('CURVE-ALL')) {
    operation.all('groups', SOURCE.GROUP);
    return true;
  }
  const canonical = lookup(CURVE_NAMES, name.slice('CURVE-'.length));
  if (canonical === undefined || canonical === null) return false;
  operation.one('groups', canonical);
  return true;
}

function applySignature(operation: Operation, name: string): boolean {
  const upper = name.toUpperCase();
  if (upper.startsWith('SIGN-ALL')) operation.all('signatures', SOURCE.SIGN);
  else if (upper.startsWith('SIGN-GOST-ALL')) operation.all('signatures', SOURCE['SIGN-GOST']);
  else {
    const canonical = lookup(SIGNATURE_NAMES, name.slice('SIGN-'.length));
    if (canonical === undefined || canonical === null) return false;
    operation.one('signatures', canonical);
  }
  return true;
}

function applyBundleOrIgnore(operation: Operation, name: string, prefix: string, list: ListName, normal: string, gost: string): void {
  const upper = name.toUpperCase();
  if (upper.startsWith(`${prefix}-ALL`)) operation.all(list, SOURCE[normal]);
  else if (upper.startsWith(`${prefix}-GOST-ALL`)) operation.all(list, SOURCE[gost]);
}

function applyGostBundle(operation: Operation): void {
  operation.given('groups', SOURCE['GROUP-GOST']);
  operation.all('signatures', SOURCE['SIGN-GOST']);
  operation.all('macs', SOURCE['MAC-GOST']);
  operation.all('ciphers', SOURCE['CIPHER-GOST']);
  operation.all('kx', SOURCE['KX-GOST']);
}

function applyNamed(state: PriorityState, sign: string, name: string): boolean {
  const operation = operationFor(state, sign);
  const upper = name.toUpperCase();
  const mac = lookup(MAC_NAMES, name);
  if (mac !== undefined) {
    if (mac !== null) operation.one('macs', mac);
    return true;
  }
  const cipher = lookup(CIPHER_NAMES, name);
  if (cipher !== undefined) {
    if (cipher !== null) operation.one('ciphers', cipher);
    return true;
  }
  const exchange = lookup(KEY_EXCHANGE_NAMES, name);
  if (exchange !== undefined) {
    if (exchange !== null) operation.one('kx', exchange);
    return true;
  }
  if (upper.startsWith('VERS-')) return applyVersion(operation, name);
  if (upper.startsWith('COMP-')) return true;
  if (upper.startsWith('CURVE-')) return applyCurve(operation, name);
  if (upper.startsWith('GROUP-')) return applyGroup(operation, name);
  if (upper.startsWith('CTYPE-')) return applyCertificateTypes(state, operation, name);
  if (upper.startsWith('SIGN-')) return applySignature(operation, name);
  if (upper.startsWith('MAC-')) {
    applyBundleOrIgnore(operation, name, 'MAC', 'macs', 'MAC', 'MAC-GOST');
    return true;
  }
  if (upper.startsWith('CIPHER-')) {
    applyBundleOrIgnore(operation, name, 'CIPHER', 'ciphers', 'CIPHER', 'CIPHER-GOST');
    return true;
  }
  if (upper.startsWith('KX-')) {
    applyBundleOrIgnore(operation, name, 'KX', 'kx', 'KX', 'KX-GOST');
    return true;
  }
  if (upper.startsWith('GOST')) {
    applyGostBundle(operation);
    return true;
  }
  return false;
}

function breakList(text: string): string[] {
  const elements: string[] = [];
  let position = 0;
  for (;;) {
    const colon = text.indexOf(':', position);
    if (colon < 0) {
      elements.push(text.slice(position));
      return elements;
    }
    elements.push(text.slice(position, colon));
    position = colon + 1;
    while (text.charAt(position) === ' ') position++;
    if (elements.length >= MAX_ELEMENTS) return elements;
  }
}

const PROFILE_PREFIX = 'PROFILE_';

function applyVerificationModifier(state: PriorityState, modifier: string): void {
  if (modifier.startsWith(PROFILE_PREFIX)) {
    const named = modifier.slice(PROFILE_PREFIX.length);
    state.verification.profile = (named === 'SUITEB192' ? 'SUITEB128' : named) as VerificationProfile;
    state.level = LEVEL_OF_PROFILE[state.verification.profile];
  }
  else if (modifier === 'VERIFY_ALLOW_SIGN_WITH_SHA1') state.verification.allowSha1 = true;
  else if (modifier === 'VERIFY_ALLOW_BROKEN') state.verification.allowBroken = true;
  else if (modifier === 'VERIFY_ALLOW_SIGN_RSA_MD5') state.verification.allowMd5 = true;
}

function applyElement(state: PriorityState, element: string, keywordSeen: boolean): 'keyword' | 'applied' | 'refused' {
  if (applyKeyword(state, element, keywordSeen)) return 'keyword';
  const sign = element.charAt(0);
  if (sign === '!' || sign === '+' || sign === '-') {
    const name = element.slice(1);
    if (sign === '+' && applyKeyword(state, name, true)) return 'applied';
    return applyNamed(state, sign, name) ? 'applied' : 'refused';
  }
  if (sign === '%') {
    const modifier = element.slice(1);
    if (!MODIFIER_NAMES.includes(modifier)) return 'refused';
    state.modifiers.push(element);
    applyVerificationModifier(state, modifier);
    return 'applied';
  }
  return 'refused';
}

const SUITES_BY_TRIPLE: ReadonlyMap<string, GnutlsSuite> = new Map(
  GNUTLS_SUITES.map((suite) => [`${suite.keyExchange}|${suite.cipher}|${suite.mac}`, suite] as const),
);

function suiteOf(keyExchange: string, cipher: string, mac: string): GnutlsSuite | undefined {
  return SUITES_BY_TRIPLE.get(`${keyExchange}|${cipher}|${mac}`);
}

function isTlsVersion(version: string): boolean {
  return version.startsWith('VERS-TLS');
}

function isDatagramVersion(version: string): boolean {
  return version.startsWith('VERS-DTLS');
}

function signatureUsable(signature: string, protocols: readonly string[]): boolean {
  const semantics = SIGNATURE_VERSIONS[signature] ?? [];
  if (protocols.includes(TLS13) && semantics.includes('TLS1.3')) return true;
  return (protocols.includes(TLS12) || protocols.includes(DTLS12)) && semantics.includes('TLS1.2');
}

interface GroupCollector {
  readonly groups: string[];
  ellipticSeen: boolean;
  finiteFieldSeen: boolean;
}

function collectGroups(collector: GroupCollector, raw: readonly string[], kind: 'curve' | 'prime'): void {
  for (const group of raw) if (GROUP_KINDS[group] === kind) collector.groups.push(group);
  if (kind === 'curve') collector.ellipticSeen = true;
  else collector.finiteFieldSeen = true;
}

function buildCipherSuites(lists: Record<ListName, string[]>, collector: GroupCollector): GnutlsSuite[] {
  const suites: GnutlsSuite[] = [];
  for (const cipher of lists.ciphers) {
    for (const mac of lists.macs) {
      const suite = suiteOf('', cipher, mac);
      if (suite !== undefined) suites.push(suite);
    }
  }
  for (const keyExchange of lists.kx) {
    for (const cipher of lists.ciphers) {
      for (const mac of lists.macs) {
        const suite = suiteOf(keyExchange, cipher, mac);
        if (suite === undefined) continue;
        suites.push(suite);
        if (!collector.ellipticSeen && ELLIPTIC_KEY_EXCHANGES.includes(keyExchange)) collectGroups(collector, lists.groups, 'curve');
        if (!collector.finiteFieldSeen && FINITE_FIELD_KEY_EXCHANGES.includes(keyExchange)) collectGroups(collector, lists.groups, 'prime');
      }
    }
  }
  return suites;
}

function scanGroupsForTls13(collector: GroupCollector, raw: readonly string[]): void {
  for (const group of raw) {
    const kind = GROUP_KINDS[group];
    if (kind === 'curve' && !collector.ellipticSeen) collectGroups(collector, raw, 'curve');
    else if (kind === 'prime' && !collector.finiteFieldSeen) collectGroups(collector, raw, 'prime');
    if (collector.ellipticSeen && collector.finiteFieldSeen) break;
  }
}

function finalise(state: PriorityState): GnutlsPriority | null {
  const lists = state.lists;
  lists.protocols = lists.protocols.filter((version) => !UNSUPPORTED_VERSIONS.includes(version));
  const hasPreSharedKey = lists.kx.some((entry) => PRE_SHARED_KEY_EXCHANGES.includes(entry));
  if (lists.ciphers.includes('NULL') || lists.kx.includes('RSA-PSK') || state.modifiers.includes('%NO_EXTENSIONS')) {
    lists.protocols = lists.protocols.filter((version) => version !== TLS13);
  }
  const streamVersions = lists.protocols.filter(isTlsVersion);
  const datagramVersions = lists.protocols.filter(isDatagramVersion);
  if (streamVersions.length === 0 && datagramVersions.length === 0) return null;
  const hasTls13 = streamVersions.includes(TLS13);
  if (hasTls13 && !streamVersions.includes(TLS12) && !hasPreSharedKey && datagramVersions.length === 0) lists.kx = [];

  const collector: GroupCollector = { groups: [], ellipticSeen: false, finiteFieldSeen: false };
  const suites = buildCipherSuites(lists, collector);
  if (hasTls13 && (!collector.ellipticSeen || !collector.finiteFieldSeen)) scanGroupsForTls13(collector, lists.groups);
  const usableSignatures = lists.signatures.filter((signature) => signatureUsable(signature, lists.protocols));
  if (usableSignatures.length === 0) lists.protocols = [];
  if (lists.protocols.length === 0 || suites.length === 0) return null;
  if (!hasPreSharedKey && hasTls13 && collector.groups.length === 0) lists.protocols = lists.protocols.filter((version) => version !== TLS13);

  const streamEnabled = lists.protocols.includes(TLS13) || lists.protocols.includes(TLS12);
  const offered = suites.filter((suite) => {
    if (suite.minimumVersion === 'TLS1.3') return lists.protocols.includes(TLS13);
    return streamEnabled || (suite.datagram && lists.protocols.includes(DTLS12));
  });
  return {
    protocols: lists.protocols,
    ciphers: lists.ciphers,
    macs: lists.macs,
    kx: lists.kx,
    groups: lists.groups.map((group) => group.replace(UNNAMED_GROUP, '')),
    negotiableGroups: collector.groups,
    signatures: lists.signatures,
    suites: offered,
    offeredSuites: suites.filter((suite) => !CREDENTIAL_KEY_EXCHANGES.includes(suite.keyExchange) && (suite.minimumVersion === 'TLS1.3'
      ? lists.protocols.includes(TLS13)
      : lists.protocols.includes(TLS12) || lists.protocols.includes(DTLS12))),
    modifiers: state.modifiers,
    clientCertificateTypes: state.certificateTypes.client,
    serverCertificateTypes: state.certificateTypes.server,
    verification: state.verification,
    minimumDhPrimeBits: minimumDhPrimeBits(state.level),
  };
}

export function parseGnutlsPriority(text: string): GnutlsPriorityParse {
  const trimmed = text.replace(SPACE_CHARACTERS, '');
  if (trimmed.startsWith('@')) return { ok: false, kind: 'syntax', at: text };
  const elements = breakList(trimmed);
  const startsWithNone = elements[0].toLowerCase() === NONE_KEYWORD.toLowerCase();
  const state = initialState(startsWithNone);
  let keywordSeen = startsWithNone;
  for (let index = startsWithNone ? 1 : 0; index < elements.length; index++) {
    const outcome = applyElement(state, elements[index], keywordSeen);
    if (outcome === 'refused') {
      if (trimmed !== text) return { ok: false, kind: 'syntax', at: text };
      const consumed = elements.slice(0, index).reduce((sum, element) => sum + element.length + 1, 0);
      return { ok: false, kind: 'syntax', at: text.slice(consumed) };
    }
    if (outcome === 'keyword') keywordSeen = true;
  }
  const priority = finalise(state);
  return priority === null ? { ok: false, kind: 'insufficient' } : { ok: true, priority };
}

let normal: GnutlsPriority | null = null;

export function defaultGnutlsPriority(): GnutlsPriority {
  if (normal === null) {
    const parsed = parseGnutlsPriority('NORMAL');
    if (parsed.ok === false) throw new Error('GnuTLS NORMAL priority must parse');
    normal = parsed.priority;
  }
  return normal;
}
