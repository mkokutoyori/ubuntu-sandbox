import { aesGcmEncrypt, aesGcmDecrypt, AES_GCM_IV_SIZE, AES_GCM_TAG_SIZE } from '@/crypto/cipher';
import { sha256 } from '@/crypto/hash';
import { utf8ToBytes, bytesToUtf8, bytesToBase64, base64ToBytes } from '@/crypto/encoding';

export const FORTI_BACKUP_MAGIC = '#FGTCONFIG-ENCRYPTED-AES256-GCM';

const WRAP = 64;

function backupKey(password: string): Uint8Array {
  return sha256(utf8ToBytes(password));
}

function randomBytes(count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
}

export function isEncryptedConfig(text: string): boolean {
  return text.startsWith(FORTI_BACKUP_MAGIC);
}

export function encryptConfig(
  clear: string, password: string, random: (n: number) => Uint8Array = randomBytes,
): string {
  const iv = random(AES_GCM_IV_SIZE);
  const { ciphertext, tag } = aesGcmEncrypt(
    backupKey(password), iv, new Uint8Array(0), utf8ToBytes(clear));

  const body = new Uint8Array(iv.length + tag.length + ciphertext.length);
  body.set(iv, 0);
  body.set(tag, iv.length);
  body.set(ciphertext, iv.length + tag.length);

  const armour = bytesToBase64(body).match(new RegExp(`.{1,${WRAP}}`, 'g')) ?? [];
  return [FORTI_BACKUP_MAGIC, ...armour].join('\n');
}

export function decryptConfig(text: string, password: string): string | null {
  if (!isEncryptedConfig(text)) return null;

  const body = base64ToBytes(text.split('\n').slice(1).join(''));
  if (body.length < AES_GCM_IV_SIZE + AES_GCM_TAG_SIZE) return null;

  const clear = aesGcmDecrypt(
    backupKey(password),
    body.slice(0, AES_GCM_IV_SIZE),
    new Uint8Array(0),
    body.slice(AES_GCM_IV_SIZE + AES_GCM_TAG_SIZE),
    body.slice(AES_GCM_IV_SIZE, AES_GCM_IV_SIZE + AES_GCM_TAG_SIZE),
  );
  return clear === null ? null : bytesToUtf8(clear);
}
