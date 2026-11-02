import { hexPrintLines, nullPaddedText } from './TcpdumpHex';

const TLV_NAMES: Readonly<Record<number, string>> = {
  0: 'End', 1: 'Chassis ID', 2: 'Port ID', 3: 'Time to Live', 4: 'Port Description', 5: 'System Name',
  6: 'System Description', 7: 'System Capabilities', 8: 'Management Address', 127: 'Organization specific',
};

const CHASSIS_SUBTYPES: Readonly<Record<number, string>> = {
  1: 'Chassis component', 2: 'Interface alias', 3: 'Port component', 4: 'MAC address', 5: 'Network address',
  6: 'Interface name', 7: 'Local',
};

const PORT_SUBTYPES: Readonly<Record<number, string>> = {
  1: 'Interface alias', 2: 'Port component', 3: 'MAC address', 4: 'Network Address', 5: 'Interface Name',
  6: 'Agent circuit ID', 7: 'Local',
};

const CAPABILITIES: ReadonlyArray<readonly [number, string]> = [
  [0x01, 'Other'], [0x02, 'Repeater'], [0x04, 'Bridge'], [0x08, 'WLAN AP'], [0x10, 'Router'],
  [0x20, 'Telephone'], [0x40, 'Docsis'], [0x80, 'Station Only'],
];

const OUIS: Readonly<Record<number, string>> = {
  0x0080c2: 'Ethernet bridged', 0x00120f: 'IEEE 802.3 Private',
};

const OUI_IEEE_8021 = 0x0080c2;
const OUI_IEEE_8023 = 0x00120f;
const SUBTYPES_8021: Readonly<Record<number, string>> = {
  1: 'Port VLAN Id', 2: 'Port and Protocol VLAN ID', 3: 'VLAN name', 4: 'Protocol Identity',
};
const SUBTYPES_8023: Readonly<Record<number, string>> = {
  1: 'MAC/PHY configuration/status', 2: 'Power via MDI', 3: 'Link aggregation', 4: 'Max frame size',
};
const AUTONEGOTIATION: ReadonlyArray<readonly [number, string]> = [[0x01, 'supported'], [0x02, 'enabled']];
const INTERFACE_NUMBERING: Readonly<Record<number, string>> = { 2: 'Interface Index', 3: 'System Port Number' };
const ADDRESS_FAMILIES: Readonly<Record<number, string>> = { 1: 'IPv4', 2: 'IPv6', 6: '802' };
const INTERFACE_NUMBER_BYTES = 5;

function u16(bytes: readonly number[], at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

function u32(bytes: readonly number[], at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}

function bitTokens(tokens: ReadonlyArray<readonly [number, string]>, value: number, none: string): string {
  const found = tokens.filter(([bit]) => (value & bit) === bit).map(([, name]) => name);
  return found.length === 0 ? none : found.join(', ');
}

type EtherName = (mac: string) => string;

function macText(bytes: readonly number[], at: number, ether: EtherName): string {
  return ether(bytes.slice(at, at + 6).map((byte) => hex(byte, 2)).join(':'));
}

function ipv6Text(bytes: readonly number[], at: number): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(u16(bytes, at + i).toString(16));
  return groups.join(':');
}

function networkAddress(bytes: readonly number[], at: number, length: number, name: (a: string) => string, ether: EtherName): string | null {
  if (length < 1) return null;
  const family = bytes[at];
  const rest = length - 1;
  let printed: string | null = null;
  if (family === 1) {
    if (rest < 4) return null;
    printed = name(`${bytes[at + 1]}.${bytes[at + 2]}.${bytes[at + 3]}.${bytes[at + 4]}`);
  } else if (family === 2) {
    if (rest < 16) return null;
    printed = ipv6Text(bytes, at + 1);
  } else if (family === 6) {
    if (rest < 6) return null;
    printed = macText(bytes, at + 1, ether);
  }
  const label = ADDRESS_FAMILIES[family] ?? 'Unknown';
  return printed === null ? `AFI ${label} (${family}), no AF printer !` : `AFI ${label} (${family}): ${printed}`;
}

function managementAddress(value: readonly number[], name: (a: string) => string, ether: EtherName): string | null {
  if (value.length < 1) return null;
  const addressLength = value[0];
  if (value.length - 1 < addressLength) return null;
  const address = networkAddress(value, 1, addressLength, name, ether);
  if (address === null) return null;
  let text = `\n\t  Management Address length ${addressLength}, ${address}`;
  const numbering = 1 + addressLength;
  if (value.length - numbering < INTERFACE_NUMBER_BYTES) return null;
  text += `\n\t  ${INTERFACE_NUMBERING[value[numbering]] ?? 'Unknown'} Interface Numbering (${value[numbering]}): ${u32(value, numbering + 1)}`;
  const oid = numbering + INTERFACE_NUMBER_BYTES;
  if (value.length > oid) {
    const oidLength = value[oid];
    if (value.length - oid < 1 + oidLength) return null;
    if (oidLength !== 0) text += `\n\t  OID length ${oidLength}${nullPaddedText(value.slice(oid + 1, oid + 1 + oidLength))}`;
  }
  return text;
}

