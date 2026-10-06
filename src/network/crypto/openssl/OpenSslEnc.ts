/**
 * docs/PRD-OpenSSL.md §P2 — `enc`, symmetric encryption.
 *
 * Everything here is REAL: AES-CBC comes from `src/crypto/cipher/`, key
 * derivation from `src/crypto/kdf/` (PBKDF2). Like the real tool, `enc`
 * reads and writes raw bytes by default (`Salted__` ‖ salt ‖ ciphertext)
 * and the base64 armour only with `-a`.
 */

import {
  aesCbcEncrypt, aesCbcDecrypt, aesEncryptBlock, aesDecryptBlock, tripleDesCbcEncrypt, tripleDesCbcDecrypt,
  tripleDesEncryptBlock, tripleDesDecryptBlock, chacha20Xor,
} from '@/crypto/cipher';
import { pbkdf2 } from '@/crypto/kdf';
import { md5, SHA256 } from '@/crypto/hash';
import {
  bytesToBase64, base64ToBytes, bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8, bytesToFileText, fileTextToBytes,
} from '@/crypto/encoding';
import { parseArgs } from './OpenSslArgs';
import { ok, fail, type OpenSslHost, type OpenSslResult } from './OpenSslHost';

interface Algo {
  readonly keyLen: number;
  readonly ivLen: number;
  seal(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array;
  open(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array;
}

function pkcs7Pad(data: Uint8Array, block: number): Uint8Array {
  const pad = block - (data.length % block);
  const out = new Uint8Array(data.length + pad);
  out.set(data, 0);
  out.fill(pad, data.length);
  return out;
}

function pkcs7Unpad(data: Uint8Array, block: number): Uint8Array {
  const pad = data[data.length - 1];
  if (data.length === 0 || data.length % block !== 0 || pad === 0 || pad > block) throw new Error('bad padding');
  for (let i = data.length - pad; i < data.length; i++) if (data[i] !== pad) throw new Error('bad padding');
  return data.subarray(0, data.length - pad);
}

type BlockFn = (key: Uint8Array, block: Uint8Array) => Uint8Array;

function ecbAlgo(keyLen: number, block: number, encrypt: BlockFn, decrypt: BlockFn): Algo {
  return {
    keyLen, ivLen: 0,
    seal: (key, _iv, data) => {
      const padded = pkcs7Pad(data, block);
      const out = new Uint8Array(padded.length);
      for (let i = 0; i < padded.length; i += block) out.set(encrypt(key, padded.subarray(i, i + block)), i);
      return out;
    },
    open: (key, _iv, data) => {
      if (data.length === 0 || data.length % block !== 0) throw new Error('bad length');
      const out = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i += block) out.set(decrypt(key, data.subarray(i, i + block)), i);
      return pkcs7Unpad(out, block);
    },
  };
}

function desCbcAlgo(keyLen: number): Algo {
  return {
    keyLen, ivLen: 8,
    seal: (key, iv, data) => tripleDesCbcEncrypt(key, iv, pkcs7Pad(data, 8)),
    open: (key, iv, data) => pkcs7Unpad(tripleDesCbcDecrypt(key, iv, data), 8),
  };
}

function aesStreamAlgo(keyLen: number, mode: 'ctr' | 'cfb' | 'ofb'): Algo {
  const run = (key: Uint8Array, iv: Uint8Array, data: Uint8Array, decrypting: boolean): Uint8Array => {
    const out = new Uint8Array(data.length);
    const feedback = new Uint8Array(iv);
    for (let offset = 0; offset < data.length; offset += 16) {
      const stream = aesEncryptBlock(key, feedback);
      const chunk = Math.min(16, data.length - offset);
      for (let i = 0; i < chunk; i++) out[offset + i] = data[offset + i] ^ stream[i];
      if (mode === 'ctr') {
        for (let i = 15; i >= 0; i--) { feedback[i] = (feedback[i] + 1) & 0xff; if (feedback[i] !== 0) break; }
      } else if (mode === 'ofb') {
        feedback.set(stream);
      } else {
        const ciphertext = decrypting ? data.subarray(offset, offset + chunk) : out.subarray(offset, offset + chunk);
        feedback.fill(0);
        feedback.set(ciphertext);
        if (chunk < 16) feedback.set(stream.subarray(chunk), chunk);
      }
    }
    return out;
  };
  return { keyLen, ivLen: 16, seal: (key, iv, data) => run(key, iv, data, false), open: (key, iv, data) => run(key, iv, data, true) };
}

function chacha20Algo(): Algo {
  const run = (key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array => {
    const counter = iv[0] | (iv[1] << 8) | (iv[2] << 16) | (iv[3] << 24);
    return chacha20Xor(key, counter >>> 0, iv.subarray(4, 16), data);
  };
  return { keyLen: 32, ivLen: 16, seal: (key, iv, data) => run(key, iv, data), open: (key, iv, data) => run(key, iv, data) };
}

const aesCbcAlgo = (keyLen: number): Algo => ({ keyLen, ivLen: 16, seal: aesCbcEncrypt, open: aesCbcDecrypt });

export const ENC_ALGOS: Readonly<Record<string, Algo>> = {
  'aes-128-cbc': aesCbcAlgo(16),
  'aes-192-cbc': aesCbcAlgo(24),
  'aes-256-cbc': aesCbcAlgo(32),
  'aes-128-ecb': ecbAlgo(16, 16, aesEncryptBlock, aesDecryptBlock),
  'aes-192-ecb': ecbAlgo(24, 16, aesEncryptBlock, aesDecryptBlock),
  'aes-256-ecb': ecbAlgo(32, 16, aesEncryptBlock, aesDecryptBlock),
  'aes-128-ctr': aesStreamAlgo(16, 'ctr'),
  'aes-192-ctr': aesStreamAlgo(24, 'ctr'),
  'aes-256-ctr': aesStreamAlgo(32, 'ctr'),
  'aes-128-cfb': aesStreamAlgo(16, 'cfb'),
  'aes-192-cfb': aesStreamAlgo(24, 'cfb'),
  'aes-256-cfb': aesStreamAlgo(32, 'cfb'),
  'aes-128-ofb': aesStreamAlgo(16, 'ofb'),
  'aes-192-ofb': aesStreamAlgo(24, 'ofb'),
  'aes-256-ofb': aesStreamAlgo(32, 'ofb'),
  'des-ede3-cbc': desCbcAlgo(24),
  'des3': desCbcAlgo(24),
  'des-ede-cbc': desCbcAlgo(16),
  'des-ede3': ecbAlgo(24, 8, tripleDesEncryptBlock, tripleDesDecryptBlock),
  'des-ede3-ecb': ecbAlgo(24, 8, tripleDesEncryptBlock, tripleDesDecryptBlock),
  'des-ede': ecbAlgo(16, 8, tripleDesEncryptBlock, tripleDesDecryptBlock),
  'des-ede-ecb': ecbAlgo(16, 8, tripleDesEncryptBlock, tripleDesDecryptBlock),
  'chacha20': chacha20Algo(),
};

const ENC_ALIASES: Readonly<Record<string, string>> = {
  aes128: 'aes-128-cbc', aes192: 'aes-192-cbc', aes256: 'aes-256-cbc',
  'aes-128': 'aes-128-cbc', 'aes-192': 'aes-192-cbc', 'aes-256': 'aes-256-cbc',
};

export function encAlgorithmNamed(name: string): string | undefined {
  const resolved = ENC_ALIASES[name] ?? name;
  return ENC_ALGOS[resolved] ? resolved : undefined;
}

export const ENC_AEAD_CIPHERS = [
  'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'aes-128-ccm', 'aes-192-ccm', 'aes-256-ccm', 'chacha20-poly1305',
];

const LEGACY_PROVIDER_CIPHERS: Readonly<Record<string, readonly [string, number]>> = {
  rc4: ['RC4', 37], 'rc4-40': ['RC4-40', 0], des: ['DES-CBC', 8], 'des-cbc': ['DES-CBC', 8],
  'des-cfb': ['DES-CFB', 38], 'des-ofb': ['DES-OFB', 66], rc2: ['RC2-CBC', 4], 'rc2-cbc': ['RC2-CBC', 4],
  desx: ['DESX-CBC', 0], seed: ['SEED-CBC', 53], 'seed-cbc': ['SEED-CBC', 53], bf: ['BF-CBC', 11],
  'bf-cbc': ['BF-CBC', 11], blowfish: ['BF-CBC', 11], 'cast5-cbc': ['CAST5-CBC', 18], cast: ['CAST5-CBC', 18],
};

export function legacyProviderCipherError(name: string): string | null {
  const entry = LEGACY_PROVIDER_CIPHERS[name];
  if (!entry) return null;
  return `Error setting cipher ${entry[0]}\n00007F0000000000:error:0308010C:digital envelope routines:inner_evp_generic_fetch:`
    + `unsupported:../crypto/evp/evp_fetch.c:386:Global default library context, Algorithm (${entry[0]} : ${entry[1]}), Properties ()`;
}

export const ENC_KNOWN_UNIMPLEMENTED = [
  'aria-128-cbc', 'aria-192-cbc', 'aria-256-cbc', 'camellia-128-cbc', 'camellia-192-cbc', 'camellia-256-cbc',
  'sm4-cbc', 'sm4',
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

  let name = forced === undefined ? undefined : encAlgorithmNamed(forced) ?? forced;
  if (name === undefined) {
    for (const a of [...Object.keys(ENC_ALGOS), ...Object.keys(ENC_ALIASES)]) {
      if (opts.has(`-${a}`)) name = encAlgorithmNamed(a);
    }
    if (name === undefined) {
      for (const flag of opts.keys()) {
        const candidate = flag.slice(1);
        if (ENC_AEAD_CIPHERS.includes(candidate)) return fail('enc: AEAD ciphers not supported\nenc: Use -help for summary.');
        const legacy = legacyProviderCipherError(candidate);
        if (legacy !== null) return fail(legacy);
        if (ENC_KNOWN_UNIMPLEMENTED.includes(candidate)) return fail(`openssl: '${candidate}' is not implemented in this simulator`);
      }
    }
  }
  if (name === undefined) return fail('openssl: enc: a cipher is required (e.g. -aes-256-cbc)');
  const algo = ENC_ALGOS[name];
  if (!algo) {
    if (ENC_AEAD_CIPHERS.includes(name)) return fail('enc: AEAD ciphers not supported\nenc: Use -help for summary.');
    return fail(legacyProviderCipherError(name) ?? `openssl: '${name}' is not implemented in this simulator`);
  }

  const password = passwordFrom(host, opts);
  if (password === null || password === '') {
    return fail('openssl: enc: a password is required (-k, -pass pass:… or stdin)');
  }

  const inPath = opts.get('-in');
  const input = opts.has('-P') ? '' : typeof inPath === 'string' ? host.readFile(inPath) : host.stdin();
  if (input === null) {
    return typeof inPath === 'string'
      ? fail(`${inPath}: No such file or directory`)
      : fail('openssl: enc: no input');
  }

  const decrypting = opts.has('-d');
  const armoured = opts.has('-a') || opts.has('-base64');
  const out = opts.get('-out');

  const iterations = Number(opts.get('-iter') ?? (opts.has('-pbkdf2') ? 10000 : 1));
  const derive = (salt: Uint8Array): { key: Uint8Array; iv: Uint8Array } => {
    const total = algo.keyLen + algo.ivLen;
    const raw = opts.has('-pbkdf2')
      ? pbkdf2(SHA256, utf8ToBytes(password), salt, iterations, total)
      : evpBytesToKey(utf8ToBytes(password), salt, total);
    return { key: raw.subarray(0, algo.keyLen), iv: raw.subarray(algo.keyLen, total) };
  };

  const givenSalt = opts.get('-S');
  let fixedSalt: Uint8Array | null = null;
  if (typeof givenSalt === 'string') {
    if (!/^[0-9a-fA-F]{1,16}$/.test(givenSalt)) return fail('invalid hex salt value');
    fixedSalt = hexToBytes(givenSalt.padEnd(16, '0'));
  }
  const headerless = fixedSalt !== null || opts.has('-nosalt');

  if (!decrypting) {
    const salt = fixedSalt ?? host.randomBytes(8);
    const { key, iv } = derive(salt);
    const body = algo.seal(key, iv, fileTextToBytes(input));

    if (opts.has('-P') || opts.has('-p')) {
      const trace = [
        ...(opts.has('-nosalt') ? [] : [`salt=${bytesToHex(salt).toUpperCase()}`]),
        `key=${bytesToHex(key).toUpperCase()}`,
        ...(algo.ivLen > 0 ? [`iv =${bytesToHex(iv).toUpperCase()}`] : []),
      ].join('\n');
      if (opts.has('-P')) return ok(trace);
      const content = assemble(salt, body, headerless, armoured, opts.has('-A'));
      if (typeof out === 'string') {
        return host.writeFile(out, content) ? ok(trace) : fail(`${out}: cannot write`);
      }
      return ok(`${trace}\n${content}`);
    }

    return write(host, out, assemble(salt, body, headerless, armoured, opts.has('-A')), '');
  }

  // ── decryption ──
  let raw: Uint8Array;
  try {
    raw = armoured ? base64ToBytes(input.replace(/\s+/g, '')) : fileTextToBytes(input);
  } catch {
    return fail('error reading input file');
  }
  let salt = fixedSalt ?? new Uint8Array(8);
  let body = raw;
  if (!headerless) {
    const header = bytesToUtf8(raw.subarray(0, 8));
    if (header !== MAGIC) return fail('bad magic number');
    salt = raw.subarray(8, 16);
    body = raw.subarray(16);
  }
  const { key, iv } = derive(salt);
  let plain: Uint8Array;
  try {
    plain = algo.open(key, iv, body);
  } catch {
    return badDecrypt();
  }
  return write(host, out, bytesToFileText(plain), '');
}

function assemble(
  salt: Uint8Array, body: Uint8Array, withoutSalt: boolean, armoured: boolean, singleLine: boolean,
): string {
  let all = body;
  if (!withoutSalt) {
    all = new Uint8Array(16 + body.length);
    all.set(utf8ToBytes(MAGIC), 0);
    all.set(salt, 8);
    all.set(body, 16);
  }
  if (!armoured) return bytesToFileText(all);
  const encoded = bytesToBase64(all);
  return `${singleLine ? encoded : (encoded.match(/.{1,64}/g) ?? []).join('\n')}\n`;
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
  host: OpenSslHost, out: string | true | undefined, content: string, trace: string,
): OpenSslResult {
  if (typeof out === 'string') {
    return host.writeFile(out, content)
      ? { output: '', stderr: trace, exitCode: 0 }
      : fail(`${out}: cannot write`);
  }
  return { output: content, stderr: trace, exitCode: 0 };
}
