import { Zone } from '@/network/dns/zone/Zone';
import type {
  ResourceRecord, ResourceRecordData, SoaRecordData, ARecordData, AaaaRecordData, NsRecordData,
  CnameRecordData, PtrRecordData, MxRecordData, TxtRecordData, SrvRecordData, DhcidRecordData,
} from '@/network/dns/wire/ResourceRecord';
import {
  makeARecord, makeAaaaRecord, makeNsRecord, makeCnameRecord, makePtrRecord,
  makeMxRecord, makeTxtRecord, makeSrvRecord, makeSoaRecord, makeDhcidRecord,
} from '@/network/dns/wire/ResourceRecord';
import { dhcidFromPresentation, dhcidToPresentation } from '@/network/dns/wire/Dhcid';
import { RRType } from '@/network/dns/wire/RRType';
import { IPAddress, IPv6Address } from '@/network/core/types';
import { isWithinDomain, normalizeDnsName } from '@/network/dns/wire/DnsName';

export type ZoneLocator = (file: string) => string;
export type ZoneWarning = (file: string, zoneName: string) => string;

export class ZoneFileError extends Error {
  constructor(
    readonly reason: string,
    readonly locators: readonly ZoneLocator[] = [],
    readonly stage: 'load' | 'check' = 'load',
  ) {
    super(reason);
    this.name = 'ZoneFileError';
  }
}

export function zoneFailureReport(zoneName: string, file: string, error: ZoneFileError): string[] {
  const subject = `zone ${zoneName}/IN`;
  return [
    ...error.locators.map((locator) => locator(file)),
    error.stage === 'load' ? `${subject}: loading from master file ${file} failed: ${error.reason}` : `${subject}: ${error.reason}`,
    `${subject}: not loaded due to errors.`,
  ];
}

export interface ZoneLoad {
  readonly zone: Zone;
  readonly warnings: readonly ZoneWarning[];
}

interface Token {
  readonly text: string;
  readonly line: number;
}

interface Statement {
  readonly tokens: readonly Token[];
  readonly indented: boolean;
  readonly line: number;
}

interface Problem {
  readonly reason: string;
  readonly locator: ZoneLocator | null;
}

class StatementFailure extends Error {
  constructor(readonly problem: Problem) {
    super(problem.reason);
  }
}

const CLASS_KEYWORD = /^(IN|CH|HS|ANY)$/i;
const TTL_WORD = /^(\d+)([smhdw]?)$/i;
const TTL_UNIT_SECONDS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
const DOTTED_QUAD = /^\d{1,3}(\.\d{1,3}){3}$/;
const MAX_UINT16 = 65535;
const MAX_UINT32 = 4294967295;
const DNSSEC_COMPANIONS: ReadonlySet<number> = new Set([RRType.RRSIG, RRType.NSEC]);

function ttlValue(word: string): number | null {
  const match = TTL_WORD.exec(word);
  return match === null ? null : Number(match[1]) * TTL_UNIT_SECONDS[(match[2] || 's').toLowerCase()];
}

function scan(text: string): { statements: Statement[]; unbalancedQuoteLine: number | null } {
  const statements: Statement[] = [];
  let tokens: Token[] = [];
  let indented = false;
  let buffer = '';
  let bufferLine = 1;
  let quoted = false;
  let quoteLine = 1;
  let depth = 0;
  let line = 1;
  let atLineStart = true;

  const endToken = (): void => {
    if (buffer !== '') tokens.push({ text: buffer, line: bufferLine });
    buffer = '';
  };
  const endStatement = (): void => {
    endToken();
    if (tokens.length > 0) statements.push({ tokens, indented, line: tokens[0].line });
    tokens = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '\\' && i + 1 < text.length) { buffer += text[++i]; continue; }
      if (ch === '"') { quoted = false; tokens.push({ text: buffer, line: quoteLine }); buffer = ''; continue; }
      if (ch === '\n') line++;
      buffer += ch;
      continue;
    }
    if (ch === '\n') {
      if (depth === 0) endStatement();
      else endToken();
      line++;
      atLineStart = true;
      continue;
    }
    if (atLineStart && depth === 0 && tokens.length === 0 && buffer === '') indented = ch === ' ' || ch === '\t';
    atLineStart = false;
    if (ch === ';') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
      continue;
    }
    if (ch === '"') { endToken(); quoted = true; quoteLine = line; continue; }
    if (ch === '(') { endToken(); depth++; continue; }
    if (ch === ')') { endToken(); depth = Math.max(0, depth - 1); continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { endToken(); continue; }
    if (buffer === '') bufferLine = line;
    buffer += ch;
  }
  endStatement();
  return { statements, unbalancedQuoteLine: quoted ? quoteLine : null };
}

