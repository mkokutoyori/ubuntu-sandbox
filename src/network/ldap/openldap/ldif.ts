export const LdifPut = {
  NOVALUE: 0x00,
  VALUE: 0x01,
  TEXT: 0x02,
  BINARY: 0x03,
  B64: 0x04,
  COMMENT: 0x05,
  URL: 0x06,
  SEP: 0x07,
} as const;

export type LdifPutType = typeof LdifPut[keyof typeof LdifPut];

export const LDIF_LINE_WIDTH = 78;
export const LDIF_LINE_WIDTH_MAX = Number.POSITIVE_INFINITY;

const NIB2B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const MUST_B64_ATTRIBUTES: readonly { readonly name: string; readonly oid: string }[] = [
  { name: 'userPassword', oid: '2.5.4.35' },
];

function isGraph(byte: number): boolean {
  return byte > 0x20 && byte < 0x7f;
}

function isPrint(byte: number): boolean {
  return byte >= 0x20 && byte < 0x7f;
}

function isAscii(byte: number): boolean {
  return byte < 0x80;
}

function mustBase64Encode(name: string): boolean {
  const lower = name.toLowerCase();
  return MUST_B64_ATTRIBUTES.some(entry => entry.name.toLowerCase() === lower || entry.oid === name);
}

export function ldifIsNotPrintable(value: Uint8Array | null): number {
  if (value === null || value.length === 0) return -1;
  if (isGraph(value[0]) && value[0] !== 0x3a && value[0] !== 0x3c && isGraph(value[value.length - 1])) {
    for (let i = 0; i < value.length && value[i] !== 0; i++) {
      if (!isAscii(value[i]) || !isPrint(value[i])) return 1;
    }
    return 0;
  }
  return 1;
}

function utf8Of(binary: string): string {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
  return new TextDecoder().decode(bytes);
}

export function ldifPut(
  type: LdifPutType, name: string | null, value: Uint8Array | null, wrapIn = 0,
): string {
  return utf8Of(ldifPutBinary(type, name, value, wrapIn));
}

function ldifPutBinary(
  type: LdifPutType, name: string | null, value: Uint8Array | null, wrapIn: number,
): string {
  const wrap = wrapIn === 0 ? LDIF_LINE_WIDTH : wrapIn;
  const val = value ?? new Uint8Array(0);
  const vlen = val.length;
  const out: string[] = [];
  let len = 0;

  switch (type) {
    case LdifPut.COMMENT:
      out.push('#');
      len++;
      if (vlen > 0) { out.push(' '); len++; }
      break;
    case LdifPut.SEP:
      return '\n';
  }

  if (name !== null) {
    out.push(name);
    len += name.length;
    if (type !== LdifPut.COMMENT) { out.push(':'); len++; }
  }

  if (vlen === 0) return `${out.join('')}\n`;

  switch (type) {
    case LdifPut.NOVALUE:
      return `${out.join('')}\n`;
    case LdifPut.URL:
      out.push('<');
      len++;
      break;
    case LdifPut.B64:
      out.push(':');
      len++;
      break;
  }

  switch (type) {
    case LdifPut.TEXT:
    case LdifPut.URL:
    case LdifPut.B64:
    case LdifPut.COMMENT:
      if (type !== LdifPut.COMMENT) {
        out.push(' ');
        len++;
      }
      for (let i = 0; i < vlen; i++) {
        if (len > wrap) { out.push('\n', ' '); len = 1; }
        out.push(String.fromCharCode(val[i]));
        len++;
      }
      out.push('\n');
      return out.join('');
  }

  const saveLength = out.length;
  const saveLen = len;
  out.push(' ');
  len++;

  if (
    type === LdifPut.VALUE
    && isGraph(val[0]) && val[0] !== 0x3a && val[0] !== 0x3c
    && isGraph(val[vlen - 1])
    && !(name ?? '').includes(';binary')
    && !mustBase64Encode(name ?? '')
  ) {
    let needsBase64 = false;
    for (let i = 0; i < vlen; i++, len++) {
      if (!isAscii(val[i]) || !isPrint(val[i])) { needsBase64 = true; break; }
      if (len >= wrap) { out.push('\n', ' '); len = 1; }
      out.push(String.fromCharCode(val[i]));
    }
    if (!needsBase64) {
      out.push('\n');
      return out.join('');
    }
  }

  out.length = saveLength;
  out.push(':', ' ');
  len = saveLen + 2;

  let at = 0;
  for (; at < vlen - 2; at += 3) {
    let bits = ((val[at] & 0xff) << 16) | ((val[at + 1] & 0xff) << 8) | (val[at + 2] & 0xff);
    for (let i = 0; i < 4; i++, len++, bits <<= 6) {
      if (len >= wrap) { out.push('\n', ' '); len = 1; }
      out.push(NIB2B64[(bits & 0xfc0000) >> 18]);
    }
  }

  if (at < vlen) {
    const rest = [0, 0, 0];
    let filled = 0;
    for (; at + filled < vlen; filled++) rest[filled] = val[at + filled];
    const pad = 3 - filled;
    let bits = ((rest[0] & 0xff) << 16) | ((rest[1] & 0xff) << 8) | (rest[2] & 0xff);
    for (let i = 0; i < 4; i++, len++, bits <<= 6) {
      if (len >= wrap) { out.push('\n', ' '); len = 1; }
      out.push(i + pad < 4 ? NIB2B64[(bits & 0xfc0000) >> 18] : '=');
    }
  }
  out.push('\n');
  return out.join('');
}

export function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
