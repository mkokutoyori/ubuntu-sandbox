import type { Direction } from '@/crypto/cipher/blockModes';
import { createModeTransform } from '@/crypto/cipher/blockModes';
import { ENC_SUITES, encAlgorithmNamed } from '@/network/crypto/openssl/OpenSslEnc';
import type { FileHandle, OpenFileOptions, RsyslogFiles } from '../engine/Host';
import { latin1Bytes } from '../engine/Latin1';
import { removeProviderPadding } from './Padding';
import { RS_RET } from '../engine/Log';
import {
  EncryptionInfoReader, encryptionInfoPath, endRecord, fileTypeRecord, hasFileType, ivRecord,
} from './EncryptionInfo';
import {
  gcryptAlgorithmNamed, gcryptModeNamed, openGcryptSession, type GcryptAlgorithm, type GcryptMode, type GcryptSession,
} from './GcryptSuite';

export type CryptoProviderName = 'gcry' | 'ossl';
export const MAX_KEY_LENGTH = 64 * 1024;
const KEY_PROGRAM_HEADER = 'RSYSLOG-KEY-PROVIDER:0';

export interface KeyProgramOutput {
  readonly output: string;
  readonly exitCode: number;
}

export interface CryptoEnvironment {
  readonly files: RsyslogFiles;
  random(): number;
  runKeyProgram(program: string): KeyProgramOutput | null;
  report(text: string, code: number): void;
}

export interface CryptoParameters {
  get(name: 'key' | 'keyfile' | 'keyprogram' | 'mode' | 'algo'): string | undefined;
}

export interface CipherSession {
  transform(data: Uint8Array): { readonly data: Uint8Array; readonly failed: boolean };
}

interface CipherSuite {
  readonly blockSize: number;
  readonly keyLength: number;
  readonly ivLength: number;
  open(key: Uint8Array, iv: Uint8Array, direction: Direction): CipherSession | { readonly failure: 'open' | 'setkey' };
}

const ENCINFO_OPTIONS: OpenFileOptions = {
  mode: 0o600, directoryMode: 0o755, uid: null, gid: null, directoryUid: null, directoryGid: null, createDirectories: false, failOnChownFailure: false,
};

export function readKeyFile(files: RsyslogFiles, path: string): { readonly bytes: Uint8Array } | { readonly error: string } {
  const opened = files.openRead(path);
  if ('error' in opened) return { error: opened.error };
  const size = files.statSize(path) ?? 0;
  const text = opened.file.read(0, size);
  opened.file.close();
  if (size > MAX_KEY_LENGTH) return { error: 'Message too long' };
  if (size === 0) return { error: 'Invalid argument' };
  return { bytes: latin1Bytes(text) };
}

export function parseKeyProgramOutput(result: KeyProgramOutput | null): { readonly bytes: Uint8Array } | { readonly code: number } {
  if (result === null) return { code: 1 };
  const lines = result.output.split('\n');
  if (lines.length < 2) return { code: 1 };
  if (lines[0] !== KEY_PROGRAM_HEADER) return { code: 2 };
  if (!/^[+-]?\d+$/.test(lines[1]) || Number(lines[1]) <= 0 || Number(lines[1]) > MAX_KEY_LENGTH) return { code: 3 };
  const length = Number(lines[1]);
  const body = result.output.slice(lines[0].length + lines[1].length + 2);
  return body.length < length ? { code: 1 } : { bytes: latin1Bytes(body.slice(0, length)) };
}

function gcryptSuite(algorithm: GcryptAlgorithm, mode: GcryptMode): CipherSuite {
  return {
    blockSize: algorithm.blockSize,
    keyLength: algorithm.keyLength,
    ivLength: algorithm.blockSize,
    open: (key, iv, direction) => {
      const session = openGcryptSession(algorithm, mode, key, iv, direction);
      return 'failure' in session ? session : { transform: (data) => (session as GcryptSession).transform(data) };
    },
  };
}

function opensslSuite(name: string): CipherSuite | undefined {
  const resolved = encAlgorithmNamed(name.toLowerCase());
  const suite = resolved === undefined ? undefined : ENC_SUITES[resolved];
  if (suite === undefined) return undefined;
  const streamLike = suite.mode !== 'ecb' && suite.mode !== 'cbc';
  const blockSize = streamLike ? 1 : suite.family.blockSize;
  return {
    blockSize,
    keyLength: suite.keyLength,
    ivLength: blockSize,
    open: (key, iv, direction) => {
      const full = new Uint8Array(suite.family.blockSize);
      full.set(iv.subarray(0, Math.min(iv.length, full.length)));
      const engine = createModeTransform(suite.mode, suite.family.create(key), direction, full);
      return { transform: (data) => ({ data: engine.update(data), failed: false }) };
    },
  };
}