function normalizeOrigin(token: string): string {
  return token.endsWith('.') ? token.slice(0, -1) : token;
}

function resolveName(token: string, origin: string): string {
  if (token === '@') return origin;
  if (token.endsWith('.')) return token.slice(0, -1);
  return `${token}.${origin}`;
}

class Rdata {
  private index = 0;
  private lastLine: number;

  constructor(
    private readonly tokens: readonly Token[],
    typeToken: Token,
    private readonly origin: string,
    private readonly locate: (line: number, near: string, reason: string) => never,
  ) {
    this.lastLine = typeToken.line;
  }

  private take(): Token {
    const token = this.tokens[this.index];
    if (token === undefined) this.locate(this.lastLine, 'eol', 'unexpected end of input');
    this.index++;
    return token;
  }

  private reject(token: Token, reason: string): never {
    return this.locate(this.lastLine, `'${token.text}'`, reason);
  }

  private accept(token: Token): string {
    this.lastLine = token.line;
    return token.text;
  }

  ipv4(): string {
    const token = this.take();
    if (!DOTTED_QUAD.test(token.text) || IPAddress.tryParse(token.text) === null) this.reject(token, 'bad dotted quad');
    return this.accept(token);
  }

  ipv6(): string {
    const token = this.take();
    if (IPv6Address.tryParse(token.text) === null) this.reject(token, 'bad IPv6 address');
    return this.accept(token);
  }

  name(): string {
    return resolveName(this.accept(this.take()), this.origin);
  }

  number(maximum = MAX_UINT16): number {
    const token = this.take();
    if (!/^\d+$/.test(token.text) || Number(token.text) > maximum) this.reject(token, 'not a valid number');
    return Number(this.accept(token));
  }

  timer(): number {
    const token = this.take();
    const value = ttlValue(token.text);
    if (value === null || value > MAX_UINT32) this.reject(token, 'not a valid number');
    this.accept(token);
    return value;
  }

  rest(): string[] {
    if (this.index >= this.tokens.length) this.locate(this.lastLine, 'eol', 'unexpected end of input');
    const texts = this.tokens.slice(this.index).map((token) => token.text);
    this.index = this.tokens.length;
    return texts;
  }

  finish(): void {
    const token = this.tokens[this.index];
    if (token !== undefined) this.reject(token, 'extra input text');
  }
}

export interface ParsedZoneRecords {
  readonly records: readonly ResourceRecord[];
  readonly soaOrigin: string | null;
}

interface ScannedZone extends ParsedZoneRecords {
  readonly lines: readonly number[];
  readonly exchangeTexts: readonly (string | null)[];
  readonly problems: readonly Problem[];
}

