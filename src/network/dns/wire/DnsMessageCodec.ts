import { IPAddress, IPv6Address } from '@/network/core/types';
import { encodeDnsHeaderFlags, decodeDnsHeaderFlags } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { packOptTtl, unpackOptTtl } from '@/network/dns/wire/EdnsOptRecord';
import type { DnsMessage, DnsQuestion } from '@/network/dns/wire/DnsMessage';
import type {
  ResourceRecord, ResourceRecordData, OptRecordData,
  ARecordData, AaaaRecordData, NsRecordData, CnameRecordData, PtrRecordData,
  SoaRecordData, MxRecordData, TxtRecordData, SrvRecordData,
  DnskeyRecordData, RrsigRecordData, DsRecordData, NsecRecordData,
} from '@/network/dns/wire/ResourceRecord';

export class DnsMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DnsMessageError';
  }
}

const HEADER_LENGTH = 12;
const MAX_LABEL_OCTETS = 63;
const MAX_POINTER_OFFSET = 0x3fff;
const POINTER_MARKER = 0xc0;
const MAX_POINTER_HOPS = 128;

function writeUint16(out: number[], value: number): void {
  out.push((value >> 8) & 0xff, value & 0xff);
}

function writeUint32(out: number[], value: number): void {
  out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function nameLabels(name: string): string[] {
  if (name === '' || name === '.') return [];
  const labels = name.split('.');
  return labels[labels.length - 1] === '' ? labels.slice(0, -1) : labels;
}

function encodeName(name: string, out: number[], compressionMap: Map<string, number>): void {
  const labels = nameLabels(name);

  const writeFrom = (index: number): void => {
    if (index >= labels.length) {
      out.push(0x00);
      return;
    }

    const suffix = labels.slice(index).join('.').toLowerCase();
    const pointer = compressionMap.get(suffix);
    if (pointer !== undefined) {
      out.push(POINTER_MARKER | (pointer >> 8), pointer & 0xff);
      return;
    }

    if (out.length <= MAX_POINTER_OFFSET) {
      compressionMap.set(suffix, out.length);
    }

    const label = labels[index];
    out.push(label.length);
    for (let i = 0; i < label.length; i++) {
      out.push(label.charCodeAt(i) & 0xff);
    }
    writeFrom(index + 1);
  };

  writeFrom(0);
}

function encodeQuestion(question: DnsQuestion, out: number[], compressionMap: Map<string, number>): void {
  encodeName(question.qname, out, compressionMap);
  writeUint16(out, question.qtype);
  writeUint16(out, question.qclass);
}

function writeText(out: number[], text: string): void {
  for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i) & 0xff);
}

function encodeTypeBitmaps(types: readonly number[], out: number[]): void {
  const windows = new Map<number, number[]>();
  for (const type of types) {
    const window = type >> 8;
    const bit = type & 0xff;
    const bytes = windows.get(window) ?? [];
    const byteIndex = bit >> 3;
    while (bytes.length <= byteIndex) bytes.push(0);
    bytes[byteIndex] |= 0x80 >> (bit & 7);
    windows.set(window, bytes);
  }
  for (const window of [...windows.keys()].sort((a, b) => a - b)) {
    const bytes = windows.get(window)!;
    out.push(window, bytes.length, ...bytes);
  }
}

