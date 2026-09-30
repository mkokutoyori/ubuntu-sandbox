import { IPv6Address } from '../core/types';
import { DHCPv6Packet } from './DHCPv6Packet';
import type { DHCPv6IANA, DHCPv6IAPD } from './DHCPv6Packet';
import type { DHCPv6MessageType } from './types';

const MESSAGE_TYPES: ReadonlyArray<DHCPv6MessageType | null> = [
  null, 'SOLICIT', 'ADVERTISE', 'REQUEST', 'CONFIRM', 'RENEW', 'REBIND', 'REPLY', 'RELEASE', 'DECLINE',
  'RECONFIGURE', 'INFORMATION-REQUEST', 'RELAY-FORW', 'RELAY-REPL',
];

const CODE = {
  CLIENT_ID: 1, SERVER_ID: 2, IA_NA: 3, IA_ADDR: 5, ORO: 6, PREFERENCE: 7, ELAPSED_TIME: 8, RELAY_MESSAGE: 9,
  AUTH: 11, UNICAST: 12, STATUS_CODE: 13, RAPID_COMMIT: 14, INTERFACE_ID: 18, RECONF_MSG: 19, RECONF_ACCEPT: 20,
  DNS_SERVERS: 23, DOMAIN_LIST: 24, IA_PD: 25, IA_PREFIX: 26, INFORMATION_REFRESH_TIME: 32,
} as const;

const RECONFIGURE_TYPES = { RENEW: 5, REBIND: 6, 'INFORMATION-REQUEST': 11 } as const;

class Writer {
  private readonly bytes: number[] = [];

  u8(value: number): void { this.bytes.push(value & 0xff); }
  u16(value: number): void { this.u8(value >>> 8); this.u8(value); }
  u32(value: number): void { this.u16(value >>> 16); this.u16(value & 0xffff); }
  raw(data: ArrayLike<number>): void { for (let i = 0; i < data.length; i++) this.bytes.push(data[i]); }
  address(text: string): void {
    for (const hextet of new IPv6Address(text).getHextets()) this.u16(hextet);
  }
  option(code: number, body: ArrayLike<number>): void {
    this.u16(code);
    this.u16(body.length);
    this.raw(body);
  }
  result(): Uint8Array { return Uint8Array.from(this.bytes); }
}

function sub(build: (writer: Writer) => void): Uint8Array {
  const writer = new Writer();
  build(writer);
  return writer.result();
}

export function duidToBytes(text: string): Uint8Array {
  const parts = text.split(':');
  if (parts.length > 1 && parts.every(part => /^[0-9a-fA-F]{1,2}$/.test(part))) {
    return Uint8Array.from(parts.map(part => parseInt(part, 16)));
  }
  return new TextEncoder().encode(text);
}

function bytesToDuid(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(':');
}

function domainBytes(names: readonly string[]): Uint8Array {
  return sub(writer => {
    for (const name of names) {
      for (const label of name.split('.').filter(part => part.length > 0)) {
        const encoded = new TextEncoder().encode(label);
        writer.u8(encoded.length);
        writer.raw(encoded);
      }
      writer.u8(0);
    }
  });
}

function statusOption(writer: Writer, code: number | undefined, message: string | undefined | null): void {
  if (code === undefined || code === null) return;
  writer.option(CODE.STATUS_CODE, sub(body => {
    body.u16(code);
    body.raw(new TextEncoder().encode(message ?? ''));
  }));
}

function iaNaBytes(ia: DHCPv6IANA): Uint8Array {
  return sub(body => {
    body.u32(ia.iaid);
    body.u32(ia.t1);
    body.u32(ia.t2);
    for (const address of ia.addresses) {
      body.option(CODE.IA_ADDR, sub(item => {
        item.address(address.address);
        item.u32(address.preferredLifetime);
        item.u32(address.validLifetime);
      }));
    }
    statusOption(body, ia.statusCode, ia.statusMessage);
  });
}

function iaPdBytes(pd: DHCPv6IAPD): Uint8Array {
  return sub(body => {
    body.u32(pd.iaid);
    body.u32(pd.t1);
    body.u32(pd.t2);
    for (const prefix of pd.prefixes) {
      body.option(CODE.IA_PREFIX, sub(item => {
        item.u32(prefix.preferredLifetime);
        item.u32(prefix.validLifetime);
        item.u8(prefix.prefixLength);
        item.address(prefix.prefix);
      }));
    }
    statusOption(body, pd.statusCode, pd.statusMessage);
  });
}

