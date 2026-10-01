import { createCipherList, openSslErrorText, DEFAULT_TLS13_CIPHERSUITES } from './cipherString';
import { isImplementedCipher, type TlsProtocolVersion } from './legacyCipherSuites';

export type SslConfMode = 'file' | 'cmdline';

export interface SslConfState {
  minProtocol: TlsProtocolVersion | 'none' | null;
  maxProtocol: TlsProtocolVersion | 'none' | null;
  protocolSwitches: Map<TlsProtocolVersion, boolean>;
  cipherString: string | null;
  tls13Ciphersuites: string | null;
  groups: string[] | null;
  serverPreference: boolean | null;
  sessionTicket: boolean | null;
  extendedMasterSecret: boolean | null;
  options: Set<string>;
  verifyMode: { request: boolean; require: boolean } | null;
}

export function createSslConfState(): SslConfState {
  return {
    minProtocol: null, maxProtocol: null, protocolSwitches: new Map(), cipherString: null,
    tls13Ciphersuites: null, groups: null, serverPreference: null, sessionTicket: null,
    extendedMasterSecret: null, options: new Set(), verifyMode: null,
  };
}

export type SslConfOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

const REASON_BAD_VALUE = 384;
const REASON_UNKNOWN_CMD_NAME = 386;
const REASON_INVALID_ARGUMENT = 262 | (0x2 << 18);

function errorEntry(reason: number, text: string, data?: string): string {
  const code = `error:${(0x0a000000 + reason).toString(16).toUpperCase().padStart(8, '0')}:SSL routines::${text}`;
  return data === undefined ? code : `${code}:${data}`;
}

interface CommandSpec {
  readonly name: string;
  readonly cmdline: string | null;
  readonly kind: 'switch' | 'string' | 'file' | 'directory';
  readonly server?: boolean;
}

const COMMANDS: readonly CommandSpec[] = [
  { name: 'no_ssl3', cmdline: 'no_ssl3', kind: 'switch' },
  { name: 'no_tls1', cmdline: 'no_tls1', kind: 'switch' },
  { name: 'no_tls1_1', cmdline: 'no_tls1_1', kind: 'switch' },
  { name: 'no_tls1_2', cmdline: 'no_tls1_2', kind: 'switch' },
  { name: 'no_tls1_3', cmdline: 'no_tls1_3', kind: 'switch' },
  { name: 'bugs', cmdline: 'bugs', kind: 'switch' },
  { name: 'no_comp', cmdline: 'no_comp', kind: 'switch' },
  { name: 'comp', cmdline: 'comp', kind: 'switch' },
  { name: 'ecdh_single', cmdline: 'ecdh_single', kind: 'switch', server: true },
  { name: 'no_ticket', cmdline: 'no_ticket', kind: 'switch' },
  { name: 'serverpref', cmdline: 'serverpref', kind: 'switch', server: true },
  { name: 'legacy_renegotiation', cmdline: 'legacy_renegotiation', kind: 'switch' },
  { name: 'client_renegotiation', cmdline: 'client_renegotiation', kind: 'switch', server: true },
  { name: 'legacy_server_connect', cmdline: 'legacy_server_connect', kind: 'switch' },
  { name: 'no_renegotiation', cmdline: 'no_renegotiation', kind: 'switch' },
  { name: 'no_resumption_on_reneg', cmdline: 'no_resumption_on_reneg', kind: 'switch', server: true },
  { name: 'no_legacy_server_connect', cmdline: 'no_legacy_server_connect', kind: 'switch' },
  { name: 'allow_no_dhe_kex', cmdline: 'allow_no_dhe_kex', kind: 'switch' },
  { name: 'prioritize_chacha', cmdline: 'prioritize_chacha', kind: 'switch', server: true },
  { name: 'strict', cmdline: 'strict', kind: 'switch' },
  { name: 'no_middlebox', cmdline: 'no_middlebox', kind: 'switch' },
  { name: 'anti_replay', cmdline: 'anti_replay', kind: 'switch', server: true },
  { name: 'no_anti_replay', cmdline: 'no_anti_replay', kind: 'switch', server: true },
  { name: 'no_etm', cmdline: 'no_etm', kind: 'switch' },
  { name: 'SignatureAlgorithms', cmdline: 'sigalgs', kind: 'string' },
  { name: 'ClientSignatureAlgorithms', cmdline: 'client_sigalgs', kind: 'string' },
  { name: 'Curves', cmdline: 'curves', kind: 'string' },
  { name: 'Groups', cmdline: 'groups', kind: 'string' },
  { name: 'ECDHParameters', cmdline: 'named_curve', kind: 'string', server: true },
  { name: 'CipherString', cmdline: 'cipher', kind: 'string' },
  { name: 'Ciphersuites', cmdline: 'ciphersuites', kind: 'string' },
  { name: 'Protocol', cmdline: null, kind: 'string' },
  { name: 'MinProtocol', cmdline: 'min_protocol', kind: 'string' },
  { name: 'MaxProtocol', cmdline: 'max_protocol', kind: 'string' },
  { name: 'Options', cmdline: null, kind: 'string' },
  { name: 'VerifyMode', cmdline: null, kind: 'string' },
  { name: 'Certificate', cmdline: 'cert', kind: 'file' },
  { name: 'PrivateKey', cmdline: 'key', kind: 'file' },
  { name: 'ServerInfoFile', cmdline: null, kind: 'file', server: true },
  { name: 'ChainCAPath', cmdline: 'chainCApath', kind: 'directory' },
  { name: 'ChainCAFile', cmdline: 'chainCAfile', kind: 'file' },
  { name: 'VerifyCAPath', cmdline: 'verifyCApath', kind: 'directory' },
  { name: 'VerifyCAFile', cmdline: 'verifyCAfile', kind: 'file' },
  { name: 'RequestCAFile', cmdline: 'requestCAFile', kind: 'file' },
  { name: 'ClientCAFile', cmdline: null, kind: 'file', server: true },
  { name: 'RequestCAPath', cmdline: null, kind: 'directory' },
  { name: 'ClientCAPath', cmdline: null, kind: 'directory', server: true },
  { name: 'DHParameters', cmdline: 'dhparam', kind: 'file', server: true },
  { name: 'RecordPadding', cmdline: 'record_padding', kind: 'string' },
  { name: 'NumTickets', cmdline: 'num_tickets', kind: 'string', server: true },
];