function scanZone(text: string, defaultOrigin?: string): ScannedZone {
  const { statements, unbalancedQuoteLine } = scan(text);
  const problems: Problem[] = [];
  const records: ResourceRecord[] = [];
  const lines: number[] = [];
  const exchangeTexts: (string | null)[] = [];
  const typesAt = new Map<string, Set<number>>();

  let origin: string | null = defaultOrigin ? normalizeOrigin(defaultOrigin) : null;
  let defaultTtl: number | undefined;
  let soaMinimum: number | undefined;
  let lastOwner: string | null = null;
  let soaOrigin: string | null = null;

  const rdataProblem = (line: number, near: string, reason: string): never => {
    throw new StatementFailure({
      reason,
      locator: (file) => `dns_rdata_fromtext: ${file}:${line}: ${near === '' ? '' : `near ${near}: `}${reason}`,
    });
  };

  for (const statement of statements) {
    const { tokens } = statement;
    try {
      if (tokens[0].text.startsWith('$')) {
        const directive = tokens[0].text.toUpperCase();
        if (directive === '$ORIGIN') {
          origin = normalizeOrigin(tokens[1]?.text ?? '');
        } else if (directive === '$TTL') {
          const value = tokens[1] === undefined ? null : ttlValue(tokens[1].text);
          if (value === null) throw new ZoneFileError('bad ttl', problems.map((problem) => problem.locator).filter((locator): locator is ZoneLocator => locator !== null));
          defaultTtl = value;
        } else {
          throw new StatementFailure({ reason: `unsupported zone file directive "${tokens[0].text}"`, locator: null });
        }
        continue;
      }

      let owner: string;
      let rest: readonly Token[];
      if (statement.indented) {
        if (lastOwner === null) {
          throw new StatementFailure({ reason: `record line has no owner name and none precedes it: "${tokens.map((token) => token.text).join(' ')}"`, locator: null });
        }
        owner = lastOwner;
        rest = tokens;
      } else {
        if (origin === null) throw new StatementFailure({ reason: 'a $ORIGIN directive (or a default origin) is required before any record', locator: null });
        owner = resolveName(tokens[0].text, origin);
        rest = tokens.slice(1);
      }
      lastOwner = owner;
      if (origin === null) throw new StatementFailure({ reason: 'a $ORIGIN directive (or a default origin) is required before any record', locator: null });

      let ttl: number | undefined;
      let index = 0;
      while (index < rest.length) {
        const value = ttlValue(rest[index].text);
        if (value !== null) { ttl = value; index++; continue; }
        if (CLASS_KEYWORD.test(rest[index].text)) { index++; continue; }
        break;
      }
      if (ttl === undefined) ttl = defaultTtl ?? soaMinimum;
      if (ttl === undefined) {
        throw new StatementFailure({ reason: `record for owner "${owner}" has no TTL and no $TTL default is in scope`, locator: null });
      }

      const typeToken = rest[index];
      if (typeToken === undefined) {
        throw new StatementFailure({ reason: `record for owner "${owner}" is missing its record type`, locator: null });
      }
      const type = typeToken.text.toUpperCase();
      const data = new Rdata(rest.slice(index + 1), typeToken, origin, rdataProblem);

      let rr: ResourceRecord;
      let exchangeText: string | null = null;
      switch (type) {
        case 'A': rr = makeARecord(owner, ttl, data.ipv4()); data.finish(); break;
        case 'AAAA': rr = makeAaaaRecord(owner, ttl, data.ipv6()); data.finish(); break;
        case 'NS': rr = makeNsRecord(owner, ttl, data.name()); data.finish(); break;
        case 'CNAME': rr = makeCnameRecord(owner, ttl, data.name()); data.finish(); break;
        case 'PTR': rr = makePtrRecord(owner, ttl, data.name()); data.finish(); break;
        case 'MX': {
          const preference = data.number();
          exchangeText = rest[index + 2]?.text ?? null;
          rr = makeMxRecord(owner, ttl, preference, data.name());
          data.finish();
          break;
        }
        case 'TXT': {
          const strings = data.rest();
          rr = makeTxtRecord(owner, ttl, strings.length === 1 ? strings[0] : strings);
          break;
        }
        case 'SRV': {
          const priority = data.number();
          const weight = data.number();
          const port = data.number();
          rr = makeSrvRecord(owner, ttl, { priority, weight, port, target: data.name() });
          data.finish();
          break;
        }
        case 'DHCID': rr = makeDhcidRecord(owner, ttl, dhcidFromPresentation(data.rest().join(''))); break;
        case 'SOA': {
          const mname = data.name();
          const rname = data.name();
          const serial = data.number(MAX_UINT32);
          const refresh = data.timer();
          const retry = data.timer();
          const expire = data.timer();
          const minimum = data.timer();
          data.finish();
          const soa = makeSoaRecord(owner, ttl, { mname, rname, serial, refresh, retry, expire, minimum });
          soaMinimum = minimum;
          rr = soa;
          break;
        }
        default:
          if (type in RRType) {
            throw new StatementFailure({ reason: `unrecognized record type "${typeToken.text}" for owner "${owner}"`, locator: null });
          }
          throw new StatementFailure({
            reason: 'unknown class/type',
            locator: (file) => `${file}:${typeToken.line}: unknown RR type '${typeToken.text}'`,
          });
      }

      const held = typesAt.get(normalizeDnsName(owner)) ?? new Set<number>();
      const clash = rr.data.type === RRType.CNAME
        ? [...held].some((heldType) => !DNSSEC_COMPANIONS.has(heldType) && heldType !== RRType.CNAME)
        : !DNSSEC_COMPANIONS.has(rr.data.type) && held.has(RRType.CNAME);
      if (clash) {
        throw new StatementFailure({
          reason: 'CNAME and other data',
          locator: (file) => `dns_master_load: ${file}:${statement.line}: ${owner}: CNAME and other data`,
        });
      }
      held.add(rr.data.type);
      typesAt.set(normalizeDnsName(owner), held);

      if (rr.data.type === RRType.SOA) soaOrigin = origin;
      records.push(rr);
      lines.push(statement.line);
      exchangeTexts.push(exchangeText);
    } catch (error) {
      if (error instanceof StatementFailure) { problems.push(error.problem); continue; }
      if (error instanceof ZoneFileError) {
        throw new ZoneFileError(error.reason, [...problems.map((problem) => problem.locator), ...error.locators].filter((locator): locator is ZoneLocator => locator !== null));
      }
      throw error;
    }
  }

  if (unbalancedQuoteLine !== null) {
    const line = unbalancedQuoteLine;
    problems.push({ reason: 'unbalanced quotes', locator: (file) => `dns_rdata_fromtext: ${file}:${line}: unbalanced quotes` });
  }
  return { records, lines, exchangeTexts, soaOrigin, problems };
}

