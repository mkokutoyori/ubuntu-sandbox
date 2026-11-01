import { RRType } from '@/network/dns/wire/RRType';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ResourceRecord, ResourceRecordData, SoaRecordData } from '@/network/dns/wire/ResourceRecord';
import { rrTypeName } from '@/network/dns/compat/DnsWireCompat';

export type NslookupRecord = ResourceRecord<ResourceRecordData>;

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

export function elapsed(totalSeconds: number): string {
  if (totalSeconds === 0) return '0 secs';
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  const totalHours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const hours = totalHours % HOURS_PER_DAY;
  const days = Math.floor(totalHours / HOURS_PER_DAY);
  const parts: string[] = [];
  if (days > 0) parts.push(plural(days, 'day'));
  if (hours > 0) parts.push(plural(hours, 'hour'));
  if (minutes > 0) parts.push(plural(minutes, 'min'));
  if (seconds > 0) parts.push(plural(seconds, 'sec'));
  return parts.join(' ');
}

export function bareName(name: string): string {
  return name.endsWith('.') && name.length > 1 ? name.slice(0, -1) : name;
}

function timed(label: string, seconds: number): string {
  return `\t${label} = ${seconds} (${elapsed(seconds)})`;
}

function soaLines(data: SoaRecordData): string[] {
  return [
    `\tprimary name server = ${bareName(data.mname)}`,
    `\tresponsible mail addr = ${bareName(data.rname)}`,
    `\tserial  = ${data.serial}`,
    timed('refresh', data.refresh),
    timed('retry  ', data.retry),
    timed('expire ', data.expire),
    timed('default TTL', data.minimum),
  ];
}

export function dataLines(record: NslookupRecord): string[] {
  const data = record.data;
  switch (data.type) {
    case RRType.A: return [`internet address = ${data.address.toString()}`];
    case RRType.AAAA: return [`AAAA IPv6 address = ${data.address.toString()}`];
    case RRType.NS: return [`nameserver = ${bareName(data.nsdname)}`];
    case RRType.CNAME: return [`canonical name = ${bareName(data.cname)}`];
    case RRType.PTR: return [`name = ${bareName(data.ptrdname)}`];
    case RRType.MX: return [`MX preference = ${data.preference}, mail exchanger = ${bareName(data.exchange)}`];
    case RRType.TXT: return ['text =', '', ...data.text.map((segment) => `\t"${segment.replace(/^"|"$/g, '')}"`)];
    case RRType.SRV: return [
      'SRV service location:',
      `\t  priority       = ${data.priority}`,
      `\t  weight         = ${data.weight}`,
      `\t  port           = ${data.port}`,
      `\t  svr hostname   = ${bareName(data.target)}`,
    ];
    default: return [`${rrTypeName(data.type)} record`];
  }
}

export function recordLines(record: NslookupRecord): string[] {
  const owner = bareName(record.name);
  if (record.data.type === RRType.SOA) return [owner, ...soaLines(record.data)];
  const [first, ...rest] = dataLines(record);
  return [`${owner}\t${first}`, ...rest];
}

export function renderRecords(records: readonly NslookupRecord[]): string[] {
  return records.flatMap(recordLines);
}

export interface AddressBlock {
  readonly name: string;
  readonly addresses: readonly string[];
  readonly aliases: readonly string[];
}

const CONTINUATION_INDENT = ' '.repeat(10);

export function addressBlockLines(block: AddressBlock): string[] {
  const lines = [`Name:    ${bareName(block.name)}`];
  block.addresses.forEach((address, index) => {
    if (index === 0) lines.push(`${block.addresses.length > 1 ? 'Addresses' : 'Address'}:  ${address}`);
    else lines.push(`${CONTINUATION_INDENT}${address}`);
  });
  block.aliases.forEach((alias, index) => {
    lines.push(index === 0 ? `Aliases:  ${bareName(alias)}` : `${CONTINUATION_INDENT}${bareName(alias)}`);
  });
  return lines;
}

const OPCODE_NAMES = ['QUERY', 'IQUERY', 'STATUS', 'OPCODE3', 'NOTIFY', 'UPDATE'];
const RCODE_NAMES = ['NOERROR', 'FORMERR', 'SERVFAIL', 'NXDOMAIN', 'NOTIMP', 'REFUSED'];
const CLASS_NAMES = new Map<number, string>([[1, 'IN'], [3, 'CH'], [4, 'HS'], [255, 'ANY']]);

function headerFlags(message: DnsMessage): string {
  const names: string[] = [message.flags.qr ? 'response' : 'query'];
  if (message.flags.aa) names.push('auth. answer');
  if (message.flags.tc) names.push('truncation');
  if (message.flags.rd) names.push('want recursion');
  if (message.flags.ra) names.push('recursion avail.');
  return names.join(', ');
}

function debugRecordLines(record: NslookupRecord): string[] {
  const body = record.data.type === RRType.SOA ? soaLines(record.data) : dataLines(record).map((line) => (line.startsWith('\t') || line === '' ? line : `\t${line}`));
  return [`    ->  ${bareName(record.name)}`, ...body, `\tttl = ${record.ttl} (${elapsed(record.ttl)})`];
}

function debugSection(title: string, records: readonly NslookupRecord[]): string[] {
  return records.length === 0 ? [] : [`    ${title}:`, ...records.flatMap(debugRecordLines)];
}

export function debugPacketLines(message: DnsMessage): string[] {
  const lines = [
    '    HEADER:',
    `\topcode = ${OPCODE_NAMES[message.flags.opcode] ?? `OPCODE${message.flags.opcode}`}, id = ${message.id}, rcode = ${RCODE_NAMES[message.flags.rcode] ?? `RCODE${message.flags.rcode}`}`,
    `\theader flags:  ${headerFlags(message)}`,
    `\tquestions = ${message.questions.length},  answers = ${message.answers.length},  authority records = ${message.authorities.length},  additional = ${message.additionals.length}`,
    '',
  ];
  if (message.questions.length > 0) {
    lines.push('    QUESTIONS:');
    for (const question of message.questions) {
      lines.push(`\t${bareName(question.qname)}, type = ${rrTypeName(question.qtype)}, class = ${CLASS_NAMES.get(question.qclass) ?? question.qclass}`);
    }
  }
  lines.push(
    ...debugSection('ANSWERS', message.answers),
    ...debugSection('AUTHORITY RECORDS', message.authorities),
    ...debugSection('ADDITIONAL RECORDS', message.additionals),
    '',
  );
  return lines;
}
