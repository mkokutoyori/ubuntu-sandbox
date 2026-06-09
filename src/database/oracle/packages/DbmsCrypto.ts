/**
 * DBMS_CRYPTO — Oracle's cryptographic toolkit package, backed by the real
 * algorithms in `@/crypto` (previously not modelled at all).
 *
 *   HASH(src RAW, typ)            → one-way digest  (MD5/SHA1/SHA256/SHA512)
 *   MAC(src RAW, typ, key RAW)    → keyed HMAC       (MD5/SHA1/SHA256/SHA512)
 *   ENCRYPT(src, typ, key, iv)    → AES-CBC ciphertext (PKCS#7)
 *   DECRYPT(src, typ, key, iv)    → AES-CBC plaintext
 *
 * RAW arguments are interpreted as hex when the value is valid hex, otherwise
 * as UTF-8 text (so both `DBMS_CRYPTO.HASH('Hello',4)` and the
 * `UTL_RAW.CAST_TO_RAW`-style hex form work). Results are uppercase hex (RAW).
 * AES variant follows the key length (16/24/32 bytes → AES-128/192/256); the
 * common CBC + PKCS#7 chaining/padding is modelled regardless of the typ bits.
 */

import { builtinPackageRegistry, type IPackageRoutine } from './PackageRegistry';
import {
  md5, sha1, sha256, sha512, MD5, SHA1, SHA256, SHA512,
  hmac, aesCbcEncrypt, aesCbcDecrypt, bytesToHex, hexToBytes, utf8ToBytes,
  type HashAlgorithm,
} from '@/crypto';

/** DBMS_CRYPTO.HASH_* type constants → digest function. */
const HASH_FNS: Record<string, (b: Uint8Array) => Uint8Array> = {
  '2': md5, '3': sha1, '4': sha256, '6': sha512,
};
/** DBMS_CRYPTO.HMAC_* type constants → hash backing the HMAC. */
const MAC_HASHES: Record<string, HashAlgorithm> = {
  '1': MD5, '2': SHA1, '3': SHA256, '5': SHA512,
};

/** Interpret an Oracle RAW argument: hex if it looks like hex, else UTF-8. */
function rawToBytes(value: string): Uint8Array {
  return /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0
    ? hexToBytes(value)
    : utf8ToBytes(value);
}
const toRaw = (bytes: Uint8Array): string => bytesToHex(bytes).toUpperCase();

class CryptoHash implements IPackageRoutine {
  readonly fullName = 'DBMS_CRYPTO.HASH';
  invoke(args: string[]): string | null {
    const fn = HASH_FNS[(args[1] ?? '').trim()];
    if (!fn || args[0] === undefined) return null;
    return toRaw(fn(rawToBytes(args[0])));
  }
}

class CryptoMac implements IPackageRoutine {
  readonly fullName = 'DBMS_CRYPTO.MAC';
  invoke(args: string[]): string | null {
    const hash = MAC_HASHES[(args[1] ?? '').trim()];
    if (!hash || args[0] === undefined || args[2] === undefined) return null;
    return toRaw(hmac(hash, rawToBytes(args[2]), rawToBytes(args[0])));
  }
}

class CryptoEncrypt implements IPackageRoutine {
  readonly fullName = 'DBMS_CRYPTO.ENCRYPT';
  invoke(args: string[]): string | null {
    if (args[0] === undefined || args[2] === undefined) return null;
    const iv = args[3] ? rawToBytes(args[3]) : new Uint8Array(16);
    return toRaw(aesCbcEncrypt(rawToBytes(args[2]), iv, rawToBytes(args[0])));
  }
}

class CryptoDecrypt implements IPackageRoutine {
  readonly fullName = 'DBMS_CRYPTO.DECRYPT';
  invoke(args: string[]): string | null {
    if (args[0] === undefined || args[2] === undefined) return null;
    const iv = args[3] ? rawToBytes(args[3]) : new Uint8Array(16);
    return toRaw(aesCbcDecrypt(rawToBytes(args[2]), iv, rawToBytes(args[0])));
  }
}

/** Bundles every DBMS_CRYPTO routine for registration. */
export class DbmsCrypto {
  static register(): void {
    builtinPackageRegistry.register(new CryptoHash());
    builtinPackageRegistry.register(new CryptoMac());
    builtinPackageRegistry.register(new CryptoEncrypt());
    builtinPackageRegistry.register(new CryptoDecrypt());
  }
}