function failWith(problems: readonly Problem[]): never {
  throw new ZoneFileError(problems[0].reason, problems.map((problem) => problem.locator).filter((locator): locator is ZoneLocator => locator !== null));
}

export function parseZoneRecords(text: string, defaultOrigin?: string): ParsedZoneRecords {
  const scanned = scanZone(text, defaultOrigin);
  if (scanned.problems.length > 0) failWith(scanned.problems);
  return { records: scanned.records, soaOrigin: scanned.soaOrigin };
}

function buildZone(text: string, defaultOrigin: string | undefined, named: boolean): ZoneLoad {
  const scanned = scanZone(text, defaultOrigin);
  if (scanned.problems.length > 0) failWith(scanned.problems);
  const soas = scanned.records.filter((rr) => rr.data.type === RRType.SOA);
  if (soas.length !== 1 || scanned.soaOrigin === null) throw new ZoneFileError(`has ${soas.length} SOA records`, [], 'check');
  const origin = scanned.soaOrigin;
  const warnings: ZoneWarning[] = [];
  const kept: ResourceRecord[] = [];
  scanned.records.forEach((rr, index) => {
    const line = scanned.lines[index];
    if (named && !isWithinDomain(normalizeDnsName(rr.name), normalizeDnsName(origin))) {
      warnings.push((file) => `${file}:${line}: ignoring out-of-zone data (${rr.name})`);
      return;
    }
    kept.push(rr);
    const exchange = scanned.exchangeTexts[index];
    if (named && exchange !== null && (IPAddress.tryParse(exchange) !== null || IPv6Address.tryParse(exchange) !== null)) {
      warnings.push((file) => `${file}:${line}: warning: '${exchange}': MX is an address`);
    }
  });
  if (named && !kept.some((rr) => rr.data.type === RRType.NS && normalizeDnsName(rr.name) === normalizeDnsName(origin))) {
    throw new ZoneFileError('has no NS records', [], 'check');
  }
  const zone = new Zone(origin, soas[0] as ResourceRecord<SoaRecordData>);
  for (const rr of kept) {
    if (rr.data.type !== RRType.SOA) zone.addRecord(rr);
  }
  if (named) {
    for (const rr of kept) {
      if (rr.data.type !== RRType.MX) continue;
      const target = (rr.data as MxRecordData).exchange;
      if (!isWithinDomain(normalizeDnsName(target), normalizeDnsName(origin))) continue;
      const hasAddress = (zone.getRRSet(target, RRType.A)?.length ?? 0) + (zone.getRRSet(target, RRType.AAAA)?.length ?? 0) > 0;
      if (!hasAddress) warnings.push((_file, zoneName) => `zone ${zoneName}/IN: ${rr.name}/MX '${target}' has no address records (A or AAAA)`);
    }
  }
  return { zone, warnings };
}