export class CryptoCipher {
  private constructor(readonly name: CryptoProviderName, private readonly suite: CipherSuite, private readonly key: Uint8Array) {}

  static resolve(
    name: CryptoProviderName, algorithmName: string | undefined, modeName: string | undefined,
  ): { readonly suite: CipherSuite } | { readonly failure: 'algo' | 'mode' } {
    if (name === 'ossl') {
      const found = opensslSuite(algorithmName ?? 'aes-128-cbc');
      return found === undefined ? { failure: 'algo' } : { suite: found };
    }
    const algorithm = algorithmName === undefined ? gcryptAlgorithmNamed('AES128') : gcryptAlgorithmNamed(algorithmName);
    if (algorithm === undefined) return { failure: 'algo' };
    const mode = modeName === undefined ? 'cbc' : gcryptModeNamed(modeName);
    return mode === undefined ? { failure: 'mode' } : { suite: gcryptSuite(algorithm, mode) };
  }

  static create(name: CryptoProviderName, suite: CipherSuite, key: Uint8Array): CryptoCipher {
    return new CryptoCipher(name, suite, key);
  }

  get blockSize(): number {
    return this.suite.blockSize;
  }

  get keyLength(): number {
    return this.suite.keyLength;
  }

  seedIv(random: () => number): Uint8Array {
    const iv = new Uint8Array(this.suite.blockSize);
    let value = 0;
    for (let index = 0; index < iv.length; index++) {
      const shift = (index % 4) * 8;
      if (shift === 0) value = Math.floor(random() * 0x7fffffff);
      iv[index] = (value >>> shift) & 0xff;
    }
    return iv;
  }

  open(iv: Uint8Array, direction: Direction): CipherSession | { readonly failure: 'open' | 'setkey' } {
    return this.suite.open(this.key, iv, direction);
  }
}

export class CryptoProvider {
  private constructor(readonly cipher: CryptoCipher, readonly environment: CryptoEnvironment) {}

  get name(): CryptoProviderName {
    return this.cipher.name;
  }

  static configure(name: CryptoProviderName, parameters: CryptoParameters, environment: CryptoEnvironment): CryptoProvider | null {
    const algorithmName = parameters.get('algo');
    const modeName = name === 'gcry' ? parameters.get('mode') : undefined;
    const suite = CryptoCipher.resolve(name, algorithmName, modeName);
    if ('failure' in suite) {
      if (suite.failure === 'algo') environment.report(`cry.algo '${algorithmName}' is not know/supported`, RS_RET.CRY_INVLD_ALGO);
      else environment.report(`cry.mode '${modeName}' is not know/supported`, RS_RET.CRY_INVLD_MODE);
      return null;
    }
    const keyParameters = name === 'gcry' ? ['key', 'keyfile', 'keyprogram'] as const : ['key', 'keyfile'] as const;
    const given = keyParameters.filter((parameter) => parameters.get(parameter) !== undefined);
    if (given.length !== 1) {
      environment.report(
        `excactly one of the following parameters can be specified: ${keyParameters.map((parameter) => `cry.${parameter}`).join(', ')}\n`,
        RS_RET.INVALID_PARAMS,
      );
      return null;
    }
    const key = CryptoProvider.obtainKey(given[0], parameters, environment);
    if (key === null) return null;
    if (key.length !== suite.suite.keyLength) {
      environment.report(`Key length ${suite.suite.keyLength} expected, but key of length ${key.length} given`, RS_RET.INVALID_PARAMS);
      return null;
    }
    return new CryptoProvider(CryptoCipher.create(name, suite.suite, key), environment);
  }

  private static obtainKey(source: 'key' | 'keyfile' | 'keyprogram', parameters: CryptoParameters, environment: CryptoEnvironment): Uint8Array | null {
    const value = parameters.get(source) as string;
    if (source === 'key') {
      environment.report('Note: specifying an actual key directly from the config file is highly insecure - DO NOT USE FOR PRODUCTION', RS_RET.ERR);
      return new TextEncoder().encode(value);
    }
    if (source === 'keyfile') {
      const key = readKeyFile(environment.files, value);
      if ('error' in key) {
        environment.report(`error reading keyfile ${value}: ${key.error}`, RS_RET.ERR);
        return null;
      }
      return key.bytes;
    }
    const key = parseKeyProgramOutput(environment.runKeyProgram(value));
    if ('code' in key) {
      environment.report(`error ${key.code} obtaining key from program ${value}\n`, RS_RET.ERR);
      return null;
    }
    return key.bytes;
  }