function encodeRData(data: ResourceRecordData, out: number[], compressionMap: Map<string, number>): void {
  switch (data.type) {
    case RRType.A:
      for (const octet of data.address.getOctets()) out.push(octet);
      return;
    case RRType.AAAA:
      for (const hextet of data.address.getHextets()) writeUint16(out, hextet);
      return;
    case RRType.NS:
      encodeName(data.nsdname, out, compressionMap);
      return;
    case RRType.CNAME:
      encodeName(data.cname, out, compressionMap);
      return;
    case RRType.PTR:
      encodeName(data.ptrdname, out, compressionMap);
      return;
    case RRType.SOA:
      encodeName(data.mname, out, compressionMap);
      encodeName(data.rname, out, compressionMap);
      writeUint32(out, data.serial);
      writeUint32(out, data.refresh);
      writeUint32(out, data.retry);
      writeUint32(out, data.expire);
      writeUint32(out, data.minimum);
      return;
    case RRType.MX:
      writeUint16(out, data.preference);
      encodeName(data.exchange, out, compressionMap);
      return;
    case RRType.TXT:
      for (const segment of data.text) {
        out.push(segment.length);
        for (let i = 0; i < segment.length; i++) out.push(segment.charCodeAt(i) & 0xff);
      }
      return;
    case RRType.SRV:
      writeUint16(out, data.priority);
      writeUint16(out, data.weight);
      writeUint16(out, data.port);
      encodeName(data.target, out, compressionMap);
      return;
    case RRType.DNSKEY:
      writeUint16(out, data.flags);
      out.push(data.protocol & 0xff, data.algorithm & 0xff);
      writeText(out, data.publicKey);
      return;
    case RRType.RRSIG:
      writeUint16(out, data.typeCovered);
      out.push(data.algorithm & 0xff, data.labels & 0xff);
      writeUint32(out, data.originalTtl);
      writeUint32(out, data.expiration);
      writeUint32(out, data.inception);
      writeUint16(out, data.keyTag);
      encodeName(data.signerName, out, new Map());
      writeText(out, data.signature);
      return;
    case RRType.DS:
      writeUint16(out, data.keyTag);
      out.push(data.algorithm & 0xff, data.digestType & 0xff);
      writeText(out, data.digest);
      return;
    case RRType.NSEC:
      encodeName(data.nextDomainName, out, new Map());
      encodeTypeBitmaps(data.types, out);
      return;
    case RRType.OPT:
      return;
    default:
      throw new DnsMessageError(`cannot encode RDATA for unsupported record type ${(data as { type: number }).type}`);
  }
}

function encodeOptRecord(data: OptRecordData, out: number[]): void {
  out.push(0x00);
  writeUint16(out, RRType.OPT);
  writeUint16(out, data.udpPayloadSize);
  writeUint32(out, packOptTtl(data));
  writeUint16(out, 0);
}

function encodeResourceRecord(
  rr: ResourceRecord<ResourceRecordData>, out: number[], compressionMap: Map<string, number>,
): void {
  if (rr.data.type === RRType.OPT) {
    encodeOptRecord(rr.data as OptRecordData, out);
    return;
  }

  encodeName(rr.name, out, compressionMap);
  writeUint16(out, rr.data.type);
  writeUint16(out, rr.rrClass);
  writeUint32(out, rr.ttl);

  const rdlengthPos = out.length;
  writeUint16(out, 0);
  const rdataStart = out.length;
  encodeRData(rr.data, out, compressionMap);
  const rdlength = out.length - rdataStart;
  out[rdlengthPos] = (rdlength >> 8) & 0xff;
  out[rdlengthPos + 1] = rdlength & 0xff;
}

export function encodeDnsMessage(message: DnsMessage): Uint8Array {
  const out: number[] = [];
  const compressionMap = new Map<string, number>();

  writeUint16(out, message.id);
  writeUint16(out, encodeDnsHeaderFlags(message.flags));
  writeUint16(out, message.questions.length);
  writeUint16(out, message.answers.length);
  writeUint16(out, message.authorities.length);
  writeUint16(out, message.additionals.length);

  for (const question of message.questions) encodeQuestion(question, out, compressionMap);
  for (const rr of message.answers) encodeResourceRecord(rr, out, compressionMap);
  for (const rr of message.authorities) encodeResourceRecord(rr, out, compressionMap);
  for (const rr of message.additionals) encodeResourceRecord(rr, out, compressionMap);

  return Uint8Array.from(out);
}

class Cursor {
  constructor(readonly view: Uint8Array, public pos: number = 0) {}

  readUint8(): number {
    this.assertAvailable(1);
    return this.view[this.pos++];
  }

  readUint16(): number {
    this.assertAvailable(2);
    const value = (this.view[this.pos] << 8) | this.view[this.pos + 1];
    this.pos += 2;
    return value;
  }

  readUint32(): number {
    this.assertAvailable(4);
    const value = (
      (this.view[this.pos] << 24) | (this.view[this.pos + 1] << 16) |
      (this.view[this.pos + 2] << 8) | this.view[this.pos + 3]
    ) >>> 0;
    this.pos += 4;
    return value;
  }

  assertAvailable(count: number): void {
    if (this.pos + count > this.view.length) {
      throw new DnsMessageError(`truncated DNS message: expected ${count} more byte(s) at offset ${this.pos}`);
    }
  }
}

