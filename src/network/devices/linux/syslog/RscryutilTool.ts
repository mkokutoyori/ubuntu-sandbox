import { END_OF_OPTIONS, GnuGetopt, type LongOption } from '../audit/tools/GnuGetopt';
import { ExitSignal, ToolOutput, type ToolResult } from '../audit/tools/AuditToolHost';
import { CryptoCipher, parseKeyProgramOutput, type CryptoProviderName, type KeyProgramOutput } from '@/network/rsyslog/crypto/CryptoProvider';
import { ENCINFO_SUFFIX, EncryptionInfoReader } from '@/network/rsyslog/crypto/EncryptionInfo';
import { removeToolPadding } from '@/network/rsyslog/crypto/Padding';

export const RSCRYUTIL_VERSION = '8.2610.0';

const MAX_RANDOM_KEY_LENGTH = 64 * 1024;
const MAX_KEY_FILE_LENGTH = 64 * 1024;
const READ_BUFFER_LENGTH = 64 * 1024;

export interface RscryutilHost {
  readBytes(path: string): { readonly bytes: Uint8Array } | { readonly error: string };
  readText(path: string): { readonly text: string } | { readonly error: string };
  createKeyFile(path: string, bytes: Uint8Array, force: boolean): string | null;
  randomBytes(count: number): Uint8Array;
  runKeyProgram(program: string): KeyProgramOutput | null;
}

const OPTIONS: readonly LongOption[] = [
  { name: 'verbose', hasArg: 0, val: 0x76 },
  { name: 'version', hasArg: 0, val: 0x56 },
  { name: 'decrypt', hasArg: 0, val: 0x64 },
  { name: 'force', hasArg: 0, val: 0x66 },
  { name: 'write-keyfile', hasArg: 1, val: 0x57 },
  { name: 'key', hasArg: 1, val: 0x4b },
  { name: 'generate-random-key', hasArg: 1, val: 0x72 },
  { name: 'keyfile', hasArg: 1, val: 0x6b },
  { name: 'key-program', hasArg: 1, val: 0x70 },
  { name: 'algo', hasArg: 1, val: 0x61 },
  { name: 'mode', hasArg: 1, val: 0x6d },
  { name: 'lib', hasArg: 1, val: 0x6c },
];

const SHORT_OPTIONS = 'a:dfk:K:m:p:r:vVW:l:';

function atoi(text: string): number {
  const parsed = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(text);
  return parsed === null ? 0 : Number(parsed[1]);
}

function cString(bytes: Uint8Array): number {
  const end = bytes.indexOf(0);
  return end < 0 ? bytes.length : end;
}

const GCRYPT_ERRORS: Readonly<Record<'open' | 'setkey', string>> = {
  open: 'gcry_cipher_open failed:  Libgcrypt/Invalid cipher mode',
  setkey: 'gcry_cipher_setkey failed:  Libgcrypt/Weak encryption key',
};

