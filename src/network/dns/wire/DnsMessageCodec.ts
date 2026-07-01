import { IPAddress, IPv6Address } from '@/network/core/types';
import { encodeDnsHeaderFlags, decodeDnsHeaderFlags } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import type { DnsMessage, DnsQuestion } from '@/network/dns/wire/DnsMessage';
import type {
  ResourceRecord, ResourceRecordData,
  ARecordData, AaaaRecordData, NsRecordData, CnameRecordData, PtrRecordData,
  SoaRecordData, MxRecordData, TxtRecordData, SrvRecordData,
} from '@/network/dns/wire/ResourceRecord';

/** The wire-format bytes of a DNS message are malformed or truncated. */
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

// ─── Encoding ──────────────────────────────────────────────────────────

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

/** Encode a domain name with RFC 1035 §4.1.4 pointer compression. */
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
    default:
      throw new DnsMessageError(`cannot encode RDATA for unsupported record type ${(data as { type: number }).type}`);
  }
}

function encodeResourceRecord(
  rr: ResourceRecord<ResourceRecordData>, out: number[], compressionMap: Map<string, number>,
): void {
  encodeName(rr.name, out, compressionMap);
  writeUint16(out, rr.data.type);
  writeUint16(out, rr.rrClass);
  writeUint32(out, rr.ttl);

  const rdlengthPos = out.length;
  writeUint16(out, 0); // placeholder, patched below
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

// ─── Decoding ──────────────────────────────────────────────────────────

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
    default:
      throw new DnsMessageError(`cannot decode RDATA for unsupported record type ${type}`);
  }
}

function decodeResourceRecord(cursor: Cursor): ResourceRecord<ResourceRecordData> {
  const { name, next } = decodeName(cursor.view, cursor.pos);
  cursor.pos = next;
  const type = cursor.readUint16();
  const rrClass = cursor.readUint16();
  const ttl = cursor.readUint32();
  const rdlength = cursor.readUint16();
  cursor.assertAvailable(rdlength);
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