  openFile(logFile: string, mode: 'w' | 'r'): CryptoFile | { readonly error: string; readonly code: number } {
    return CryptoFile.open(this, logFile, mode);
  }

  deleteStateFiles(logFile: string): void {
    this.environment.files.remove(encryptionInfoPath(logFile));
  }
}

const OPEN_FAILURE = 'Encryption ProviderError: cannot open .encinfo file - disabling log file';

export class CryptoFile {
  deleteOnClose = false;
  private session: CipherSession | null = null;
  private info: FileHandle | null = null;
  private bytesToBlockEnd = 0;
  private infoOffset = 0;

  private constructor(
    private readonly provider: CryptoProvider,
    private readonly logFile: string,
    private readonly mode: 'w' | 'r',
  ) {}

  static open(provider: CryptoProvider, logFile: string, mode: 'w' | 'r'): CryptoFile | { readonly error: string; readonly code: number } {
    const file = new CryptoFile(provider, logFile, mode);
    const code = file.beginBlock();
    if (code !== 0) {
      file.destroy(-1);
      provider.environment.report(OPEN_FAILURE, code);
      return { error: OPEN_FAILURE, code };
    }
    return file;
  }

  private get path(): string {
    return encryptionInfoPath(this.logFile);
  }

  private beginBlock(): number {
    const provider = this.provider;
    if (this.mode === 'r') return this.beginReadBlock();
    const iv = provider.cipher.seedIv(() => provider.environment.random());
    const session = provider.cipher.open(iv, 'encrypt');
    if ('failure' in session) return RS_RET.ERR;
    this.session = session;
    const files = provider.environment.files;
    const existing = files.read(this.path);
    if (existing === null) {
      const created = files.open(this.path, ENCINFO_OPTIONS);
      if ('error' in created) return RS_RET.EI_OPN_ERR;
      this.info = created.handle;
      if (this.info.write(fileTypeRecord()) !== null) return RS_RET.EI_WR_ERR;
    } else {
      if (!hasFileType(existing)) return RS_RET.EI_INVLD_FILE;
      const reopened = files.open(this.path, ENCINFO_OPTIONS);
      if ('error' in reopened) return RS_RET.EI_OPN_ERR;
      this.info = reopened.handle;
    }
    return this.info.write(ivRecord(iv)) === null ? 0 : RS_RET.EI_WR_ERR;
  }

  private beginReadBlock(): number {
    const provider = this.provider;
    const text = provider.environment.files.read(this.path);
    if (text === null) return RS_RET.EI_NO_EXISTS;
    const reader = new EncryptionInfoReader(text, this.infoOffset);
    if (this.infoOffset === 0 && !reader.skipFileType()) return RS_RET.EI_INVLD_FILE;
    const iv = reader.nextIv(provider.cipher.blockSize);
    if (iv === null) return RS_RET.ERR;
    const session = provider.cipher.open(iv, 'decrypt');
    if ('failure' in session) return RS_RET.ERR;
    this.session = session;
    const end = reader.nextEnd();
    this.bytesToBlockEnd = end.kind === 'end' ? end.offset : -1;
    this.infoOffset = reader.position;
    return 0;
  }

  encrypt(data: Uint8Array): Uint8Array {
    if (data.length === 0 || this.session === null) return data;
    const size = this.provider.cipher.blockSize;
    const padding = (size - (data.length % size)) % size;
    const padded = new Uint8Array(data.length + padding);
    padded.set(data);
    return this.session.transform(padded).data;
  }

  bytesLeftInBlock(): number | { readonly error: number } {
    if (this.bytesToBlockEnd === 0) {
      const code = this.beginReadBlock();
      if (code !== 0) return { error: code };
    }
    return this.bytesToBlockEnd;
  }

  decryptPadded(data: Uint8Array): Uint8Array {
    if (this.bytesToBlockEnd !== -1) this.bytesToBlockEnd -= data.length;
    if (this.session === null) return data;
    const result = this.session.transform(data);
    return result.failed ? data : result.data;
  }

  decrypt(data: Uint8Array): Uint8Array {
    const plain = this.decryptPadded(data);
    return plain === data ? data : removeProviderPadding(plain);
  }

  private destroy(offset: number): void {
    if (this.info !== null) {
      if (this.mode === 'w') this.info.write(endRecord(offset));
      this.info.close();
      this.info = null;
    }
    this.session = null;
    if (this.deleteOnClose) this.provider.environment.files.remove(this.path);
  }

  close(offset: number): void {
    this.destroy(offset);
  }
}
