import {
  categoryOfDomain, categoryName, UNCLASSIFIED_CATEGORY,
  type AntivirusProfile, type CategoryFilterEntry, type DnsFilterProfile,
  type ApplicationList, type FileFilterProfile, type ProtocolOptions,
  type SslSshProfile,
  type UrlFilterEntry, type UtmAction, type WebFilterProfile,
} from './UtmProfiles';
import { parseRequest, parseResponse } from '../../../http/http1/Http1Wire';
import { identifyApplication } from './ApplicationSignatures';
import { decodeDnsMessage } from '../../../dns/wire/DnsMessageCodec';
import { decodeRecords } from '../../../http/https/TlsRecordWire';
import { decodeMessages } from '../../../tls/messages';

export const EICAR_SIGNATURE =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export const EICAR_VIRUS_NAME = 'EICAR_TEST_FILE';

export type InspectedProtocol = 'http' | 'https' | 'ftp' | 'dns' | 'other';

export interface InspectedFlow {
  readonly oversize?: boolean;
  readonly protocol: InspectedProtocol;
  readonly sourcePort: number;
  readonly destinationPort: number;
  readonly payload: string;
  readonly bytes?: Uint8Array;
}

export type UtmVerdictKind =
  | 'clean'
  | 'virus'
  | 'url-blocked'
  | 'category-blocked'
  | 'dns-blocked'
  | 'file-type-blocked'
  | 'application-blocked';

export interface UtmVerdict {
  readonly kind: UtmVerdictKind;
  readonly blocked: boolean;
  readonly detail: string;
  readonly profile?: string;
  readonly category?: number;
  readonly categoryLabel?: string;
  readonly host?: string;
  readonly url?: string;
  readonly fileType?: string;
  readonly application?: string;
}

export const CLEAN: UtmVerdict = Object.freeze({
  kind: 'clean' as const, blocked: false, detail: 'clean',
});

const MAGIC_NUMBERS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['MZ', 'exe'],
  ['PK', 'zip'],
  ['%PDF-', 'pdf'],
  ['ELF', 'elf'],
  ['', 'gzip'],
  ['GIF8', 'gif'],
  ['PNG', 'png'],
  ['ÿØÿ', 'jpeg'],
  ['ÐÏ\u0011à', 'msi'],
]);

export function protocolOfFlow(
  sourcePort: number, destinationPort: number, options: ProtocolOptions,
): InspectedProtocol {
  const ports = [sourcePort, destinationPort];
  if (ports.some(port => options.httpPorts.includes(port))) return 'http';
  if (ports.some(port => options.httpsPorts.includes(port))) return 'https';
  if (ports.some(port => options.ftpPorts.includes(port))) return 'ftp';
  if (ports.some(port => options.dnsPorts.includes(port))) return 'dns';
  return 'other';
}

export { identifyApplication };

export function detectFileType(payload: string): string | undefined {
  const body = httpBody(payload) ?? payload;
  for (const [magic, name] of MAGIC_NUMBERS) {
    if (body.startsWith(magic)) return name;
  }
  return undefined;
}

export function containsEicar(payload: string): boolean {
  return payload.includes(EICAR_SIGNATURE);
}

export function scanAntivirus(
  flow: InspectedFlow, profile: AntivirusProfile,
): UtmVerdict {
  const action = actionForProtocol(flow.protocol, profile);
  if (action === 'allow') return CLEAN;
  if (!containsEicar(flow.payload)) return CLEAN;

  return Object.freeze({
    kind: 'virus' as const,
    blocked: action === 'block',
    detail: EICAR_VIRUS_NAME,
    profile: profile.name,
  });
}

export interface HttpRequestLine {
  readonly method: string;
  readonly path: string;
  readonly host: string;
  readonly url: string;
}

export function parseHttpRequest(payload: string): HttpRequestLine | undefined {
  const parsed = parseRequest(payload);
  if (!parsed.ok || parsed.message.kind !== 'request') return undefined;

  const host = parsed.message.headers.get('Host') ?? '';
  return Object.freeze({
    method: parsed.message.method,
    path: parsed.message.target,
    host,
    url: `${host}${parsed.message.target}`,
  });
}

export function scanWebFilter(
  flow: InspectedFlow, profile: WebFilterProfile,
  urlFilters: readonly UrlFilterEntry[],
): UtmVerdict {
  const request = parseHttpRequest(flow.payload);
  if (!request) return CLEAN;
  return judgeWeb(profile, urlFilters, request.host, request.url);
}

export function scanWebFilterHost(
  host: string, profile: WebFilterProfile,
  urlFilters: readonly UrlFilterEntry[],
): UtmVerdict {
  return judgeWeb(profile, urlFilters, host, host);
}

function judgeWeb(
  profile: WebFilterProfile, urlFilters: readonly UrlFilterEntry[],
  host: string, url: string,
): UtmVerdict {
  const explicit = matchUrlFilter(urlFilters, url, host);
  if (explicit) {
    return Object.freeze({
      kind: 'url-blocked' as const,
      blocked: explicit.action === 'block',
      detail: explicit.pattern,
      profile: profile.name,
      host,
      url,
    });
  }

  const category = categoryOfDomain(host);
  const action = categoryAction(profile.categoryFilters, category, profile.unclassifiedAction);
  if (action === 'allow') return CLEAN;

  return Object.freeze({
    kind: 'category-blocked' as const,
    blocked: action === 'block',
    detail: categoryName(category),
    profile: profile.name,
    category,
    categoryLabel: categoryName(category),
    host,
    url,
  });
}

