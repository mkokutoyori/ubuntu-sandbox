import { aesSivDecrypt, aesSivEncrypt, AES_SIV_TAG_SIZE } from '@/crypto/cipher';

export const NTP_HEADER_LENGTH = 48;
export const NTP_MIN_EF_LENGTH = 16;
export const NTP_MAX_V4_MAC_LENGTH = 68;
export const NTS_MIN_UNIQ_ID_LENGTH = 32;
export const NTS_MIN_UNPADDED_NONCE_LENGTH = 16;
export const NTS_MAX_COOKIES = 8;
export const NTS_MAX_TOTAL_COOKIE_LENGTH = 8 * 108;
export const NTS_KOD_NAK = 'NTSN';

export const EF = {
  UNIQUE_IDENTIFIER: 0x0104,
  COOKIE: 0x0204,
  COOKIE_PLACEHOLDER: 0x0304,
  AUTH_AND_EEF: 0x0404,
} as const;

export interface ExtensionField {
  readonly type: number;
  readonly start: number;
  readonly length: number;
  readonly body: Uint8Array;
}

const pad4 = (length: number): number => (length % 4 === 0 ? 0 : 4 - (length % 4));

export function encodeField(type: number, body: Uint8Array): Uint8Array {
  const length = Math.max(NTP_MIN_EF_LENGTH, 4 + body.length + pad4(body.length));
  const out = new Uint8Array(length);
  out[0] = (type >> 8) & 0xff;
  out[1] = type & 0xff;
  out[2] = (length >> 8) & 0xff;
  out[3] = length & 0xff;
  out.set(body, 4);
  return out;
}