export function loadZoneFile(text: string, defaultOrigin?: string): ZoneLoad {
  return buildZone(text, defaultOrigin, true);
}

export function parseZoneFile(text: string, defaultOrigin?: string): Zone {
  return buildZone(text, defaultOrigin, false).zone;
}

function absoluteName(name: string): string {
  return name.endsWith('.') ? name : `${name}.`;
}

function renderRdata(data: ResourceRecordData): string | null {
  switch (data.type) {
    case RRType.A: return (data as ARecordData).address.toString();
    case RRType.AAAA: return (data as AaaaRecordData).address.toString();
    case RRType.NS: return absoluteName((data as NsRecordData).nsdname);
    case RRType.CNAME: return absoluteName((data as CnameRecordData).cname);
    case RRType.PTR: return absoluteName((data as PtrRecordData).ptrdname);
    case RRType.MX: {
      const mx = data as MxRecordData;
      return `${mx.preference} ${absoluteName(mx.exchange)}`;
    }
    case RRType.TXT: return (data as TxtRecordData).text.map(t => `"${t.replace(/(["\\])/g, '\\$1')}"`).join(' ');
    case RRType.SRV: {
      const srv = data as SrvRecordData;
      return `${srv.priority} ${srv.weight} ${srv.port} ${absoluteName(srv.target)}`;
    }
    case RRType.DHCID: return dhcidToPresentation(data as DhcidRecordData);
    default: return null;
  }
}

const RENDERED_TYPE_NAME = new Map<number, string>(
  Object.entries(RRType).map(([name, code]) => [code as number, name]),
);

export function renderZoneFile(zone: Zone): string {
  const soa = zone.soa;
  const timers = soa.data;
  const lines = [
    `$ORIGIN ${absoluteName(zone.origin)}`,
    `$TTL ${timers.minimum}`,
    `${absoluteName(soa.name)} ${soa.ttl} IN SOA ${absoluteName(timers.mname)} ${absoluteName(timers.rname)} `
      + `${timers.serial} ${timers.refresh} ${timers.retry} ${timers.expire} ${timers.minimum}`,
  ];
  for (const rr of zone.allRecords()) {
    if (rr.data.type === RRType.SOA) continue;
    const rdata = renderRdata(rr.data);
    const typeName = RENDERED_TYPE_NAME.get(rr.data.type);
    if (rdata === null || typeName === undefined) continue;
    lines.push(`${absoluteName(rr.name)} ${rr.ttl} IN ${typeName} ${rdata}`);
  }
  return `${lines.join('\n')}\n`;
}