const SWITCH_EFFECTS: Readonly<Record<string, (state: SslConfState) => void>> = {
  no_tls1: (s) => { s.protocolSwitches.set('1.0', false); },
  no_tls1_1: (s) => { s.protocolSwitches.set('1.1', false); },
  no_tls1_2: (s) => { s.protocolSwitches.set('1.2', false); },
  no_tls1_3: (s) => { s.protocolSwitches.set('1.3', false); },
  no_ticket: (s) => { s.sessionTicket = false; },
  serverpref: (s) => { s.serverPreference = true; },
};

const PROTOCOL_BY_NAME: Readonly<Record<string, TlsProtocolVersion | 'none' | 'ssl3'>> = {
  None: 'none', SSLv3: 'ssl3', TLSv1: '1.0', 'TLSv1.1': '1.1', 'TLSv1.2': '1.2', 'TLSv1.3': '1.3',
};

const PROTOCOL_LIST: readonly { readonly name: string; readonly version: TlsProtocolVersion | null }[] = [
  { name: 'ALL', version: null }, { name: 'SSLv2', version: null }, { name: 'SSLv3', version: null },
  { name: 'TLSv1', version: '1.0' }, { name: 'TLSv1.1', version: '1.1' },
  { name: 'TLSv1.2', version: '1.2' }, { name: 'TLSv1.3', version: '1.3' },
  { name: 'DTLSv1', version: null }, { name: 'DTLSv1.2', version: null },
];

type OptionEffect = (state: SslConfState, on: boolean) => void;
const OPTION_LIST: readonly { readonly name: string; readonly inverted: boolean; readonly effect?: OptionEffect }[] = [
  { name: 'SessionTicket', inverted: false, effect: (s, on) => { s.sessionTicket = on; } },
  { name: 'EmptyFragments', inverted: false },
  { name: 'Bugs', inverted: false },
  { name: 'Compression', inverted: false },
  { name: 'ServerPreference', inverted: false, effect: (s, on) => { s.serverPreference = on; } },
  { name: 'NoResumptionOnRenegotiation', inverted: false },
  { name: 'DHSingle', inverted: false },
  { name: 'ECDHSingle', inverted: false },
  { name: 'UnsafeLegacyRenegotiation', inverted: false },
  { name: 'UnsafeLegacyServerConnect', inverted: false },
  { name: 'ClientRenegotiation', inverted: false },
  { name: 'EncryptThenMac', inverted: false },
  { name: 'NoRenegotiation', inverted: false },
  { name: 'AllowNoDHEKEX', inverted: false },
  { name: 'PrioritizeChaCha', inverted: false },
  { name: 'MiddleboxCompat', inverted: false },
  { name: 'AntiReplay', inverted: false },
  { name: 'ExtendedMasterSecret', inverted: false, effect: (s, on) => { s.extendedMasterSecret = on; } },
  { name: 'CANames', inverted: false },
  { name: 'KTLS', inverted: false },
];