function decodeName(view: Uint8Array, startOffset: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = startOffset;
  let next = -1;
  let hops = 0;

  for (;;) {
    if (pos >= view.length) {
      throw new DnsMessageError(`truncated DNS message while reading a domain name at offset ${pos}`);
    }
    const len = view[pos];

    if ((len & POINTER_MARKER) === POINTER_MARKER) {
      if (pos + 1 >= view.length) {
        throw new DnsMessageError('truncated compression pointer');
      }
      const pointer = ((len & 0x3f) << 8) | view[pos + 1];
      if (next === -1) next = pos + 2;
      if (pointer >= pos || pointer >= view.length) {
        throw new DnsMessageError(`invalid compression pointer to offset ${pointer}`);
      }
      hops++;
      if (hops > MAX_POINTER_HOPS) {
        throw new DnsMessageError('compression pointer chain too long (possible loop)');
      }
      pos = pointer;
      continue;
    }

    if (len === 0) {
      pos++;
      if (next === -1) next = pos;
      break;
    }

    if (len > MAX_LABEL_OCTETS) {
      throw new DnsMessageError(`label at offset ${pos} exceeds ${MAX_LABEL_OCTETS} octets`);
    }
    pos++;
    if (pos + len > view.length) {
      throw new DnsMessageError(`truncated label at offset ${pos}`);
    }
    let label = '';
    for (let i = 0; i < len; i++) label += String.fromCharCode(view[pos + i]);
    labels.push(label);
    pos += len;
  }

  return { name: labels.join('.'), next };
}

function decodeQuestion(cursor: Cursor): DnsQuestion {
  const { name, next } = decodeName(cursor.view, cursor.pos);
  cursor.pos = next;
  const qtype = cursor.readUint16();
  const qclass = cursor.readUint16();
  return { qname: name, qtype, qclass };
}

function decodeRData(type: number, view: Uint8Array, offset: number, rdlength: number): ResourceRecordData {
  const rdataCursor = new Cursor(view, offset);
  switch (type) {
    case RRType.A: {
      const octets = [rdataCursor.readUint8(), rdataCursor.readUint8(), rdataCursor.readUint8(), rdataCursor.readUint8()];
      return { type: RRType.A, address: new IPAddress(octets) } as ARecordData;
    }
    case RRType.AAAA: {
      const hextets: number[] = [];
      for (let i = 0; i < 8; i++) hextets.push(rdataCursor.readUint16());
      return { type: RRType.AAAA, address: new IPv6Address(hextets) } as AaaaRecordData;
    }
    case RRType.NS:
      return { type: RRType.NS, nsdname: decodeName(view, offset).name } as NsRecordData;
    case RRType.CNAME:
      return { type: RRType.CNAME, cname: decodeName(view, offset).name } as CnameRecordData;
    case RRType.PTR:
      return { type: RRType.PTR, ptrdname: decodeName(view, offset).name } as PtrRecordData;
    case RRType.SOA: {
      const mnameResult = decodeName(view, offset);
      const rnameResult = decodeName(view, mnameResult.next);
      const cursor = new Cursor(view, rnameResult.next);
      return {
        type: RRType.SOA,
        mname: mnameResult.name,
        rname: rnameResult.name,
        serial: cursor.readUint32(),
        refresh: cursor.readUint32(),
        retry: cursor.readUint32(),
        expire: cursor.readUint32(),
        minimum: cursor.readUint32(),
      } as SoaRecordData;
    }
    case RRType.MX: {
      const preference = rdataCursor.readUint16();
      const exchange = decodeName(view, rdataCursor.pos).name;
      return { type: RRType.MX, preference, exchange } as MxRecordData;
    }
    case RRType.TXT: {
      const text: string[] = [];
      const end = offset + rdlength;
      let pos = offset;
      while (pos < end) {
        const len = view[pos];
        pos++;
        let segment = '';
        for (let i = 0; i < len; i++) segment += String.fromCharCode(view[pos + i]);
        pos += len;
        text.push(segment);
      }
      return { type: RRType.TXT, text } as TxtRecordData;
    }
    case RRType.SRV: {
      const priority = rdataCursor.readUint16();
      const weight = rdataCursor.readUint16();
      const port = rdataCursor.readUint16();
      const target = decodeName(view, rdataCursor.pos).name;
      return { type: RRType.SRV, priority, weight, port, target } as SrvRecordData;
    }
    case RRType.DNSKEY: {
      const flags = rdataCursor.readUint16();
      const protocol = rdataCursor.readUint8();
      const algorithm = rdataCursor.readUint8();
      const publicKey = readText(view, rdataCursor.pos, offset + rdlength);
      return { type: RRType.DNSKEY, flags, protocol, algorithm, publicKey } as DnskeyRecordData;
    }
    case RRType.RRSIG: {
      const typeCovered = rdataCursor.readUint16();
      const algorithm = rdataCursor.readUint8();
      const labels = rdataCursor.readUint8();
      const originalTtl = rdataCursor.readUint32();
      const expiration = rdataCursor.readUint32();
      const inception = rdataCursor.readUint32();
      const keyTag = rdataCursor.readUint16();
      const signer = decodeName(view, rdataCursor.pos);
      const signature = readText(view, signer.next, offset + rdlength);
      return {
        type: RRType.RRSIG, typeCovered, algorithm, labels, originalTtl,
        expiration, inception, keyTag, signerName: signer.name, signature,
      } as RrsigRecordData;
    }
    case RRType.DS: {
      const keyTag = rdataCursor.readUint16();
      const algorithm = rdataCursor.readUint8();
      const digestType = rdataCursor.readUint8();
      const digest = readText(view, rdataCursor.pos, offset + rdlength);
      return { type: RRType.DS, keyTag, algorithm, digestType, digest } as DsRecordData;
    }
    case RRType.NSEC: {
      const next = decodeName(view, offset);
      const types = decodeTypeBitmaps(view, next.next, offset + rdlength);
      return { type: RRType.NSEC, nextDomainName: next.name, types } as NsecRecordData;
    }
    default:
      throw new DnsMessageError(`cannot decode RDATA for unsupported record type ${type}`);
  }
}