function authenticationBytes(message: DHCPv6Packet): Uint8Array {
  const auth = message.authentication!;
  return sub(body => {
    body.u8(auth.protocol);
    body.u8(auth.algorithm);
    body.u8(auth.rdm);
    body.raw(new Uint8Array(8));
    body.u8(auth.type);
    body.raw(Uint8Array.from((auth.value.match(/../g) ?? []).map(pair => parseInt(pair, 16))));
  });
}

export function encodeDhcpv6(message: DHCPv6Packet): Uint8Array {
  const writer = new Writer();
  const type = MESSAGE_TYPES.indexOf(message.msgType);
  writer.u8(type);
  if (message.msgType === 'RELAY-FORW' || message.msgType === 'RELAY-REPL') {
    writer.u8(message.hopCount);
    writer.address(message.linkAddress);
    writer.address(message.peerAddress);
    if (message.interfaceId !== null) writer.option(CODE.INTERFACE_ID, new TextEncoder().encode(message.interfaceId));
    if (message.relayedMessage) writer.option(CODE.RELAY_MESSAGE, encodeDhcpv6(message.relayedMessage));
    return writer.result();
  }
  writer.u8(message.transactionId >>> 16);
  writer.u16(message.transactionId & 0xffff);
  if (message.clientDuid !== null) writer.option(CODE.CLIENT_ID, duidToBytes(message.clientDuid));
  if (message.serverDuid !== null) writer.option(CODE.SERVER_ID, duidToBytes(message.serverDuid));
  if (message.optionRequest !== null) {
    writer.option(CODE.ORO, sub(body => { for (const code of message.optionRequest!) body.u16(code); }));
  }
  if (message.preference !== null) writer.option(CODE.PREFERENCE, [message.preference]);
  if (message.elapsedTime > 0) writer.option(CODE.ELAPSED_TIME, sub(body => body.u16(message.elapsedTime)));
  for (const ia of message.ias) writer.option(CODE.IA_NA, iaNaBytes(ia));
  for (const pd of message.prefixDelegations) writer.option(CODE.IA_PD, iaPdBytes(pd));
  if (message.rapidCommit) writer.option(CODE.RAPID_COMMIT, []);
  if (message.reconfigureAccept) writer.option(CODE.RECONF_ACCEPT, []);
  if (message.reconfigureMessage) writer.option(CODE.RECONF_MSG, [RECONFIGURE_TYPES[message.reconfigureMessage]]);
  if (message.authentication) writer.option(CODE.AUTH, authenticationBytes(message));
  if (message.serverUnicast) writer.option(CODE.UNICAST, sub(body => body.address(message.serverUnicast!)));
  statusOption(writer, message.statusCode ?? undefined, message.statusMessage);
  if (message.dnsServers.length > 0) {
    writer.option(CODE.DNS_SERVERS, sub(body => { for (const server of message.dnsServers) body.address(server); }));
  }
  if (message.domainList.length > 0) writer.option(CODE.DOMAIN_LIST, domainBytes(message.domainList));
  if (message.informationRefreshTime !== null) {
    writer.option(CODE.INFORMATION_REFRESH_TIME, sub(body => body.u32(message.informationRefreshTime!)));
  }
  return writer.result();
}

class Reader {
  offset = 0;
  constructor(private readonly data: Uint8Array) {}
  get remaining(): number { return this.data.length - this.offset; }
  u8(): number { return this.data[this.offset++]; }
  u16(): number { return (this.u8() << 8) | this.u8(); }
  u32(): number { return ((this.u16() << 16) | this.u16()) >>> 0; }
  take(length: number): Uint8Array {
    const chunk = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return chunk;
  }
  address(): string {
    const hextets: number[] = [];
    for (let i = 0; i < 8; i++) hextets.push(this.u16());
    return new IPv6Address(hextets).toString();
  }
}

function options(data: Uint8Array): Array<{ code: number; body: Uint8Array }> {
  const reader = new Reader(data);
  const found: Array<{ code: number; body: Uint8Array }> = [];
  while (reader.remaining >= 4) {
    const code = reader.u16();
    const length = reader.u16();
    if (length > reader.remaining) throw new Error('truncated DHCPv6 option');
    found.push({ code, body: reader.take(length) });
  }
  if (reader.remaining !== 0) throw new Error('trailing bytes after DHCPv6 options');
  return found;
}

function decodeStatus(body: Uint8Array): { code: number; message: string } {
  return { code: (body[0] << 8) | body[1], message: new TextDecoder().decode(body.subarray(2)) };
}

function decodeDomains(body: Uint8Array): string[] {
  const names: string[] = [];
  let labels: string[] = [];
  for (let i = 0; i < body.length;) {
    const length = body[i++];
    if (length === 0) { names.push(labels.join('.')); labels = []; continue; }
    labels.push(new TextDecoder().decode(body.subarray(i, i + length)));
    i += length;
  }
  return names;
}

