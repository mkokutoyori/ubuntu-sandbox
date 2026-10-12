const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function b64DecodeLength(encodedLength: number): number {
  return Math.floor(encodedLength / 4) * 3;
}

export function b64Ntop(source: Uint8Array): string {
  let out = '';
  let at = 0;
  for (; source.length - at > 2; at += 3) {
    out += ALPHABET[source[at] >> 2];
    out += ALPHABET[((source[at] & 0x03) << 4) + (source[at + 1] >> 4)];
    out += ALPHABET[((source[at + 1] & 0x0f) << 2) + (source[at + 2] >> 6)];
    out += ALPHABET[source[at + 2] & 0x3f];
  }
  const left = source.length - at;
  if (left > 0) {
    const input = [source[at], left > 1 ? source[at + 1] : 0, 0];
    out += ALPHABET[input[0] >> 2];
    out += ALPHABET[((input[0] & 0x03) << 4) + (input[1] >> 4)];
    out += left === 1 ? '=' : ALPHABET[(input[1] & 0x0f) << 2];
    out += '=';
  }
  return out;
}

function isAsciiSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';
}

export function b64Pton(source: string, targetSize: number): Uint8Array | null {
  const target = new Uint8Array(targetSize + 1);
  let tarIndex = 0;
  let state = 0;
  let at = 0;
  let ch = '';
  while (at < source.length) {
    ch = source[at++];
    if (isAsciiSpace(ch)) continue;
    if (ch === '=') break;
    const pos = ALPHABET.indexOf(ch);
    if (pos < 0) return null;
    switch (state) {
      case 0:
        if (tarIndex >= targetSize) return null;
        target[tarIndex] = pos << 2;
        state = 1;
        break;
      case 1:
        if (tarIndex + 1 >= targetSize) return null;
        target[tarIndex] |= pos >> 4;
        target[tarIndex + 1] = (pos & 0x0f) << 4;
        tarIndex++;
        state = 2;
        break;
      case 2:
        if (tarIndex + 1 >= targetSize) return null;
        target[tarIndex] |= pos >> 2;
        target[tarIndex + 1] = (pos & 0x03) << 6;
        tarIndex++;
        state = 3;
        break;
      default:
        if (tarIndex >= targetSize) return null;
        target[tarIndex] |= pos;
        tarIndex++;
        state = 0;
    }
    ch = '';
  }
  if (ch === '=') {
    let next = at < source.length ? source[at++] : '';
    switch (state) {
      case 0:
      case 1:
        return null;
      case 2: {
        while (next !== '' && isAsciiSpace(next)) next = at < source.length ? source[at++] : '';
        if (next !== '=') return null;
        next = at < source.length ? source[at++] : '';
        for (; next !== ''; next = at < source.length ? source[at++] : '') if (!isAsciiSpace(next)) return null;
        if (target[tarIndex] !== 0) return null;
        break;
      }
      default:
        for (; next !== ''; next = at < source.length ? source[at++] : '') if (!isAsciiSpace(next)) return null;
        if (target[tarIndex] !== 0) return null;
    }
  } else if (state !== 0) {
    return null;
  }
  return target.slice(0, tarIndex);
}

const LDAP_NIBBLE_INVALID = 0xff;

function ldapNibble(code: number): number {
  const index = ALPHABET.indexOf(String.fromCharCode(code));
  return index < 0 ? LDAP_NIBBLE_INVALID : index;
}

function signedByte(value: number): number {
  return (value << 24) >> 24;
}

export function ldapDecodeB64Inplace(text: string): Uint8Array | null {
  const input = new TextEncoder().encode(text);
  const at = (index: number): number => (index < input.length ? input[index] : 0);
  const EQUALS = 0x3d;
  const out: number[] = [];
  for (let p = 0; p < input.length; p += 4) {
    for (let i = 0; i < 4; i++) {
      const code = at(p + i);
      if (code !== EQUALS && ((code & 0x80) !== 0 || ldapNibble(code & 0x7f) > 0x3f)) return null;
    }
    const nibble = (index: number): number => signedByte(at(index) === EQUALS ? LDAP_NIBBLE_INVALID : ldapNibble(at(index) & 0x7f));
    const first = nibble(p);
    const second = nibble(p + 1);
    out.push(((first << 2) | (second >> 4)) & 0xff);
    if (at(p + 2) === EQUALS) break;
    const third = nibble(p + 2);
    out.push((((second & 0x0f) << 4) | (third >> 2)) & 0xff);
    if (at(p + 3) === EQUALS) break;
    const fourth = nibble(p + 3);
    out.push((((third & 0x03) << 6) | fourth) & 0xff);
  }
  return Uint8Array.from(out);
}