const VERIFY_MODES: readonly { readonly name: string; readonly request: boolean; readonly require: boolean; readonly client: boolean }[] = [
  { name: 'Peer', request: true, require: false, client: true },
  { name: 'Request', request: true, require: false, client: false },
  { name: 'Require', request: true, require: true, client: false },
  { name: 'Once', request: true, require: false, client: false },
  { name: 'RequestPostHandshake', request: true, require: false, client: false },
  { name: 'RequirePostHandshake', request: true, require: true, client: false },
];

export const TLS_GROUP_NAMES: Readonly<Record<string, string>> = (() => {
  const entries: [string, string][] = [
    ['sect163k1', 'sect163k1'], ['K-163', 'sect163k1'], ['sect163r1', 'sect163r1'], ['sect163r2', 'sect163r2'],
    ['B-163', 'sect163r2'], ['sect193r1', 'sect193r1'], ['sect193r2', 'sect193r2'], ['sect233k1', 'sect233k1'],
    ['K-233', 'sect233k1'], ['sect233r1', 'sect233r1'], ['B-233', 'sect233r1'], ['sect239k1', 'sect239k1'],
    ['sect283k1', 'sect283k1'], ['K-283', 'sect283k1'], ['sect283r1', 'sect283r1'], ['B-283', 'sect283r1'],
    ['sect409k1', 'sect409k1'], ['K-409', 'sect409k1'], ['sect409r1', 'sect409r1'], ['B-409', 'sect409r1'],
    ['sect571k1', 'sect571k1'], ['K-571', 'sect571k1'], ['sect571r1', 'sect571r1'], ['B-571', 'sect571r1'],
    ['secp160k1', 'secp160k1'], ['secp160r1', 'secp160r1'], ['secp160r2', 'secp160r2'], ['secp192k1', 'secp192k1'],
    ['secp192r1', 'secp192r1'], ['prime192v1', 'secp192r1'], ['P-192', 'secp192r1'], ['secp224k1', 'secp224k1'],
    ['secp224r1', 'secp224r1'], ['P-224', 'secp224r1'], ['secp256k1', 'secp256k1'], ['secp256r1', 'secp256r1'],
    ['prime256v1', 'secp256r1'], ['P-256', 'secp256r1'], ['secp384r1', 'secp384r1'], ['P-384', 'secp384r1'],
    ['secp521r1', 'secp521r1'], ['P-521', 'secp521r1'], ['brainpoolP256r1', 'brainpoolP256r1'],
    ['brainpoolP384r1', 'brainpoolP384r1'], ['brainpoolP512r1', 'brainpoolP512r1'], ['x25519', 'x25519'],
    ['X25519', 'x25519'], ['x448', 'x448'], ['X448', 'x448'], ['ffdhe2048', 'ffdhe2048'], ['ffdhe3072', 'ffdhe3072'],
    ['ffdhe4096', 'ffdhe4096'], ['ffdhe6144', 'ffdhe6144'], ['ffdhe8192', 'ffdhe8192'],
  ];
  return Object.fromEntries(entries);
})();

export function parseGroupList(value: string): { readonly ok: true; readonly groups: string[] } | { readonly ok: false; readonly error: string } {
  const groups: string[] = [];
  for (const raw of value.split(':')) {
    const name = raw.trim();
    const canonical = TLS_GROUP_NAMES[name];
    if (canonical === undefined) return { ok: false, error: errorEntry(REASON_INVALID_ARGUMENT, 'passed invalid argument', `group '${name}' cannot be set`) };
    if (groups.includes(canonical)) return { ok: false, error: errorEntry(REASON_INVALID_ARGUMENT, 'passed invalid argument', `group '${name}' cannot be set`) };
    groups.push(canonical);
  }
  return { ok: true, groups };
}

function parseList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
}

function applyProtocolList(state: SslConfState, value: string): boolean {
  for (const item of parseList(value)) {
    let name = item;
    let on = true;
    if (name.startsWith('+')) name = name.slice(1);
    else if (name.startsWith('-')) { name = name.slice(1); on = false; }
    const entry = PROTOCOL_LIST.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!entry) return false;
    if (entry.name === 'ALL') {
      for (const version of ['1.0', '1.1', '1.2', '1.3'] as const) state.protocolSwitches.set(version, on);
    } else if (entry.version !== null) {
      state.protocolSwitches.set(entry.version, on);
    }
  }
  return true;
}