export function decodeDhcpv6(data: Uint8Array): DHCPv6Packet {
  const reader = new Reader(data);
  const typeCode = reader.u8();
  const msgType = MESSAGE_TYPES[typeCode];
  if (!msgType) throw new Error(`unknown DHCPv6 message type ${typeCode}`);
  const message = new DHCPv6Packet();
  message.msgType = msgType;
  if (msgType === 'RELAY-FORW' || msgType === 'RELAY-REPL') {
    message.hopCount = reader.u8();
    message.linkAddress = reader.address();
    message.peerAddress = reader.address();
    for (const option of options(reader.take(reader.remaining))) {
      if (option.code === CODE.INTERFACE_ID) message.interfaceId = new TextDecoder().decode(option.body);
      if (option.code === CODE.RELAY_MESSAGE) message.relayedMessage = decodeDhcpv6(option.body);
    }
    return message;
  }
  message.transactionId = (reader.u8() << 16) | reader.u16();
  for (const option of options(reader.take(reader.remaining))) {
    const body = new Reader(option.body);
    switch (option.code) {
      case CODE.CLIENT_ID: message.clientDuid = bytesToDuid(option.body); break;
      case CODE.SERVER_ID: message.serverDuid = bytesToDuid(option.body); break;
      case CODE.ORO: {
        message.optionRequest = [];
        while (body.remaining >= 2) message.optionRequest.push(body.u16());
        break;
      }
      case CODE.PREFERENCE: message.preference = option.body[0]; break;
      case CODE.ELAPSED_TIME: message.elapsedTime = body.u16(); break;
      case CODE.IA_NA: {
        const ia: DHCPv6IANA = { iaid: body.u32(), t1: body.u32(), t2: body.u32(), addresses: [] };
        for (const inner of options(body.take(body.remaining))) {
          if (inner.code === CODE.IA_ADDR) {
            const item = new Reader(inner.body);
            ia.addresses.push({ address: item.address(), preferredLifetime: item.u32(), validLifetime: item.u32() });
          }
          if (inner.code === CODE.STATUS_CODE) {
            const status = decodeStatus(inner.body);
            ia.statusCode = status.code;
            ia.statusMessage = status.message;
          }
        }
        message.ias.push(ia);
        break;
      }
      case CODE.IA_PD: {
        const pd: DHCPv6IAPD = { iaid: body.u32(), t1: body.u32(), t2: body.u32(), prefixes: [] };
        for (const inner of options(body.take(body.remaining))) {
          if (inner.code === CODE.IA_PREFIX) {
            const item = new Reader(inner.body);
            const preferredLifetime = item.u32();
            const validLifetime = item.u32();
            const prefixLength = item.u8();
            pd.prefixes.push({ prefixLength, prefix: item.address(), preferredLifetime, validLifetime });
          }
          if (inner.code === CODE.STATUS_CODE) {
            const status = decodeStatus(inner.body);
            pd.statusCode = status.code;
            pd.statusMessage = status.message;
          }
        }
        message.prefixDelegations.push(pd);
        break;
      }
      case CODE.RAPID_COMMIT: message.rapidCommit = true; break;
      case CODE.RECONF_ACCEPT: message.reconfigureAccept = true; break;
      case CODE.RECONF_MSG: {
        const entry = Object.entries(RECONFIGURE_TYPES).find(([, code]) => code === option.body[0]);
        message.reconfigureMessage = (entry?.[0] as DHCPv6Packet['reconfigureMessage']) ?? null;
        break;
      }
      case CODE.AUTH: {
        const protocol = body.u8();
        const algorithm = body.u8();
        const rdm = body.u8();
        body.take(8);
        const type = body.u8();
        const value = [...body.take(body.remaining)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (protocol === 3 && algorithm === 1 && rdm === 0 && (type === 1 || type === 2)) {
          message.authentication = { protocol, algorithm, rdm, type, value };
        }
        break;
      }
      case CODE.UNICAST: message.serverUnicast = body.address(); break;
      case CODE.STATUS_CODE: {
        const status = decodeStatus(option.body);
        message.statusCode = status.code;
        message.statusMessage = status.message;
        break;
      }
      case CODE.DNS_SERVERS: while (body.remaining >= 16) message.dnsServers.push(body.address()); break;
      case CODE.DOMAIN_LIST: message.domainList = decodeDomains(option.body); break;
      case CODE.INFORMATION_REFRESH_TIME: message.informationRefreshTime = body.u32(); break;
      default: break;
    }
  }
  return message;
}

export const DHCPV6_OPTION_CODES = CODE;

export function dhcpv6WireLength(message: DHCPv6Packet): number {
  return encodeDhcpv6(message).length;
}
