import { RRType } from '@/network/dns/wire/RRType';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';
import { findOpt } from '@/network/dns/wire/EdnsOptRecord';
import { rcodeText, rrTypeName } from '@/network/dns/compat/DnsWireCompat';
import { formatQuestionLine, formatRdata, formatRecordLine, headerFlags, isDisplayableRecord, stripDot } from '../RecordFormat';
import { formatDnsName, parseDnsNameText } from './HostNames';

const OPCODE_TEXTS = [
  'QUERY', 'IQUERY', 'STATUS', 'RESERVED3', 'NOTIFY', 'UPDATE', 'RESERVED6', 'RESERVED7', 'RESERVED8', 'RESERVED9', 'RESERVED10',
  'RESERVED11', 'RESERVED12', 'RESERVED13', 'RESERVED14', 'RESERVED15',
] as const;

const PHRASES: ReadonlyMap<number, string> = new Map([
  [1, 'has address'], [2, 'name server'], [5, 'is an alias for'], [11, 'has well known services'], [12, 'domain name pointer'],
  [13, 'host information'], [15, 'mail is handled by'], [16, 'descriptive text'], [19, 'x25 address'], [20, 'ISDN address'],
  [24, 'has signature'], [25, 'has key'], [28, 'has IPv6 address'], [29, 'location'],
]);

const LISTED_WITH_ADDRESSES = new Set<number>([RRType.A, RRType.AAAA, RRType.NS, RRType.PTR]);
const NSEC3_TYPE = 50;
const OMITTED_BY_ALMOST_ALL = new Set<number>([RRType.RRSIG, RRType.NSEC, NSEC3_TYPE]);

export interface TransferFilter {
  readonly listAddresses: boolean;
  readonly listType: number;
  readonly almostAll: boolean;
  readonly transfer: boolean;
}

export interface RenderedMessage {
  readonly verbose: boolean;
  readonly filter: TransferFilter;
  readonly nameserverPrefix: string | null;
}

interface RecordSet {
  readonly type: number;
  readonly records: ResourceRecord<ResourceRecordData>[];
}

interface NameGroup {
  readonly name: string;
  readonly sets: RecordSet[];
}

function groupedByName(records: readonly ResourceRecord<ResourceRecordData>[]): NameGroup[] {
  const groups = new Map<string, NameGroup>();
  for (const record of records.filter(isDisplayableRecord)) {
    const key = record.name.toLowerCase().replace(/\.$/, '');
    let group = groups.get(key);
    if (group === undefined) {
      group = { name: record.name, sets: [] };
      groups.set(key, group);
    }
    let set = group.sets.find((candidate) => candidate.type === record.data.type);
    if (set === undefined) {
      set = { type: record.data.type, records: [] };
      group.sets.push(set);
    }
    set.records.push(record);
  }
  return [...groups.values()];
}

function listedBy(filter: TransferFilter, type: number): boolean {
  if (filter.transfer) {
    const wanted = filter.listAddresses ? LISTED_WITH_ADDRESSES.has(type) : filter.listType === RRType.ANY || type === filter.listType;
    if (!wanted) return false;
  }
  return !(filter.almostAll && OMITTED_BY_ALMOST_ALL.has(type));
}

function ownerText(name: string): string {
  const parsed = parseDnsNameText(name);
  if (name === '') return '.';
  return 'name' in parsed ? formatDnsName(parsed.name.labels) : stripDot(name);
}

function shortLines(group: NameGroup, filter: TransferFilter, nameserver: string | null): string {
  let text = '';
  for (const set of group.sets) {
    if (!listedBy(filter, set.type)) continue;
    const phrase = PHRASES.get(set.type) ?? `has ${rrTypeName(set.type)} record`;
    for (const record of set.records) {
      text += `${nameserver === null ? '' : `Nameserver ${nameserver}:\n\t`}${ownerText(group.name)} ${phrase} ${formatRdata(record)}\n`;
    }
  }
  return text;
}

function verboseSection(title: string, records: readonly ResourceRecord<ResourceRecordData>[], filter: TransferFilter): string {
  let text = `;; ${title} SECTION:\n`;
  for (const group of groupedByName(records)) {
    for (const set of group.sets) {
      if (listedBy(filter, set.type)) text += set.records.map((record) => `${formatRecordLine(record)}\n`).join('');
    }
  }
  return text;
}

function questionSection(message: DnsMessage, filter: TransferFilter): string {
  let text = ';; QUESTION SECTION:\n';
  for (const question of message.questions) {
    text += listedBy(filter, question.qtype) ? `${formatQuestionLine(question.qname, question.qclass, question.qtype)}\n` : ';';
  }
  return text;
}

export function opcodeText(opcode: number): string {
  return OPCODE_TEXTS[opcode] ?? `RESERVED${opcode}`;
}

export function renderHeader(message: DnsMessage): string {
  let text = `;; ->>HEADER<<- opcode: ${opcodeText(message.flags.opcode)}, status: ${rcodeText(message.flags.rcode)}, id: ${message.id}\n`;
  text += `;; flags: ${headerFlags(message)}; QUERY: ${message.questions.length}, ANSWER: ${message.answers.length}, `;
  text += `AUTHORITY: ${message.authorities.length}, ADDITIONAL: ${message.additionals.length}\n`;
  const opt = findOpt(message);
  if (opt !== null) text += `;; EDNS: version: ${opt.data.version}, udp=${opt.data.udpPayloadSize}\n`;
  return text;
}

export function renderBody(message: DnsMessage, view: RenderedMessage): string {
  const { verbose, filter, nameserverPrefix } = view;
  let text = '';
  if (verbose) {
    text += renderHeader(message);
    if (message.questions.length > 0) text += `\n${questionSection(message, filter)}`;
  }
  const answers = message.answers.filter(isDisplayableRecord);
  if (answers.length > 0) {
    if (verbose) text += '\n';
    text += verbose ? verboseSection('ANSWER', message.answers, filter) : groupedByName(message.answers).map((group) => shortLines(group, filter, nameserverPrefix)).join('');
  }
  if (verbose && message.authorities.length > 0) text += `\n${verboseSection('AUTHORITY', message.authorities, filter)}`;
  if (verbose && message.additionals.filter(isDisplayableRecord).length > 0) text += `\n${verboseSection('ADDITIONAL', message.additionals, filter)}`;
  if (verbose) text += '\n';
  return text;
}
