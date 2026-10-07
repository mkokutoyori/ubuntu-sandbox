import {
  der, children, DerError, expectTag, oidValue, stringValue, TAG, type DerNode,
} from './Asn1';

interface AttributeType {
  readonly short: string;
  readonly oid: string;
  readonly string: 'utf8' | 'printable' | 'ia5';
}

const ATTRIBUTE_TYPES: readonly AttributeType[] = [
  { short: 'CN', oid: '2.5.4.3', string: 'utf8' },
  { short: 'SN', oid: '2.5.4.4', string: 'utf8' },
  { short: 'serialNumber', oid: '2.5.4.5', string: 'printable' },
  { short: 'C', oid: '2.5.4.6', string: 'printable' },
  { short: 'L', oid: '2.5.4.7', string: 'utf8' },
  { short: 'ST', oid: '2.5.4.8', string: 'utf8' },
  { short: 'street', oid: '2.5.4.9', string: 'utf8' },
  { short: 'O', oid: '2.5.4.10', string: 'utf8' },
  { short: 'OU', oid: '2.5.4.11', string: 'utf8' },
  { short: 'title', oid: '2.5.4.12', string: 'utf8' },
  { short: 'GN', oid: '2.5.4.42', string: 'utf8' },
  { short: 'DC', oid: '0.9.2342.19200300.100.1.25', string: 'ia5' },
  { short: 'UID', oid: '0.9.2342.19200300.100.1.1', string: 'utf8' },
  { short: 'emailAddress', oid: '1.2.840.113549.1.9.1', string: 'ia5' },
];

export interface NameAttribute {
  readonly type: string;
  readonly value: string;
}

function attributeByName(name: string): AttributeType | undefined {
  const lowered = name.toLowerCase();
  return ATTRIBUTE_TYPES.find((a) => a.short.toLowerCase() === lowered || a.oid === name);
}

export function splitDistinguishedName(text: string): NameAttribute[] {
  const attributes: NameAttribute[] = [];
  const source = text.startsWith('/') ? text.slice(1).split('/').join('\u0000') : text;
  const separator = text.startsWith('/') ? '\u0000' : ',';
  let current = '';
  const flush = (): void => {
    const piece = current.trim();
    current = '';
    if (piece === '') return;
    const eq = piece.indexOf('=');
    if (eq <= 0) throw new DerError(`invalid distinguished name component "${piece}"`);
    attributes.push({ type: piece.slice(0, eq).trim(), value: piece.slice(eq + 1).trim() });
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\' && i + 1 < source.length) { current += source[++i]; continue; }
    if (ch === separator) { flush(); continue; }
    current += ch;
  }
  flush();
  return attributes;
}

export function canonicalDistinguishedName(text: string): string {
  return renderDistinguishedName(splitDistinguishedName(text));
}

export function renderDistinguishedName(attributes: readonly NameAttribute[]): string {
  return attributes
    .map(({ type, value }) => `${attributeByName(type)?.short ?? type}=${value.replace(/([,\\])/g, '\\$1')}`)
    .join(',');
}

function encodeValue(kind: AttributeType['string'], value: string): Uint8Array {
  if (kind === 'ia5') return der.ia5String(value);
  if (kind === 'printable' && /^[A-Za-z0-9 '()+,\-./:=?]*$/.test(value)) return der.printableString(value);
  return der.utf8String(value);
}

export function encodeName(text: string): Uint8Array {
  const rdns = splitDistinguishedName(text).map(({ type, value }) => {
    const known = attributeByName(type);
    if (!known && !/^\d+(\.\d+)+$/.test(type)) throw new DerError(`unknown attribute type ${type}`);
    return der.set(der.sequence(der.oid(known?.oid ?? type), encodeValue(known?.string ?? 'utf8', value)));
  });
  return der.sequence(...rdns);
}

export function decodeName(node: DerNode): string {
  expectTag(node, TAG.SEQUENCE, 'Name');
  const attributes: NameAttribute[] = [];
  for (const rdn of children(node)) {
    expectTag(rdn, TAG.SET, 'RelativeDistinguishedName');
    for (const pair of children(rdn)) {
      const [oid, value] = children(pair);
      const dotted = oidValue(oid);
      attributes.push({ type: ATTRIBUTE_TYPES.find((a) => a.oid === dotted)?.short ?? dotted, value: stringValue(value) });
    }
  }
  return renderDistinguishedName(attributes);
}

export function opensslDistinguishedName(text: string): string {
  return splitDistinguishedName(text).map(({ type, value }) => `${type} = ${value}`).join(', ');
}

export function curlDistinguishedName(text: string): string {
  return splitDistinguishedName(text).map(({ type, value }) => `${type}=${value}`).join('; ');
}

export function slashDistinguishedName(text: string): string {
  return `/${splitDistinguishedName(text).map(({ type, value }) => `${type}=${value}`).join('/')}`;
}
