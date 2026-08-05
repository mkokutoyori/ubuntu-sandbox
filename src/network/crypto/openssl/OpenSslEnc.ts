/**
 * docs/PRD-OpenSSL.md §P2 — `enc`, symmetric encryption.
 *
 * Everything here is REAL: AES-CBC comes from `src/crypto/cipher/`, key
 * derivation from `src/crypto/kdf/` (PBKDF2). Nothing is imitated — that
 * is §5 P1, and it is what makes the exercise verifiable.
 *
 * ONE LIMIT, imposed by the platform rather than chosen, written here
 * because it is visible to the operator.
 *
 * The real `openssl enc` writes raw binary by default. This simulator's
 * filesystem stores UTF-8 STRINGS — `xxd` itself reads a file through
 * `TextEncoder().encode(content)`. Writing arbitrary bytes there would not
 * store them: invalid UTF-8 sequences are replaced on read, so decryption
 * would return something other than the original, SILENTLY.
 *
 * Rather than shipping a round-trip that corrupts, `enc` requires `-a`
 * (the base64 armour, a real openssl option) as soon as it writes to a
 * file, and refuses raw binary while saying why. The output with `-a` is
 * exactly the real tool's — base64 of `Salted__` ‖ salt ‖ ciphertext — so
 * nothing is invented: it is a faithful subset, not an imitation.
 */

import { aesCbcEncrypt, aesCbcDecrypt } from '@/crypto/cipher';
import { pbkdf2 } from '@/crypto/kdf';
import { md5, SHA256 } from '@/crypto/hash';
import {
  bytesToBase64, base64ToBytes, bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8,
} from '@/crypto/encoding';
import { parseArgs } from './OpenSslArgs';
import { ok, fail, type OpenSslHost, type OpenSslResult } from './OpenSslHost';

interface Algo {
  readonly keyLen: number;
  readonly ivLen: number;
}

/** What `src/crypto/cipher/` can genuinely do — §8.3. */
export const ENC_ALGOS: Readonly<Record<string, Algo>> = {
  'aes-128-cbc': { keyLen: 16, ivLen: 16 },
  'aes-192-cbc': { keyLen: 24, ivLen: 16 },
  'aes-256-cbc': { keyLen: 32, ivLen: 16 },
};

/**
 * 3DES is ABSENT, and the PRD's §8.3 was wrong to announce it as real.
 * Measured: `src/crypto/cipher/des.ts` exports `desCbcEncrypt` but NO
 * `desCbcDecrypt`. So `enc -des-ede3-cbc` would encrypt without being able
 * to decrypt — a command that loses the data entrusted to it, which is
 * worse than its absence. Writing it means adding a primitive, that is,
 * new cryptography: a phase of its own, as §12 already says for the
 * others.
 */

/** What openssl knows and `src/crypto/` does not implement. */
export const ENC_KNOWN_UNIMPLEMENTED = [
  'des-ede3-cbc', 'des3', 'des-ede3',
  'aes-128-ecb', 'aes-192-ecb', 'aes-256-ecb', 'aes-128-gcm', 'aes-256-gcm',
  'aria-128-cbc', 'aria-256-cbc', 'camellia-128-cbc', 'camellia-256-cbc',
  'sm4-cbc', 'rc2', 'rc4', 'chacha20', 'chacha20-poly1305', 'seed', 'desx', 'des',
];

const MAGIC = 'Salted__';

/**
 * openssl's historical derivation (`EVP_BytesToKey`), used when `-pbkdf2`
 * is not asked for. It is weak, and that is precisely what openssl 3
 * reproaches its own default with: reproducing it lets us SHOW the
 * difference instead of talking about it.
 */
function evpBytesToKey(password: Uint8Array, salt: Uint8Array, total: number): Uint8Array {
  const out = new Uint8Array(total);
  let filled = 0;
  let previous = new Uint8Array(0);
  while (filled < total) {
    const input = new Uint8Array(previous.length + password.length + salt.length);
    input.set(previous, 0);
    input.set(password, previous.length);
    input.set(salt, previous.length + password.length);
    previous = md5(input);
    const n = Math.min(previous.length, total - filled);
    out.set(previous.subarray(0, n), filled);
    filled += n;
  }
  return out;
}

function passwordFrom(host: OpenSslHost, opts: Map<string, string | true>): string | null {
  const k = opts.get('-k');
  if (typeof k === 'string') return k;
  const pass = opts.get('-pass');
  if (typeof pass === 'string') {
    if (pass.startsWith('pass:')) return pass.slice(5);
    if (pass.startsWith('file:')) return (host.readFile(pass.slice(5)) ?? '').split('\n')[0];
  }
  const stdin = host.stdin();
  return stdin === null ? null : stdin.trim();
}