export function parseFields(bytes: Uint8Array, start: number): ExtensionField[] | null {
  const fields: ExtensionField[] = [];
  let at = start;
  while (at < bytes.length) {
    if (at + 4 > bytes.length) return null;
    const type = (bytes[at] << 8) | bytes[at + 1];
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (length < NTP_MIN_EF_LENGTH || length % 4 !== 0 || at + length > bytes.length) return null;
    fields.push({ type, start: at, length, body: bytes.subarray(at + 4, at + length) });
    at += length;
  }
  return fields;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

export function generateAuthField(
  associated: Uint8Array, key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, minFieldLength: number,
): Uint8Array {
  const nonceLength = nonce.length;
  const ciphertextLength = AES_SIV_TAG_SIZE + plaintext.length;
  const noncePadding = pad4(nonceLength);
  const ciphertextPadding = pad4(ciphertextLength);
  const minimum = minFieldLength + pad4(minFieldLength);
  let authLength = 4 + nonceLength + noncePadding + ciphertextLength + ciphertextPadding;
  let additional = Math.max(minimum - authLength - 4, 0);
  additional = Math.max(Math.min(NTS_MIN_UNPADDED_NONCE_LENGTH, nonceLength) - nonceLength - noncePadding, additional);
  authLength += additional;
  const body = new Uint8Array(authLength);
  body[0] = (nonceLength >> 8) & 0xff;
  body[1] = nonceLength & 0xff;
  body[2] = (ciphertextLength >> 8) & 0xff;
  body[3] = ciphertextLength & 0xff;
  body.set(nonce, 4);
  body.set(aesSivEncrypt(key, [associated, nonce], plaintext), 4 + nonceLength + noncePadding);
  const field = new Uint8Array(4 + authLength);
  field[0] = (EF.AUTH_AND_EEF >> 8) & 0xff;
  field[1] = EF.AUTH_AND_EEF & 0xff;
  field[2] = ((4 + authLength) >> 8) & 0xff;
  field[3] = (4 + authLength) & 0xff;
  field.set(body, 4);
  return field;
}

export function decryptAuthField(packet: Uint8Array, field: ExtensionField, key: Uint8Array): Uint8Array | null {
  const body = field.body;
  if (field.type !== EF.AUTH_AND_EEF || body.length < 4) return null;
  const nonceLength = (body[0] << 8) | body[1];
  const ciphertextLength = (body[2] << 8) | body[3];
  const paddedNonce = nonceLength + pad4(nonceLength);
  const paddedCiphertext = ciphertextLength + pad4(ciphertextLength);
  if (paddedNonce + paddedCiphertext > body.length - 4) return null;
  if (nonceLength < 1 || ciphertextLength < AES_SIV_TAG_SIZE) return null;
  if (4 + NTS_MIN_UNPADDED_NONCE_LENGTH + paddedCiphertext > body.length) return null;
  const nonce = body.subarray(4, 4 + nonceLength);
  const ciphertext = body.subarray(4 + paddedNonce, 4 + paddedNonce + ciphertextLength);
  return aesSivDecrypt(key, [packet.subarray(0, field.start), nonce], ciphertext);
}

export interface NtsServerRequest {
  readonly uniqueIdentifier: Uint8Array;
  readonly cookie: Uint8Array;
  readonly authField: ExtensionField;
  readonly requestedCookies: number;
  readonly cookieLength: number;
  readonly fields: ExtensionField[];
}

export function parseServerRequest(packet: Uint8Array): NtsServerRequest | null {
  const fields = parseFields(packet, NTP_HEADER_LENGTH);
  if (fields === null || fields.length === 0) return null;
  let uniqueIdentifier: Uint8Array | null = null;
  let cookie: Uint8Array | null = null;
  let authField: ExtensionField | null = null;
  let requested = 0;
  let cookieLength = -1;
  for (const field of fields) {
    switch (field.type) {
      case EF.UNIQUE_IDENTIFIER:
        uniqueIdentifier = field.body;
        break;
      case EF.COOKIE:
      case EF.COOKIE_PLACEHOLDER:
        if (field.type === EF.COOKIE) {
          if (cookie !== null || field.body.length > 256) return null;
          cookie = field.body;
        }
        requested++;
        if (cookieLength >= 0 && cookieLength !== field.body.length) return null;
        cookieLength = field.body.length;
        break;
      case EF.AUTH_AND_EEF:
        if (field.start + field.length !== packet.length) return null;
        authField = field;
        break;
      default:
        break;
    }
  }
  if (uniqueIdentifier === null || cookie === null || authField === null) return null;
  return { uniqueIdentifier, cookie, authField, requestedCookies: requested, cookieLength, fields };
}

export function countEncryptedPlaceholders(plaintext: Uint8Array, cookieLength: number): number | null {
  const fields = parseFields(plaintext, 0);
  if (fields === null) return null;
  let count = 0;
  for (const field of fields) {
    if (field.type !== EF.COOKIE_PLACEHOLDER) continue;
    if (field.body.length !== cookieLength) return null;
    count++;
  }
  return count;
}

export function buildServerResponse(
  responseHeader: Uint8Array, request: NtsServerRequest, requestLength: number,
  s2c: Uint8Array, nonce: Uint8Array, cookies: readonly Uint8Array[],
): Uint8Array {
  const uid = encodeField(EF.UNIQUE_IDENTIFIER, request.uniqueIdentifier);
  const associated = concat([responseHeader, uid]);
  const plaintext = concat(cookies.map((cookie) => encodeField(EF.COOKIE, cookie)));
  const auth = generateAuthField(associated, s2c, nonce, plaintext, requestLength - associated.length);
  return concat([associated, auth]);
}

export function buildNakResponse(responseHeader: Uint8Array, request: Pick<NtsServerRequest, 'uniqueIdentifier'> | null): Uint8Array {
  return request === null ? responseHeader : concat([responseHeader, encodeField(EF.UNIQUE_IDENTIFIER, request.uniqueIdentifier)]);
}

export function nakUniqueIdentifier(packet: Uint8Array): Uint8Array | null {
  const fields = parseFields(packet, NTP_HEADER_LENGTH);
  return fields === null ? null : fields.find((f) => f.type === EF.UNIQUE_IDENTIFIER)?.body ?? null;
}