function applyOptionList(state: SslConfState, value: string): boolean {
  for (const item of parseList(value)) {
    let name = item;
    let on = true;
    if (name.startsWith('+')) name = name.slice(1);
    else if (name.startsWith('-')) { name = name.slice(1); on = false; }
    const entry = OPTION_LIST.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!entry) return false;
    if (on) state.options.add(entry.name); else state.options.delete(entry.name);
    entry.effect?.(state, on);
  }
  return true;
}

function applyVerifyModeList(state: SslConfState, value: string, server: boolean): boolean {
  let request = false;
  let require = false;
  for (const item of parseList(value)) {
    const name = item.replace(/^[+-]/, '');
    const on = !item.startsWith('-');
    const entry = VERIFY_MODES.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!entry || (server && entry.client) || (!server && !entry.client)) return false;
    if (on) { request = request || entry.request; require = require || entry.require; }
  }
  state.verifyMode = { request, require };
  return true;
}

export interface SslConfCommandOptions {
  readonly mode?: SslConfMode;
  readonly server?: boolean;
}

const UNSUPPORTED_NOTE = 'is not applicable to this simulator\'s configuration surface';

export function applySslConfCommand(
  state: SslConfState, command: string, value: string | null, options: SslConfCommandOptions = {},
): SslConfOutcome {
  const mode = options.mode ?? 'file';
  const server = options.server ?? true;
  const spec = COMMANDS.find((candidate) => {
    if (candidate.server === true && !server) return false;
    return mode === 'file'
      ? candidate.name.toLowerCase() === command.toLowerCase()
      : candidate.cmdline === command;
  });
  if (!spec) return { ok: false, errors: [errorEntry(REASON_UNKNOWN_CMD_NAME, 'unknown cmd name', `cmd=${command}`)] };
  if (spec.kind === 'switch') {
    SWITCH_EFFECTS[spec.name]?.(state);
    return { ok: true };
  }
  const bad = (...extra: string[]): SslConfOutcome => ({
    ok: false,
    errors: [...extra, errorEntry(REASON_BAD_VALUE, 'bad value', `cmd=${spec.name}, value=${value ?? '<EMPTY>'}`)],
  });
  if (value === null) return bad();
  switch (spec.name) {
    case 'Ciphersuites':
      state.tls13Ciphersuites = value;
      return { ok: true };
    case 'CipherString': {
      const list = createCipherList(value, { isAvailable: isImplementedCipher, tls13Suites: state.tls13Ciphersuites ?? DEFAULT_TLS13_CIPHERSUITES });
      if (list.ok === false) return bad(list.error);
      state.cipherString = value;
      return { ok: true };
    }
    case 'Groups':
    case 'Curves':
    case 'ECDHParameters': {
      if (spec.name === 'ECDHParameters' && value.includes(':')) return bad();
      const parsed = parseGroupList(value);
      if (parsed.ok === false) return bad(parsed.error);
      state.groups = parsed.groups;
      return { ok: true };
    }
    case 'Protocol':
      return applyProtocolList(state, value) ? { ok: true } : bad();
    case 'MinProtocol':
    case 'MaxProtocol': {
      const version = PROTOCOL_BY_NAME[value];
      if (version === undefined) return bad();
      const resolved = version === 'ssl3' ? 'none' : version;
      if (spec.name === 'MinProtocol') state.minProtocol = resolved; else state.maxProtocol = resolved;
      return { ok: true };
    }
    case 'Options':
      return applyOptionList(state, value) ? { ok: true } : bad();
    case 'VerifyMode':
      return applyVerifyModeList(state, value, server) ? { ok: true } : bad();
    default:
      return { ok: false, errors: [errorEntry(REASON_BAD_VALUE, 'bad value', `cmd=${spec.name}, value=${value} ${UNSUPPORTED_NOTE}`)] };
  }
}

export function formatSslConfError(errors: readonly string[]): string {
  return `SSL: ${errors.join(' ')}`;
}

const VERSION_ORDER: readonly TlsProtocolVersion[] = ['1.0', '1.1', '1.2', '1.3'];

export function effectiveProtocols(base: readonly TlsProtocolVersion[], state: SslConfState): TlsProtocolVersion[] {
  const rank = (version: TlsProtocolVersion): number => VERSION_ORDER.indexOf(version);
  const min = state.minProtocol === null || state.minProtocol === 'none' ? -1 : rank(state.minProtocol);
  const max = state.maxProtocol === null || state.maxProtocol === 'none' ? VERSION_ORDER.length : rank(state.maxProtocol);
  return VERSION_ORDER.filter((version) => {
    if (!base.includes(version)) return false;
    if (state.protocolSwitches.get(version) === false) return false;
    return rank(version) >= min && rank(version) <= max;
  });
}

export { openSslErrorText };
