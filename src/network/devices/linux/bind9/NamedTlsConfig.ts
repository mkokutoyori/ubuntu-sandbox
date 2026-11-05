import type { NamedConfStatement } from './NamedConfParser';
import type { AddressMatchList } from './NamedAcl';
import { fail, keywordOf, argsOf, requireBlock } from './NamedConfStatements';
import { createCipherList } from '@/network/tls/legacy/cipherString';

export const DEFAULT_TLS_PORT = 853;
export const DEFAULT_HTTPS_PORT = 443;
export const DEFAULT_DOH_ENDPOINT = '/dns-query';
export const DEFAULT_LISTENER_CLIENTS = 300;
export const UNLIMITED_STREAMS_PER_CONNECTION = 2147483647;

const RESERVED_TLS_NAMES = new Set(['ephemeral', 'none']);
const TLS_PROTOCOLS: Readonly<Record<string, '1.2' | '1.3'>> = { 'TLSv1.2': '1.2', 'TLSv1.3': '1.3' };

export interface NamedSource {
  readonly file: string;
  readonly line: number;
}

export interface NamedTlsProfile {
  readonly name: string;
  readonly keyFile: string | null;
  readonly certFile: string | null;
  readonly caFile: string | null;
  readonly remoteHostname: string | null;
  readonly dhparamFile: string | null;
  readonly ciphers: string | null;
  readonly preferServerCiphers: boolean | null;
  readonly sessionTickets: boolean | null;
  readonly protocols: readonly ('1.2' | '1.3')[] | null;
  readonly declaredAt: NamedSource;
}

export interface NamedHttpProfile {
  readonly name: string;
  readonly endpoints: readonly string[];
  readonly listenerClients: number | null;
  readonly streamsPerConnection: number | null;
  readonly declaredAt: NamedSource;
}

export const DEFAULT_HTTP_PROFILE: NamedHttpProfile = {
  name: 'default',
  endpoints: [DEFAULT_DOH_ENDPOINT],
  listenerClients: null,
  streamsPerConnection: null,
  declaredAt: { file: '', line: 0 },
};

export type NamedListenerTls =
  | { readonly kind: 'none' }
  | { readonly kind: 'ephemeral' }
  | { readonly kind: 'profile'; readonly profile: NamedTlsProfile };

export interface NamedListener {
  readonly port: number;
  readonly tls: NamedListenerTls;
  readonly http: NamedHttpProfile | null;
  readonly addresses: AddressMatchList;
  readonly ipv6: boolean;
  readonly declaredAt: NamedSource;
}

export interface NamedListenHeader {
  readonly port: number | null;
  readonly tls: string | null;
  readonly http: string | null;
}

function stringValue(entry: NamedConfStatement): string {
  const value = entry.values[1];
  if (value === undefined) fail(entry, `unexpected token near ';'`);
  return value.text;
}

function booleanValue(entry: NamedConfStatement): boolean {
  const value = argsOf(entry)[0];
  if (value === 'yes' || value === 'true') return true;
  if (value === 'no' || value === 'false') return false;
  return fail(entry, `boolean expected near '${value ?? ';'}'`);
}

function positiveInteger(entry: NamedConfStatement): number {
  const value = Number(argsOf(entry)[0]);
  if (!Number.isInteger(value) || value < 0) fail(entry, `expected a number near '${argsOf(entry)[0] ?? ';'}'`);
  return value;
}

export function parseListenHeader(entry: NamedConfStatement): NamedListenHeader {
  const words = argsOf(entry);
  let port: number | null = null;
  let tls: string | null = null;
  let http: string | null = null;
  for (let index = 0; index < words.length; index += 2) {
    const word = words[index];
    const value = words[index + 1];
    if (word === 'port') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) fail(entry, `expected port number near '${value ?? ';'}'`);
      port = parsed;
    } else if (word === 'tls') {
      if (value === undefined) fail(entry, `unexpected token near ';'`);
      tls = value;
    } else if (word === 'http') {
      if (value === undefined) fail(entry, `unexpected token near ';'`);
      http = value;
    } else {
      fail(entry, `unexpected token near '${word}'`);
    }
  }
  return { port, tls, http };
}

