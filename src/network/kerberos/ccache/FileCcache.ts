export interface CcachePrincipal {
  readonly nameType: number;
  readonly realm: string;
  readonly components: readonly string[];
}

export interface CcacheAddress {
  readonly type: number;
  readonly data: Uint8Array;
}

export interface CcacheAuthData {
  readonly type: number;
  readonly data: Uint8Array;
}

export interface CcacheCredential {
  readonly client: CcachePrincipal;
  readonly server: CcachePrincipal;
  readonly keyType: number;
  readonly key: Uint8Array;
  readonly authTime: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly renewTill: number;
  readonly isSessionKey: boolean;
  readonly flags: number;
  readonly addresses: readonly CcacheAddress[];
  readonly authData: readonly CcacheAuthData[];
  readonly ticket: Uint8Array;
  readonly secondTicket: Uint8Array;
}

export interface Ccache {
  readonly kdcOffsetSeconds: number;
  readonly kdcOffsetMicroseconds: number;
  readonly defaultPrincipal: CcachePrincipal;
  readonly credentials: readonly CcacheCredential[];
}

const FILE_FORMAT_VERSION = 0x0504;
const KDC_OFFSET_TAG = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class Writer {
  private readonly chunks: number[] = [];

  u8(value: number): void {
    this.chunks.push(value & 0xff);
  }

  u16(value: number): void {
    this.chunks.push((value >> 8) & 0xff, value & 0xff);
  }

  u32(value: number): void {
    this.chunks.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }

  bytes(value: Uint8Array): void {
    for (const byte of value) this.chunks.push(byte);
  }

  data(value: Uint8Array): void {
    this.u32(value.length);
    this.bytes(value);
  }

  principal(value: CcachePrincipal): void {
    this.u32(value.nameType);
    this.u32(value.components.length);
    this.data(encoder.encode(value.realm));
    for (const component of value.components) this.data(encoder.encode(component));
  }

  result(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

class Reader {
  private offset = 0;

  constructor(private readonly input: Uint8Array) {}

  get remaining(): number {
    return this.input.length - this.offset;
  }

  private need(length: number): void {
    if (length < 0 || this.remaining < length) throw new Error('truncated credential cache');
  }

  u8(): number {
    this.need(1);
    return this.input[this.offset++];
  }

  u16(): number {
    this.need(2);
    const value = (this.input[this.offset] << 8) | this.input[this.offset + 1];
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.need(4);
    const value = ((this.input[this.offset] << 24) | (this.input[this.offset + 1] << 16)
      | (this.input[this.offset + 2] << 8) | this.input[this.offset + 3]) >>> 0;
    this.offset += 4;
    return value;
  }

  bytes(length: number): Uint8Array {
    this.need(length);
    const value = this.input.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  data(): Uint8Array {
    return this.bytes(this.u32());
  }

  principal(): CcachePrincipal {
    const nameType = this.u32();
    const count = this.u32();
    const realm = decoder.decode(this.data());
    const components: string[] = [];
    for (let index = 0; index < count; index++) components.push(decoder.decode(this.data()));
    return { nameType, realm, components };
  }
}

export function encodeCcache(cache: Ccache): Uint8Array {
  const writer = new Writer();
  writer.u16(FILE_FORMAT_VERSION);
  writer.u16(12);
  writer.u16(KDC_OFFSET_TAG);
  writer.u16(8);
  writer.u32(cache.kdcOffsetSeconds >>> 0);
  writer.u32(cache.kdcOffsetMicroseconds >>> 0);
  writer.principal(cache.defaultPrincipal);
  for (const credential of cache.credentials) {
    writer.principal(credential.client);
    writer.principal(credential.server);
    writer.u16(credential.keyType);
    writer.data(credential.key);
    writer.u32(credential.authTime);
    writer.u32(credential.startTime);
    writer.u32(credential.endTime);
    writer.u32(credential.renewTill);
    writer.u8(credential.isSessionKey ? 1 : 0);
    writer.u32(credential.flags);
    writer.u32(credential.addresses.length);
    for (const address of credential.addresses) {
      writer.u16(address.type);
      writer.data(address.data);
    }
    writer.u32(credential.authData.length);
    for (const item of credential.authData) {
      writer.u16(item.type);
      writer.data(item.data);
    }
    writer.data(credential.ticket);
    writer.data(credential.secondTicket);
  }
  return writer.result();
}

export function decodeCcache(bytes: Uint8Array): Ccache | null {
  try {
    const reader = new Reader(bytes);
    if (reader.u16() !== FILE_FORMAT_VERSION) return null;
    let headerLength = reader.u16();
    let kdcOffsetSeconds = 0;
    let kdcOffsetMicroseconds = 0;
    while (headerLength > 0) {
      const tag = reader.u16();
      const length = reader.u16();
      const value = reader.bytes(length);
      if (tag === KDC_OFFSET_TAG && length === 8) {
        const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
        kdcOffsetSeconds = view.getInt32(0);
        kdcOffsetMicroseconds = view.getInt32(4);
      }
      headerLength -= 4 + length;
    }
    const defaultPrincipal = reader.principal();
    const credentials: CcacheCredential[] = [];
    while (reader.remaining > 0) {
      const client = reader.principal();
      const server = reader.principal();
      const keyType = reader.u16();
      const key = reader.data();
      const authTime = reader.u32();
      const startTime = reader.u32();
      const endTime = reader.u32();
      const renewTill = reader.u32();
      const isSessionKey = reader.u8() !== 0;
      const flags = reader.u32();
      const addresses: CcacheAddress[] = [];
      for (let count = reader.u32(); count > 0; count--) addresses.push({ type: reader.u16(), data: reader.data() });
      const authData: CcacheAuthData[] = [];
      for (let count = reader.u32(); count > 0; count--) authData.push({ type: reader.u16(), data: reader.data() });
      const ticket = reader.data();
      const secondTicket = reader.data();
      credentials.push({
        client, server, keyType, key, authTime, startTime, endTime, renewTill, isSessionKey, flags,
        addresses, authData, ticket, secondTicket,
      });
    }
    return { kdcOffsetSeconds, kdcOffsetMicroseconds, defaultPrincipal, credentials };
  } catch {
    return null;
  }
}