export function parseDnsQuestion(flow: InspectedFlow): string | undefined {
  const bytes = flow.bytes ?? binaryStringToBytes(flow.payload);
  try {
    return decodeDnsMessage(bytes).questions[0]?.qname;
  } catch {
    return undefined;
  }
}

export function scanDnsFilter(
  flow: InspectedFlow, profile: DnsFilterProfile,
  domainFilters: readonly UrlFilterEntry[],
): UtmVerdict {
  const name = parseDnsQuestion(flow);
  if (name === undefined) return CLEAN;

  const explicit = matchUrlFilter(domainFilters, name, name);
  if (explicit) {
    return Object.freeze({
      kind: 'dns-blocked' as const,
      blocked: explicit.action === 'block',
      detail: explicit.pattern,
      profile: profile.name,
      host: name,
    });
  }

  const category = categoryOfDomain(name);
  const action = categoryAction(profile.categoryFilters, category, profile.unclassifiedAction);
  if (action === 'allow') return CLEAN;

  return Object.freeze({
    kind: 'dns-blocked' as const,
    blocked: action === 'block',
    detail: categoryName(category),
    profile: profile.name,
    category,
    categoryLabel: categoryName(category),
    host: name,
  });
}

export function scanFileFilter(
  flow: InspectedFlow, profile: FileFilterProfile,
): UtmVerdict {
  const detected = detectFileType(flow.payload);
  if (detected === undefined) return CLEAN;

  for (const entry of profile.entries) {
    if (!entry.fileTypes.includes(detected)) continue;
    if (entry.action === 'allow') return CLEAN;

    return Object.freeze({
      kind: 'file-type-blocked' as const,
      blocked: entry.action === 'block',
      detail: detected,
      profile: profile.name,
      fileType: detected,
    });
  }
  return CLEAN;
}

export function scanApplicationControl(
  flow: InspectedFlow, list: ApplicationList,
): UtmVerdict {
  const application = identifyApplication(flow.payload);
  if (application === undefined) return CLEAN;

  for (const entry of list.entries) {
    if (entry.application.toUpperCase() !== application) continue;
    if (entry.action === 'allow') return CLEAN;

    return Object.freeze({
      kind: 'application-blocked' as const,
      blocked: entry.action === 'block',
      detail: application,
      profile: list.name,
      application,
    });
  }
  return CLEAN;
}

export function readSni(flow: InspectedFlow): string | undefined {
  const bytes = flow.bytes ?? binaryStringToBytes(flow.payload);
  try {
    for (const record of decodeRecords(bytes)) {
      if (record.contentType !== 'handshake') continue;
      for (const message of decodeMessages(record.fragment)) {
        if (message.kind === 'client_hello') return message.extensions.serverName;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function inspectTls(
  flow: InspectedFlow, profile: SslSshProfile,
): string | undefined {
  if (profile.httpsMode === 'disable') return undefined;
  if (!profile.httpsPorts.includes(flow.destinationPort)
    && !profile.httpsPorts.includes(flow.sourcePort)) {
    return undefined;
  }
  return readSni(flow);
}

function binaryStringToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) out[index] = text.charCodeAt(index) & 0xff;
  return out;
}

function actionForProtocol(
  protocol: InspectedProtocol, profile: AntivirusProfile,
): UtmAction {
  if (protocol === 'http') return profile.httpScan;
  if (protocol === 'ftp') return profile.ftpScan;
  if (protocol === 'other') return profile.smtpScan;
  return 'allow';
}

function categoryAction(
  filters: readonly CategoryFilterEntry[], category: number, unclassified: UtmAction,
): UtmAction {
  const declared = filters.find(entry => entry.category === category);
  if (declared) return declared.action;
  return category === UNCLASSIFIED_CATEGORY ? unclassified : 'allow';
}

function matchUrlFilter(
  filters: readonly UrlFilterEntry[], url: string, host: string,
): UrlFilterEntry | undefined {
  for (const entry of filters) {
    if (entry.type === 'regex') {
      if (safeRegex(entry.pattern)?.test(url) === true) return entry;
      continue;
    }
    if (entry.type === 'wildcard') {
      if (wildcardMatches(entry.pattern, url) || wildcardMatches(entry.pattern, host)) {
        return entry;
      }
      continue;
    }
    if (url.includes(entry.pattern) || host === entry.pattern) return entry;
  }
  return undefined;
}

function wildcardMatches(pattern: string, candidate: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(candidate);
}

function safeRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

function httpBody(payload: string): string | undefined {
  for (const parse of [parseResponse, parseRequest]) {
    const parsed = parse(payload);
    if (!parsed.ok) continue;

    const body = parsed.message.body;
    if (body === null) return undefined;
    return Array.from(body).map(byte => String.fromCharCode(byte)).join('');
  }
  return undefined;
}
