import { SHA256 } from '@/crypto/hash';
import { hmac } from '@/crypto/mac/hmac';
import { bytesToHex, hexToBytes } from '@/crypto/encoding';

const HEX_32 = /^[0-9a-fA-F]{32}$/;
const DASHED = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const NULL_ID128 = '0'.repeat(32);

export function parseId128(text: string): string | null {
  if (HEX_32.test(text)) return text.toLowerCase();
  if (DASHED.test(text)) return text.replace(/-/g, '').toLowerCase();
  return null;
}

export function toUuid(id: string): string {
  return [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20, 32)].join('-');
}

export function appSpecificId(keyId: string, appId: string): string {
  const digest = hmac(SHA256, hexToBytes(keyId), hexToBytes(appId)).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return bytesToHex(digest);
}

export function prettySample(name: string, id: string): string {
  const macro = id.match(/../g)!.join(',');
  return [
    'As string:', id, '',
    'As UUID:', toUuid(id), '',
    'As systemd-id128(1) macro:', `#define ${name} SD_ID128_MAKE(${macro})`, '',
    'As Python constant:', '>>> import uuid', `>>> ${name} = uuid.UUID('${id}')`,
  ].join('\n') + '\n';
}