export function runRscryutil(host: RscryutilHost, argv: string[], program = 'rscryutil'): ToolResult {
  const out = new ToolOutput();
  const chunks: Uint8Array[] = [];
  let exitCode = 0;
  let provider: CryptoProviderName = 'gcry';
  let keyFile: string | null = null;
  let keyProgram: string | null = null;
  let randomKeyLength = -1;
  let key: Uint8Array | null = null;
  let force = false;
  let newKeyFile: string | null = null;
  let algorithm: string | undefined;
  let mode: string | undefined;
  let libraryName: string | null = null;
  const fail = (message: string): never => {
    out.eprintf(`${message}\n`);
    throw new ExitSignal(1);
  };

  const decryptFile = (name: string, cipher: CryptoCipher): void => {
    const failed = (code: number): void => {
      out.eprintf(`error ${code} processing file ${name}\n`);
    };
    if (name === '-') {
      out.eprintf('decrypt mode cannot work on stdin\n');
      failed(0);
      return;
    }
    const log = host.readBytes(name);
    if ('error' in log) {
      out.eprintf(`${name}: ${log.error}\n`);
      failed(0);
      return;
    }
    const info = host.readText(`${name}${ENCINFO_SUFFIX}`);
    if ('error' in info) {
      out.eprintf(`${name}${ENCINFO_SUFFIX}: ${info.error}\n`);
      failed(0);
      return;
    }
    const reader = new EncryptionInfoReader(info.text);
    if (!reader.skipFileType()) {
      out.eprintf('invalid filetype "cookie" in encryption info file\n');
      out.eprintf(`\trectype: '${info.text.split(':')[0] ?? ''}', value: '${(info.text.split('\n')[0] ?? '').split(':').slice(1).join(':')}'\n`);
      failed(0);
      return;
    }
    let status = 1;
    let currentOffset = 0;
    const blockLength = cipher.blockSize;
    for (;;) {
      const iv = reader.nextIv(blockLength);
      if (iv === null) break;
      if (key === null || cString(key) !== cipher.keyLength) {
        out.eprintf(`invalid key length; key is ${key === null ? 0 : cString(key)} characters, but exactly ${cipher.keyLength} characters are required\n`);
        failed(1);
        return;
      }
      const session = cipher.open(iv, 'decrypt');
      if ('failure' in session) {
        out.eprintf(`${GCRYPT_ERRORS[session.failure]}\n`);
        failed(1);
        return;
      }
      const end = reader.nextEnd();
      let blockEnd = log.bytes.length;
      if (end.kind === 'end') {
        blockEnd = end.offset;
        status = 0;
      } else if (end.kind === 'invalid') {
        failed(2);
        return;
      } else {
        if (end.kind === 'other') out.eprintf(`no END record found when expected, record type seen is '${end.type}'\n`);
        status = 1;
      }
      let left = blockEnd - currentOffset;
      while (left > 0) {
        let toRead = Math.min(READ_BUFFER_LENGTH, left);
        toRead -= toRead % blockLength;
        if (toRead === 0) break;
        const piece = log.bytes.subarray(currentOffset, Math.min(currentOffset + toRead, log.bytes.length));
        if (piece.length === 0) break;
        left -= piece.length;
        currentOffset += piece.length;
        const result = session.transform(piece);
        if (result.failed) {
          out.eprintf('gcry_cipher_decrypt failed:  Libgcrypt/Invalid length\n');
          break;
        }
        chunks.push(provider === 'gcry' ? removeToolPadding(result.data) : result.data);
        if (piece.length < toRead) break;
      }
    }
    if (status !== 0) failed(status);
  };

  try {
    const first = new GnuGetopt([program, ...argv], SHORT_OPTIONS, OPTIONS, { program, write: (text) => out.eprintf(text) });
    for (;;) {
      const { code, optarg } = first.next();
      if (code === END_OF_OPTIONS) break;
      if (code === 0x6c) {
        libraryName = optarg;
        break;
      }
    }
    const requested = libraryName ?? 'gcry';
    if (requested !== 'gcry' && requested !== 'ossl') fail(`invalid option for lib: ${requested}`);
    provider = requested as CryptoProviderName;
    const getopt = new GnuGetopt([program, ...argv], SHORT_OPTIONS, OPTIONS, { program, write: (text) => out.eprintf(text) });
    for (;;) {
      const { code, optarg } = getopt.next();
      if (code === END_OF_OPTIONS) break;
      switch (code) {
        case 0x57: newKeyFile = optarg; break;
        case 0x6b: keyFile = optarg; break;
        case 0x70: keyProgram = optarg; break;
        case 0x66: force = true; break;
        case 0x72:
          randomKeyLength = atoi(optarg ?? '');
          if (randomKeyLength > MAX_RANDOM_KEY_LENGTH) fail('ERROR: keys larger than 64KiB are not supported');
          break;
        case 0x4b:
          out.eprintf('WARNING: specifying the actual key via the command line is highly insecure\nDo NOT use this for PRODUCTION use.\n');
          key = new TextEncoder().encode(optarg ?? '');
          break;
        case 0x61: algorithm = optarg ?? undefined; break;
        case 0x6d: mode = optarg ?? undefined; break;
        case 0x56:
          out.eprintf(`rscryutil ${RSCRYUTIL_VERSION}\n`);
          return finish(out, chunks, 0);
        default: break;
      }
    }
    if (randomKeyLength !== -1) key = host.randomBytes(randomKeyLength);
    else if (keyFile !== null) {
      const file = host.readBytes(keyFile);
      if ('error' in file) {
        out.eprintf(`${keyFile}: ${file.error}\n`);
        throw new ExitSignal(1);
      }
      if (file.bytes.length > MAX_KEY_FILE_LENGTH) {
        out.eprintf(`${keyFile}: Message too long\n`);
        throw new ExitSignal(1);
      }
      if (file.bytes.length === 0) {
        out.eprintf(`${keyFile}: Invalid argument\n`);
        throw new ExitSignal(1);
      }
      key = file.bytes;
    } else if (keyProgram !== null) {
      const result = parseKeyProgramOutput(host.runKeyProgram(keyProgram));
      key = 'bytes' in result ? result.bytes : key;
    }
    if (key === null) return fail('ERROR: key must be set via some method');
    const resolved = CryptoCipher.resolve(provider, algorithm, mode);
    if ('failure' in resolved) {
      if (provider === 'ossl') return fail(`ERROR: cipher "${algorithm}" is not known/supported`);
      if (resolved.failure === 'algo') return fail(`ERROR: algorithm "${algorithm}" is not known/supported`);
      return fail(`ERROR: cipher mode "${mode}" is not known/supported`);
    }
    const cipher = CryptoCipher.create(provider, resolved.suite, key as Uint8Array);
    if (newKeyFile !== null) {
      if (getopt.optind !== getopt.argv.length) fail('ERROR: no file parameters permitted in --write-keyfile mode');
      const failure = host.createKeyFile(newKeyFile, key as Uint8Array, force);
      if (failure !== null) {
        out.eprintf(`error opening keyfile ${newKeyFile}: ${failure}\n`);
        throw new ExitSignal(1);
      }
    } else if (getopt.optind === getopt.argv.length) decryptFile('-', cipher);
    else for (let index = getopt.optind; index < getopt.argv.length; index++) decryptFile(getopt.argv[index], cipher);
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
    exitCode = error.code;
  }
  return finish(out, chunks, exitCode);
}

function finish(out: ToolOutput, chunks: Uint8Array[], exitCode: number): ToolResult {
  const decoder = new TextDecoder('utf-8');
  const merged = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    merged.set(chunk, at);
    at += chunk.length;
  }
  if (merged.length > 0) out.printf(decoder.decode(merged));
  return { stdout: out.stdout, stderr: out.stderr, exitCode, interleaved: out.interleaved };
}