function readText(view: Uint8Array, start: number, end: number): string {
  let text = '';
  for (let i = start; i < end; i++) text += String.fromCharCode(view[i]);
  return text;
}

function decodeTypeBitmaps(view: Uint8Array, start: number, end: number): number[] {
  const types: number[] = [];
  let pos = start;
  while (pos + 1 < end) {
    const window = view[pos];
    const length = view[pos + 1];
    pos += 2;
    for (let i = 0; i < length && pos + i < end; i++) {
      const byte = view[pos + i];
      for (let bit = 0; bit < 8; bit++) {
        if (byte & (0x80 >> bit)) types.push((window << 8) | (i * 8 + bit));
      }
    }
    pos += length;
  }
  return types;
}

function decodeResourceRecord(cursor: Cursor): ResourceRecord<ResourceRecordData> {
  const { name, next } = decodeName(cursor.view, cursor.pos);
  cursor.pos = next;
  const type = cursor.readUint16();
  const rrClass = cursor.readUint16();
  const ttl = cursor.readUint32();
  const rdlength = cursor.readUint16();
  cursor.assertAvailable(rdlength);

  if (type === RRType.OPT) {
    cursor.pos += rdlength;
    const data: OptRecordData = { type: RRType.OPT, udpPayloadSize: rrClass, ...unpackOptTtl(ttl) };
    return { name, ttl, rrClass, data };
  }

  const data = decodeRData(type, cursor.view, cursor.pos, rdlength);
  cursor.pos += rdlength;
  return { name, ttl, rrClass: rrClass as DnsClass, data };
}

export function decodeDnsMessage(bytes: Uint8Array): DnsMessage {
  if (bytes.length < HEADER_LENGTH) {
    throw new DnsMessageError(`truncated DNS message: header requires ${HEADER_LENGTH} bytes, got ${bytes.length}`);
  }

  const cursor = new Cursor(bytes);
  const id = cursor.readUint16();
  const flags = decodeDnsHeaderFlags(cursor.readUint16());
  const qdcount = cursor.readUint16();
  const ancount = cursor.readUint16();
  const nscount = cursor.readUint16();
  const arcount = cursor.readUint16();

  const questions: DnsQuestion[] = [];
  for (let i = 0; i < qdcount; i++) questions.push(decodeQuestion(cursor));

  const answers: ResourceRecord<ResourceRecordData>[] = [];
  for (let i = 0; i < ancount; i++) answers.push(decodeResourceRecord(cursor));

  const authorities: ResourceRecord<ResourceRecordData>[] = [];
  for (let i = 0; i < nscount; i++) authorities.push(decodeResourceRecord(cursor));

  const additionals: ResourceRecord<ResourceRecordData>[] = [];
  for (let i = 0; i < arcount; i++) additionals.push(decodeResourceRecord(cursor));

  return { id, flags, questions, answers, authorities, additionals };
}