export function runEnc(
  host: OpenSslHost, argv: readonly string[], forced?: string,
): OpenSslResult {
  const { opts } = parseArgs('enc', argv);

  let name = forced;
  if (name === undefined) {
    for (const a of Object.keys(ENC_ALGOS)) if (opts.has(`-${a}`)) name = a;
    if (name === undefined) {
      for (const a of ENC_KNOWN_UNIMPLEMENTED) {
        if (opts.has(`-${a}`)) return fail(`openssl: '${a}' is not implemented in this simulator`);
      }
    }
  }
  if (name === undefined) return fail('openssl: enc: a cipher is required (e.g. -aes-256-cbc)');
  const algo = ENC_ALGOS[name];
  if (!algo) return fail(`openssl: '${name}' is not implemented in this simulator`);

  const password = passwordFrom(host, opts);
  if (password === null || password === '') {
    return fail('openssl: enc: a password is required (-k, -pass pass:… or stdin)');
  }

  const inPath = opts.get('-in');
  const input = typeof inPath === 'string' ? host.readFile(inPath) : host.stdin();
  if (input === null) {
    return typeof inPath === 'string'
      ? fail(`${inPath}: No such file or directory`)
      : fail('openssl: enc: no input');
  }

  const decrypting = opts.has('-d');
  const armoured = opts.has('-a') || opts.has('-base64');
  const out = opts.get('-out');

  // The limit from this file's header, stated where it applies, with the
  // option that lifts it.
  if (!armoured && typeof out === 'string' && !decrypting) {
    return fail('openssl: enc: raw binary output cannot be stored by this simulator\'s '
      + 'filesystem (it holds text); add -a for the base64 armour openssl itself offers');
  }

  const iterations = Number(opts.get('-iter') ?? (opts.has('-pbkdf2') ? 10000 : 1));
  const derive = (salt: Uint8Array): { key: Uint8Array; iv: Uint8Array } => {
    const total = algo.keyLen + algo.ivLen;
    const raw = opts.has('-pbkdf2')
      ? pbkdf2(SHA256, utf8ToBytes(password), salt, iterations, total)
      : evpBytesToKey(utf8ToBytes(password), salt, total);
    return { key: raw.subarray(0, algo.keyLen), iv: raw.subarray(algo.keyLen, total) };
  };

  if (!decrypting) {
    const salt = typeof opts.get('-S') === 'string'
      ? hexToBytes(String(opts.get('-S')))
      : host.randomBytes(8);
    const { key, iv } = derive(salt);
    const body = aesCbcEncrypt(key, iv, utf8ToBytes(input));

    if (opts.has('-P') || opts.has('-p')) {
      const trace = [
        `salt=${bytesToHex(salt).toUpperCase()}`,
        `key=${bytesToHex(key).toUpperCase()}`,
        `iv =${bytesToHex(iv).toUpperCase()}`,
      ].join('\n');
      // `-P` prints and does NOT operate; `-p` prints then operates.
      if (opts.has('-P')) return ok(trace);
      const armour = assemble(salt, body, opts.has('-nosalt'));
      return write(host, out, `${trace}\n${armour}`, armour, trace);
    }

    const armour = assemble(salt, body, opts.has('-nosalt'));
    return write(host, out, armour, armour, '');
  }

  // ── decryption ──
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(input.replace(/\s+/g, ''));
  } catch {
    return fail('error reading input file');
  }
  let salt = new Uint8Array(8);
  let body = raw;
  if (!opts.has('-nosalt')) {
    const header = bytesToUtf8(raw.subarray(0, 8));
    if (header !== MAGIC) return fail('bad magic number');
    salt = raw.subarray(8, 16);
    body = raw.subarray(16);
  }
  const { key, iv } = derive(salt);
  let plain: Uint8Array;
  try {
    plain = aesCbcDecrypt(key, iv, body);
  } catch {
    return badDecrypt();
  }
  const text = bytesToUtf8(plain);
  // A wrong password must FAIL rather than return noise: that is what the
  // PKCS#7 padding says, as on a real machine.
  if (text.includes('�')) return badDecrypt();
  return write(host, out, text, text, '');
}

function assemble(salt: Uint8Array, body: Uint8Array, withoutSalt: boolean): string {
  if (withoutSalt) return bytesToBase64(body);
  const all = new Uint8Array(16 + body.length);
  all.set(utf8ToBytes(MAGIC), 0);
  all.set(salt, 8);
  all.set(body, 16);
  return bytesToBase64(all);
}

function badDecrypt(): OpenSslResult {
  // The real openssl's message, verbose second line included: reproducing
  // it keeps a learner from believing the simulator is buggy the day they
  // meet the real one.
  return fail('bad decrypt\n40E7F1B8C87F0000:error:1C800064:Provider routines:'
    + 'ossl_cipher_unpadblock:bad decrypt:../providers/implementations/ciphers/'
    + 'ciphercommon_block.c:107:');
}

function write(
  host: OpenSslHost, out: string | true | undefined,
  toFile: string, toScreen: string, trace: string,
): OpenSslResult {
  if (typeof out === 'string') {
    return host.writeFile(out, toFile.split('\n').pop()! + '\n')
      ? { output: '', stderr: trace, exitCode: 0 }
      : fail(`${out}: cannot write`);
  }
  return ok(toScreen);
}
