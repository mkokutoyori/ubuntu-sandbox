import type { PartialAttribute } from './LdapMessage';

const encoder = new TextEncoder();

export function sidToBytes(sid: string): Uint8Array | null {
  const match = /^S-(\d+)-(\d+)((?:-\d+)*)$/i.exec(sid.trim());
  if (match === null) return null;
  const revision = Number.parseInt(match[1], 10);
  const authority = BigInt(match[2]);
  const subAuthorities = match[3] === '' ? [] : match[3].slice(1).split('-').map(part => Number.parseInt(part, 10));
  const bytes = new Uint8Array(8 + subAuthorities.length * 4);
  bytes[0] = revision;
  bytes[1] = subAuthorities.length;
  for (let i = 0; i < 6; i++) bytes[2 + i] = Number((authority >> BigInt(8 * (5 - i))) & 0xffn);
  const view = new DataView(bytes.buffer);
  subAuthorities.forEach((value, index) => view.setUint32(8 + index * 4, value >>> 0, true));
  return bytes;
}

export function bytesToSid(bytes: Uint8Array): string | null {
  if (bytes.length < 8 || bytes.length !== 8 + bytes[1] * 4) return null;
  let authority = 0n;
  for (let i = 0; i < 6; i++) authority = (authority << 8n) | BigInt(bytes[2 + i]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [`S-${bytes[0]}-${authority}`];
  for (let i = 0; i < bytes[1]; i++) parts.push(String(view.getUint32(8 + i * 4, true)));
  return parts.join('-');
}

export function guidToBytes(guid: string): Uint8Array | null {
  const hex = guid.trim().replace(/^\{|\}$/g, '').replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  const bytes = Uint8Array.from(hex.match(/../g) as string[], pair => Number.parseInt(pair, 16));
  const wire = new Uint8Array(16);
  wire.set([bytes[3], bytes[2], bytes[1], bytes[0], bytes[5], bytes[4], bytes[7], bytes[6]], 0);
  wire.set(bytes.slice(8), 8);
  return wire;
}

export function bytesToGuid(wire: Uint8Array): string | null {
  if (wire.length !== 16) return null;
  const order = [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15];
  const hex = order.map(index => wire[index].toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const BINARY_SYNTAXES: Readonly<Record<string, {
  toWire(value: string): Uint8Array | null;
  fromWire(bytes: Uint8Array): string | null;
}>> = {
  objectsid: { toWire: sidToBytes, fromWire: bytesToSid },
  objectguid: { toWire: guidToBytes, fromWire: bytesToGuid },
};

export function attributeToWire(attribute: PartialAttribute): PartialAttribute {
  const syntax = BINARY_SYNTAXES[attribute.type.toLowerCase()];
  if (syntax === undefined || attribute.values.length === 0) return attribute;
  const valueBytes = attribute.values.map(value => syntax.toWire(value) ?? encoder.encode(value));
  return { type: attribute.type, values: attribute.values, valueBytes };
}

export function attributeFromWire(attribute: PartialAttribute): PartialAttribute {
  const syntax = BINARY_SYNTAXES[attribute.type.toLowerCase()];
  if (syntax === undefined || attribute.valueBytes === undefined) return attribute;
  const values = attribute.valueBytes.map((bytes, index) => syntax.fromWire(bytes) ?? attribute.values[index]);
  return { type: attribute.type, values };
}
