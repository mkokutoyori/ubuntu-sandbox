import { confBoolean, type ConfSection } from './FreeradiusConf';
import { RADIUS_ATTR, type RadiusAttribute, type RadiusPacket } from '@/network/radius/types';
import { formatRadiusAttribute, radiusAttributeDisplayName } from '@/network/radius/attributeText';
import { md5Hex } from '@/crypto/hash/md5';
import { expandTemplate, type Lookup } from './Xlat';

export interface DetailSettings {
  filename: string;
  header: string;
  permissions: number;
  logPacketHeader: boolean;
  datesAsInteger: boolean;
  escapeFilenames: boolean;
  locking: boolean;
  group: string | null;
  suppressed: ReadonlySet<string>;
}

export interface DetailRecord {
  sourceIp: string;
  destinationIp: string;
  sourcePort: number;
  destinationPort: number;
  packet: RadiusPacket;
  atMs: number;
}

const KNOWN_KEYS = new Set([
  'filename', 'detailfile', 'header', 'permissions', 'detailperm', 'group', 'locking', 'dates_as_integer',
  'escape_filenames', 'log_packet_header',
]);

export function readDetailSettings(root: ConfSection): DetailSettings | null | { error: string } {
  const modules = root.sections.find((section) => section.name1 === 'modules') ?? root;
  const section = modules.sections.find((candidate) => candidate.name1 === 'detail' && candidate.name2 === null);
  if (!section) return null;
  const settings: DetailSettings = {
    filename: '/var/log/freeradius/radacct/%{%{Packet-Src-IP-Address}:-%{Packet-Src-IPv6-Address}}/detail-%Y%m%d',
    header: '%t', permissions: 0o600, logPacketHeader: false, datesAsInteger: false, escapeFilenames: false,
    locking: false, group: null, suppressed: new Set(),
  };
  const fail = (pair: { file: string; line: number }, message: string) => ({ error: `${pair.file}[${pair.line}]: ${message}` });
  for (const pair of section.pairs) {
    if (!KNOWN_KEYS.has(pair.name)) continue;
    if (pair.name === 'filename' || pair.name === 'detailfile') settings.filename = pair.value;
    else if (pair.name === 'header') settings.header = pair.value;
    else if (pair.name === 'permissions' || pair.name === 'detailperm') {
      const parsed = /^0[0-7]*$/.test(pair.value) ? parseInt(pair.value, 8) : /^\d+$/.test(pair.value) ? Number(pair.value) : NaN;
      if (Number.isNaN(parsed)) return fail(pair, `Invalid value '${pair.value}' for variable ${pair.name}`);
      settings.permissions = parsed;
    } else if (pair.name === 'group') settings.group = pair.value;
    else {
      const value = confBoolean(pair);
      if (typeof value === 'object') return value;
      if (pair.name === 'locking') settings.locking = value;
      else if (pair.name === 'dates_as_integer') settings.datesAsInteger = value;
      else if (pair.name === 'escape_filenames') settings.escapeFilenames = value;
      else settings.logPacketHeader = value;
    }
  }
  const suppress = section.sections.find((candidate) => candidate.name1 === 'suppress');
  if (suppress) {
    const names = new Set<string>();
    for (const pair of suppress.pairs) {
      const key = pair.name.toLowerCase();
      if (!(key in RADIUS_ATTR)) return fail(section, `No such attribute '${pair.name}'`);
      names.add(key);
    }
    return { ...settings, suppressed: names };
  }
  return settings;
}

function lookupFor(record: DetailRecord): Lookup {
  return (name) => {
    switch (name.toLowerCase()) {
      case 'packet-src-ip-address': return record.sourceIp;
      case 'packet-dst-ip-address': return record.destinationIp;
      case 'packet-src-port': return String(record.sourcePort);
      case 'packet-dst-port': return String(record.destinationPort);
      default: {
        const found = record.packet.attributes.find((attribute) => radiusAttributeDisplayName(attribute).toLowerCase() === name.toLowerCase());
        return found === undefined ? undefined : String(found.value);
      }
    }
  };
}

export function makeFilenameSafe(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char !== '/') {
      out += char.charCodeAt(0) < 32 ? '_' : char;
      continue;
    }
    out += '/';
    while (index + 1 < value.length) {
      if (value[index + 1] === '/') { index += 1; continue; }
      if (value.startsWith('./', index + 1)) { index += 2; continue; }
      if (value.startsWith('../', index + 1)) { index += 3; continue; }
      break;
    }
  }
  return out;
}

export function escapeFilename(value: string): string {
  let out = '';
  for (const char of value) {
    if (/[A-Za-z0-9_]/.test(char)) out += char;
    else if (char === '-') out += '--';
    else if (char.charCodeAt(0) > 127) out += [...new TextEncoder().encode(char)].map((byte) => `-${byte.toString(16)}`).join('');
    else out += `-${char.charCodeAt(0).toString(16).padStart(2, '0')}`;
  }
  return out;
}

export function detailPath(settings: DetailSettings, record: DetailRecord): string {
  const escape = settings.escapeFilenames ? escapeFilename : makeFilenameSafe;
  return expandTemplate(settings.filename, lookupFor(record), record.atMs, escape);
}

export function detailEntry(settings: DetailSettings, record: DetailRecord, acctUnique = true): string {
  const lookup = lookupFor(record);
  const lines = [expandTemplate(settings.header, lookup, record.atMs, (value) => value)];
  if (settings.logPacketHeader) {
    lines.push(`\tPacket-Src-IP-Address = ${record.sourceIp}`, `\tPacket-Dst-IP-Address = ${record.destinationIp}`,
      `\tPacket-Src-Port = ${record.sourcePort}`, `\tPacket-Dst-Port = ${record.destinationPort}`);
  }
  for (const attribute of record.packet.attributes) {
    if (settings.suppressed.has(attribute.type) || attribute.type === 'user-password') continue;
    lines.push(`\t${renderAttribute(settings, attribute)}`);
  }
  if (acctUnique) lines.push(`\tAcct-Unique-Session-Id = "${acctUniqueSessionId(lookup)}"`);
  lines.push(`\tTimestamp = ${Math.floor(record.atMs / 1000)}`, '', '');
  return lines.join('\n');
}

function acctUniqueSessionId(lookup: Lookup): string {
  const value = (name: string): string => lookup(name) ?? '';
  const nasAddress = value('NAS-IPv6-Address') !== '' ? value('NAS-IPv6-Address') : value('NAS-IP-Address');
  return md5Hex([value('User-Name'), value('Acct-Session-ID'), nasAddress, value('NAS-Identifier'), value('NAS-Port-ID'), value('NAS-Port')].join(','));
}

function renderAttribute(settings: DetailSettings, attribute: RadiusAttribute): string {
  if (settings.datesAsInteger && attribute.type === 'event-timestamp') return `${radiusAttributeDisplayName(attribute)} = ${attribute.value}`;
  return formatRadiusAttribute(attribute);
}