export function parseTlsProfile(statement: NamedConfStatement): NamedTlsProfile {
  const name = statement.values[1]?.text;
  if (!name) fail(statement, "expected tls name after 'tls'");
  if (RESERVED_TLS_NAMES.has(name)) fail(statement, `tls clause name '${name}' is reserved for internal use`);
  let keyFile: string | null = null;
  let certFile: string | null = null;
  let caFile: string | null = null;
  let remoteHostname: string | null = null;
  let dhparamFile: string | null = null;
  let ciphers: string | null = null;
  let preferServerCiphers: boolean | null = null;
  let sessionTickets: boolean | null = null;
  let protocols: ('1.2' | '1.3')[] | null = null;
  for (const entry of requireBlock(statement)) {
    switch (keywordOf(entry)) {
      case 'key-file': keyFile = stringValue(entry); break;
      case 'cert-file': certFile = stringValue(entry); break;
      case 'ca-file': caFile = stringValue(entry); break;
      case 'remote-hostname': remoteHostname = stringValue(entry); break;
      case 'dhparam-file': dhparamFile = stringValue(entry); break;
      case 'ciphers': {
        ciphers = stringValue(entry);
        if (createCipherList(ciphers).ok === false) {
          fail(entry, `'ciphers' in the 'tls' clause '${name}' is not a valid cipher list string`);
        }
        break;
      }
      case 'prefer-server-ciphers': preferServerCiphers = booleanValue(entry); break;
      case 'session-tickets': sessionTickets = booleanValue(entry); break;
      case 'protocols': {
        protocols = [];
        for (const protocol of requireBlock(entry)) {
          const word = keywordOf(protocol);
          const version = TLS_PROTOCOLS[word];
          if (version === undefined) fail(protocol, `'${word}' is not a valid TLS protocol version`);
          if (!protocols.includes(version)) protocols.push(version);
        }
        break;
      }
      default: fail(entry, `unknown option '${keywordOf(entry)}'`);
    }
  }
  if ((keyFile === null) !== (certFile === null)) {
    fail(statement, `tls '${name}': 'cert-file' and 'key-file' must both be specified, or both omitted`);
  }
  return {
    name, keyFile, certFile, caFile, remoteHostname, dhparamFile, ciphers, preferServerCiphers, sessionTickets,
    protocols, declaredAt: { file: statement.file, line: statement.line },
  };
}

export function parseHttpProfile(statement: NamedConfStatement): NamedHttpProfile {
  const name = statement.values[1]?.text;
  if (!name) fail(statement, "expected http name after 'http'");
  let endpoints: string[] | null = null;
  let listenerClients: number | null = null;
  let streamsPerConnection: number | null = null;
  for (const entry of requireBlock(statement)) {
    switch (keywordOf(entry)) {
      case 'endpoints': {
        endpoints = [];
        for (const path of requireBlock(entry)) {
          const text = keywordOf(path);
          if (!text.startsWith('/')) fail(path, `endpoint '${text}' is not a valid absolute HTTP path`);
          endpoints.push(text);
        }
        break;
      }
      case 'listener-clients': listenerClients = positiveInteger(entry); break;
      case 'streams-per-connection': streamsPerConnection = positiveInteger(entry); break;
      default: fail(entry, `unknown option '${keywordOf(entry)}'`);
    }
  }
  return {
    name, endpoints: endpoints ?? [DEFAULT_DOH_ENDPOINT], listenerClients, streamsPerConnection,
    declaredAt: { file: statement.file, line: statement.line },
  };
}

export function registerProfile<T extends { readonly name: string; readonly declaredAt: NamedSource }>(
  profiles: Map<string, T>, profile: T, kind: 'tls' | 'http', statement: NamedConfStatement,
): void {
  const previous = profiles.get(profile.name);
  if (previous !== undefined) {
    fail(statement, `${kind} clause '${profile.name}' is duplicated: also defined at ${previous.declaredAt.file}:${previous.declaredAt.line}`);
  }
  profiles.set(profile.name, profile);
}

export function resolveListener(
  header: NamedListenHeader,
  addresses: AddressMatchList,
  statement: NamedConfStatement,
  ipv6: boolean,
  tlsProfiles: ReadonlyMap<string, NamedTlsProfile>,
  httpProfiles: ReadonlyMap<string, NamedHttpProfile>,
): NamedListener {
  if (header.http !== null && header.tls === null) {
    fail(statement, "http must specify a 'tls' statement, 'tls ephemeral', or 'tls none'");
  }
  let tls: NamedListenerTls = { kind: 'none' };
  if (header.tls === 'ephemeral') tls = { kind: 'ephemeral' };
  else if (header.tls !== null && header.tls !== 'none') {
    const profile = tlsProfiles.get(header.tls);
    if (profile === undefined) fail(statement, `tls '${header.tls}' is not defined`);
    tls = { kind: 'profile', profile };
  }
  let http: NamedHttpProfile | null = null;
  if (header.http !== null) {
    http = header.http === 'default' ? DEFAULT_HTTP_PROFILE : httpProfiles.get(header.http) ?? null;
    if (http === null) fail(statement, `http '${header.http}' is not defined`);
  }
  const port = header.port ?? (http !== null ? (tls.kind === 'none' ? 80 : DEFAULT_HTTPS_PORT) : DEFAULT_TLS_PORT);
  return { port, tls, http, addresses, ipv6, declaredAt: { file: statement.file, line: statement.line } };
}

export function isEncryptedOrHttpListener(header: NamedListenHeader): boolean {
  return (header.tls !== null && header.tls !== 'none') || header.http !== null;
}