function organizationSpecific(value: readonly number[]): { text: string; hexdump: boolean } | null {
  if (value.length < 3) return null;
  const oui = (value[0] << 16) | u16(value, 1);
  let text = `: OUI ${OUIS[oui] ?? 'Unknown'} (0x${hex(oui, 6)})`;
  if ((oui !== OUI_IEEE_8021 && oui !== OUI_IEEE_8023) || value.length < 4) return { text, hexdump: true };
  const subtype = value[3];
  if (oui === OUI_IEEE_8021) {
    text += `\n\t  ${SUBTYPES_8021[subtype] ?? 'unknown'} Subtype (${subtype})`;
    if (subtype === 1) {
      if (value.length < 6) return { text, hexdump: false };
      return { text: `${text}\n\t    port vlan id (PVID): ${u16(value, 4)}`, hexdump: false };
    }
    if (subtype === 3) {
      if (value.length < 6) return { text, hexdump: false };
      text += `\n\t    vlan id (VID): ${u16(value, 4)}`;
      if (value.length < 7) return { text, hexdump: false };
      const nameLength = value[6];
      if (value.length < 7 + nameLength) return { text, hexdump: false };
      return { text: `${text}\n\t    vlan name: ${nullPaddedText(value.slice(7, 7 + nameLength))}`, hexdump: false };
    }
    return { text, hexdump: true };
  }
  text += `\n\t  ${SUBTYPES_8023[subtype] ?? 'unknown'} Subtype (${subtype})`;
  if (subtype === 1) {
    if (value.length < 9) return { text, hexdump: false };
    text += `\n\t    autonegotiation [${bitTokens(AUTONEGOTIATION, value[4], 'none')}] (0x${hex(value[4], 2)})`;
    text += `\n\t    PMD autoneg capability [unknown] (0x${hex(u16(value, 5), 4)})`;
    text += `\n\t    MAU type ${u16(value, 7) === 0 ? 'Unknown' : 'unknown'} (0x${hex(u16(value, 7), 4)})`;
    return { text, hexdump: false };
  }
  if (subtype === 4) {
    if (value.length < 6) return { text, hexdump: false };
    return { text: `${text}\n\t    MTU size ${u16(value, 4)}`, hexdump: false };
  }
  return { text, hexdump: true };
}

export function lldpText(payload: readonly number[], verbose: number, name: (address: string) => string, ether: EtherName): string {
  let text = `LLDP, length ${payload.length}`;
  let at = 0;
  let left = payload.length;
  while (left >= 2) {
    const header = u16(payload, at);
    const type = header >>> 9;
    const length = header & 0x1ff;
    left -= 2;
    at += 2;
    if (verbose > 0) text += `\n\t${TLV_NAMES[type] ?? 'Unknown'} TLV (${type}), length ${length}`;
    if (type === 0 || length === 0) break;
    if (left < length) return `${text}[|lldp]`;
    const value = payload.slice(at, at + length);
    let hexdump = false;
    switch (type) {
      case 1:
      case 2: {
        if (verbose === 0) break;
        if (length < 2) return `${text}[|lldp]`;
        const subtype = value[0];
        const names = type === 1 ? CHASSIS_SUBTYPES : PORT_SUBTYPES;
        const macSubtype = type === 1 ? 4 : 3;
        const addressSubtype = 5 - (type === 1 ? 0 : 1);
        const textSubtypes = type === 1 ? [6, 7, 1, 2, 3] : [5, 7, 6, 1, 2];
        text += `\n\t  Subtype ${names[subtype] ?? 'Unknown'} (${subtype}): `;
        if (subtype === macSubtype) {
          if (length < 7) return `${text}[|lldp]`;
          text += macText(value, 1, ether);
        } else if (textSubtypes.includes(subtype)) {
          text += nullPaddedText(value.slice(1));
        } else if (subtype === addressSubtype) {
          const address = networkAddress(value, 1, length - 1, name, ether);
          if (address === null) return `${text}[|lldp]`;
          text += address;
        } else {
          hexdump = true;
        }
        break;
      }
      case 3:
        if (verbose > 0) {
          if (length < 2) return `${text}[|lldp]`;
          text += `: TTL ${u16(value, 0)}s`;
        }
        break;
      case 4:
        if (verbose > 0) text += `: ${nullPaddedText(value)}`;
        break;
      case 5:
        text += `: ${nullPaddedText(value)}`;
        break;
      case 6:
        if (verbose > 0) text += `\n\t  ${nullPaddedText(value)}`;
        break;
      case 7:
        if (verbose > 0) {
          if (length < 4) return `${text}[|lldp]`;
          const capable = u16(value, 0);
          const enabled = u16(value, 2);
          text += `\n\t  System  Capabilities [${bitTokens(CAPABILITIES, capable, 'none')}] (0x${hex(capable, 4)})`;
          text += `\n\t  Enabled Capabilities [${bitTokens(CAPABILITIES, enabled, 'none')}] (0x${hex(enabled, 4)})`;
        }
        break;
      case 8:
        if (verbose > 0) {
          const printed = managementAddress(value, name, ether);
          if (printed === null) return `${text}[|lldp]`;
          text += printed;
        }
        break;
      case 127:
        if (verbose > 0) {
          const printed = organizationSpecific(value);
          if (printed === null) return `${text}[|lldp]`;
          text += printed.text;
          hexdump = printed.hexdump;
        }
        break;
      default:
        hexdump = true;
        break;
    }
    if (verbose > 1 || (verbose > 0 && hexdump)) text += hexPrintLines(value, '\n\t  ');
    left -= length;
    at += length;
  }
  return text;
}
