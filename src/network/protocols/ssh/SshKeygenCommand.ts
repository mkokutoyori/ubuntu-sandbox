import {
  KEYGEN_ALGORITHMS,
  isFingerprintHash,
  keygenPair,
  keygenDigest,
  keygenFingerprint,
  keygenPublicOf,
  keygenRandomart,
} from '@/network/devices/linux/network/SshKeygenMaterial';
import { SshKnownHostEntry } from '@/network/devices/linux/network/SshKnownHostEntry';
import { bsdGetoptDiagnostic, shortOptions } from '@/network/devices/linux/commands/Getopt';
import type { OpenSshRelease } from './OpenSshRelease';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

export interface SshKeygenStore {
  read(path: string): string | null;
  write(path: string, content: string, secret: boolean): string | null;
  isDirectory(path: string): boolean;
  makePrivateDirectory(path: string): void;
}

export interface SshKeygenHost {
  readonly store: SshKeygenStore;
  readonly separator: string;
  readonly sshDir: string;
  readonly hostKeyDir: string;
  readonly user: string;
  readonly hostname: string;
  readonly release: OpenSshRelease;
}

export interface SshKeygenOutcome {
  readonly output: string;
  readonly exitCode: number;
}

export interface SshKeygenTerminal {
  print(line: string): void;
  ask(prompt: string, hidden: boolean): Promise<string | null>;
}

type KeygenStep =
  | { readonly kind: 'print'; readonly line: string }
  | { readonly kind: 'ask'; readonly prompt: string; readonly hidden: boolean };

type KeygenDialogue = Generator<KeygenStep, number, string | null | undefined>;

const KEYGEN_OPTSTRING = '+ABHKLQUXceghiklopquvyC:D:E:F:I:M:N:O:P:R:V:Y:Z:a:b:f:g:m:n:r:s:t:w:z:';

export const DEFAULT_KEYGEN_TYPE = 'rsa';

const RSA_MINIMUM_BITS = 1024;
const RSA_MAXIMUM_BITS = 16384;
const ECDSA_LENGTHS: readonly number[] = [256, 384, 521];
const UINT32_MAX = 0xffffffff;
const INT_MAX = 0x7fffffff;

const UNSIMULATED_OPTIONS: Readonly<Record<string, string>> = {
  B: 'bubblebabble digests',
  c: 'changing the comment of a private key',
  D: 'PKCS#11 tokens',
  e: 'exporting keys',
  g: 'generic DNS resource records',
  H: 'hashing known_hosts',
  h: 'host certificates',
  I: 'certificates',
  i: 'importing keys',
  K: 'FIDO authenticators',
  k: 'key revocation lists',
  L: 'certificates',
  M: 'DH moduli',
  m: 'PEM, PKCS8 and RFC4716 key formats',
  n: 'certificates',
  O: 'key generation options',
  P: 'passphrase-protected private keys',
  p: 'passphrase-protected private keys',
  Q: 'key revocation lists',
  r: 'DNS resource records',
  s: 'certificates',
  U: 'certificates',
  u: 'key revocation lists',
  V: 'certificates',
  w: 'FIDO authenticators',
  X: 'importing keys',
  Y: 'signatures',
  Z: 'passphrase-protected private keys',
  z: 'certificates',
};

const DEFAULT_FILE_NAMES: Readonly<Record<string, string>> = {
  ed25519: 'id_ed25519',
  rsa: 'id_rsa',
  ecdsa: 'id_ecdsa',
};

interface KeygenRequest {
  readonly all: boolean;
  readonly bits?: number;
  readonly comment?: string;
  readonly file?: string;
  readonly findHost?: string;
  readonly deleteHost?: string;
  readonly fingerprint: boolean;
  readonly hash: string;
  readonly passphrase?: string;
  readonly printPublic: boolean;
  readonly quiet: boolean;
  readonly type?: string;
  readonly verbose: boolean;
}

function join(host: SshKeygenHost, ...parts: string[]): string {
  return parts.join(host.separator);
}

function directoryOf(host: Pick<SshKeygenHost, 'separator'>, path: string): string {
  const cut = path.lastIndexOf(host.separator);
  return cut <= 0 ? '' : path.slice(0, cut);
}

export function defaultKeygenFile(
  host: Pick<SshKeygenHost, 'separator' | 'sshDir'>,
  type: string,
): string {
  return [host.sshDir, DEFAULT_FILE_NAMES[type.toLowerCase()] ?? DEFAULT_FILE_NAMES[DEFAULT_KEYGEN_TYPE]].join(host.separator);
}

export function knownHostsPathOf(host: SshKeygenHost): string {
  return join(host, host.sshDir, 'known_hosts');
}

function strtonum(text: string, max: number): { value: number } | { error: string } {
  if (!/^\s*[-+]?\d+$/.test(text)) return { error: 'invalid' };
  const value = Number.parseInt(text, 10);
  if (value < 1) return { error: 'too small' };
  if (value > max) return { error: 'too large' };
  return { value };
}

function parseRequest(args: readonly string[], release: OpenSshRelease): KeygenRequest | SshKeygenOutcome {
  const usage = (lead: string): SshKeygenOutcome => ({ output: `${lead}\n${release.keygenUsage}`, exitCode: 1 });
  const request: { -readonly [K in keyof KeygenRequest]: KeygenRequest[K] } = {
    all: false, fingerprint: false, hash: 'sha256', printPublic: false, quiet: false, verbose: false,
  };
  for (const option of shortOptions(args, KEYGEN_OPTSTRING)) {
    if (option.kind === 'operand') return usage('Too many arguments.');
    if (option.kind === 'invalid' || option.kind === 'missing-argument') return usage(bsdGetoptDiagnostic(option));
    if (option.kind !== 'option') continue;
    const value = option.argument ?? '';
    const unsimulated = UNSIMULATED_OPTIONS[option.letter];
    if (unsimulated !== undefined) {
      return { output: `ssh-keygen: -${option.letter}: ${unsimulated} are not simulated`, exitCode: 255 };
    }
    switch (option.letter) {
      case 'A': request.all = true; break;
      case 'b': {
        const parsed = strtonum(value, UINT32_MAX);
        if ('error' in parsed) return { output: `Bits has bad value ${value} (${parsed.error})`, exitCode: 255 };
        request.bits = parsed.value;
        break;
      }
      case 'a': {
        const parsed = strtonum(value, INT_MAX);
        if ('error' in parsed) return { output: `Invalid number: ${value} (${parsed.error})`, exitCode: 255 };
        break;
      }
      case 'E':
        if (!isFingerprintHash(value)) return { output: `Invalid hash algorithm "${value}"`, exitCode: 255 };
        request.hash = value;
        break;
      case 'C': request.comment = value; break;
      case 'F': request.findHost = value; break;
      case 'R': request.deleteHost = value; break;
      case 'f': request.file = value; break;
      case 'l': request.fingerprint = true; break;
      case 'N': request.passphrase = value; break;
      case 'q': request.quiet = true; break;
      case 't': request.type = value; break;
      case 'v': request.verbose = true; break;
      case 'y': request.printPublic = true; break;
    }
  }
  if (request.fingerprint && request.deleteHost !== undefined) return usage('Cannot use -l with -H or -R.');
  return request;
}

function bitsProblem(type: string, bits: number | undefined): string | null {
  if (bits === undefined) return null;
  if (type === 'rsa') {
    if (bits < RSA_MINIMUM_BITS) return `Invalid RSA key length: minimum is ${RSA_MINIMUM_BITS} bits`;
    if (bits > RSA_MAXIMUM_BITS) return `Invalid RSA key length: maximum is ${RSA_MAXIMUM_BITS} bits`;
  }
  if (type === 'ecdsa') {
    if (!ECDSA_LENGTHS.includes(bits)) return 'Invalid ECDSA key length: valid lengths are 256, 384 or 521 bits';
    if (bits !== 256) return `ssh-keygen: ECDSA ${bits}-bit keys are not simulated (nistp${bits})`;
  }
  return null;
}

function print(line: string): KeygenStep {
  return { kind: 'print', line };
}

function* askFile(host: SshKeygenHost, prompt: string, type: string): Generator<KeygenStep, string | null, string | null | undefined> {
  const fallback = defaultKeygenFile(host, type);
  const answer = yield { kind: 'ask', prompt: `${prompt} (${fallback}): `, hidden: false };
  if (answer === null || answer === undefined) return null;
  return answer === '' ? fallback : answer;
}

function* askPassphrase(): Generator<KeygenStep, string, string | null | undefined> {
  for (;;) {
    const first = (yield { kind: 'ask', prompt: 'Enter passphrase (empty for no passphrase): ', hidden: true }) ?? '';
    const second = (yield { kind: 'ask', prompt: 'Enter same passphrase again: ', hidden: true }) ?? '';
    if (first === second) return first;
    yield print('Passphrases do not match.  Try again.');
  }
}

function* knownHostsDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  const knownHosts = request.file ?? knownHostsPathOf(host);
  if (request.findHost !== undefined) {
    const wanted = request.findHost;
    const entries = SshKnownHostEntry.parseFile(host.store.read(knownHosts) ?? '');
    let found = false;
    for (const [index, entry] of entries.entries()) {
      if (!entry.matches(wanted)) continue;
      found = true;
      yield print(`# Host ${wanted} found: line ${index + 1}`);
      yield print(entry.toLine());
    }
    return found ? 0 : 1;
  }
  const wanted = request.deleteHost ?? '';
  const before = SshKnownHostEntry.parseFile(host.store.read(knownHosts) ?? '');
  const after = before.filter(e => !e.matches(wanted));
  const failure = host.store.write(knownHosts, SshKnownHostEntry.serializeFile(after), false);
  if (failure !== null) {
    yield print(`Unable to write ${knownHosts}`);
    return 1;
  }
  yield print(`# Host ${wanted} found: line 1`);
  yield print(`${knownHosts} updated.`);
  yield print(`Original contents retained as ${knownHosts}.old`);
  return 0;
}

function* fingerprintDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  const target = request.file ?? (yield* askFile(host, 'Enter file in which the key is', request.type ?? DEFAULT_KEYGEN_TYPE));
  if (target === null) return 1;
  const candidate = target.endsWith('.pub') ? target : `${target}.pub`;
  const data = (host.store.read(candidate) ?? host.store.read(target) ?? '').trim();
  if (!data) {
    yield print(`ssh-keygen: ${target}: No such file or directory`);
    return 255;
  }
  yield print(keygenFingerprint(data, request.hash) ?? '');
  if (request.verbose) {
    for (const line of keygenRandomart(data, request.hash).split('\n')) yield print(line);
  }
  return 0;
}

function* printPublicDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  const source = request.file ?? (yield* askFile(host, 'Enter file in which the key is', request.type ?? DEFAULT_KEYGEN_TYPE));
  if (source === null) return 1;
  const material = host.store.read(source);
  if (material === null) {
    yield print(`${source}: No such file or directory`);
    return 255;
  }
  const derived = keygenPublicOf(material);
  if (derived === null) {
    yield print(`Load key "${source}": invalid format`);
    return 255;
  }
  yield print(derived);
  return 0;
}

function allHostKeys(request: KeygenRequest, host: SshKeygenHost): number {
  const dir = (request.file ?? host.hostKeyDir).replace(/[/\\]$/, '');
  for (const type of ['ed25519', 'rsa', 'ecdsa']) {
    const privatePath = join(host, dir, `ssh_host_${type}_key`);
    if ((host.store.read(privatePath) ?? '') !== '') continue;
    const pair = keygenPair(KEYGEN_ALGORITHMS[type]!, `root@${host.hostname}`);
    host.store.write(privatePath, pair.priv, true);
    host.store.write(`${privatePath}.pub`, `${pair.pub}\n`, false);
  }
  return 0;
}

function* generationDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  const requested = request.type ?? DEFAULT_KEYGEN_TYPE;
  const type = requested.toLowerCase();
  const algorithm = KEYGEN_ALGORITHMS[type];
  if (algorithm === undefined) {
    yield print(`unknown key type ${requested}`);
    return 255;
  }
  const problem = bitsProblem(type, request.bits);
  if (problem !== null) {
    yield print(problem);
    return 255;
  }
  if (!request.quiet) yield print(`Generating public/private ${requested} key pair.`);
  const file = request.file ?? (yield* askFile(host, 'Enter file in which to save the key', type));
  if (file === null) return 1;
  if (directoryOf(host, file) === host.sshDir && !host.store.isDirectory(host.sshDir)) {
    host.store.makePrivateDirectory(host.sshDir);
    if (!request.quiet) yield print(`Created directory '${host.sshDir}'.`);
  }
  if (host.store.read(file) !== null) {
    yield print(`${file} already exists.`);
    const answer = yield { kind: 'ask', prompt: 'Overwrite (y/n)? ', hidden: false };
    if (!answer || (answer[0] !== 'y' && answer[0] !== 'Y')) return 1;
  }
  const passphrase = request.passphrase ?? (yield* askPassphrase());
  if (passphrase !== '') {
    yield print(`ssh-keygen: ${UNSIMULATED_OPTIONS.p} are not simulated`);
    return 255;
  }
  const comment = request.comment ?? `${host.user}@${host.hostname}`;
  const pair = keygenPair(algorithm, comment, request.bits);
  const privateFailure = host.store.write(file, pair.priv, true);
  if (privateFailure !== null) {
    yield print(`Saving key "${file}" failed: ${privateFailure}`);
    return 1;
  }
  if (!request.quiet) yield print(`Your identification has been saved in ${file}`);
  const publicFailure = host.store.write(`${file}.pub`, `${pair.pub}\n`, false);
  if (publicFailure !== null) {
    yield print(`Unable to save public key to ${file}.pub: ${publicFailure}`);
    return 255;
  }
  if (request.quiet) return 0;
  yield print(`Your public key has been saved in ${file}.pub`);
  yield print('The key fingerprint is:');
  yield print(`${keygenDigest(pair.pub, request.hash)} ${comment}`);
  yield print("The key's randomart image is:");
  for (const line of keygenRandomart(pair.pub, request.hash).split('\n')) yield print(line);
  return 0;
}

function* keygenDialogue(args: readonly string[], host: SshKeygenHost): KeygenDialogue {
  const request = parseRequest(args, host.release);
  if ('exitCode' in request) {
    for (const line of request.output.split('\n')) yield print(line);
    return request.exitCode;
  }
  if (request.deleteHost !== undefined || request.findHost !== undefined) return yield* knownHostsDialogue(request, host);
  if (request.fingerprint) return yield* fingerprintDialogue(request, host);
  if (request.printPublic) return yield* printPublicDialogue(request, host);
  if (request.all) return allHostKeys(request, host);
  return yield* generationDialogue(request, host);
}

function typedLines(stdin: string | undefined): string[] | null {
  if (stdin === undefined) return null;
  const lines = stdin.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function runSshKeygenCommand(
  args: readonly string[], host: SshKeygenHost, stdin?: string,
): SshKeygenOutcome {
  const typed = typedLines(stdin);
  const dialogue = keygenDialogue(args, host);
  let transcript = '';
  let answer: string | null | undefined;
  for (;;) {
    const step = dialogue.next(answer);
    if (step.done === true) return { output: transcript.replace(/\n$/, ''), exitCode: step.value };
    answer = undefined;
    if (step.value.kind === 'print') {
      transcript += `${step.value.line}\n`;
      continue;
    }
    transcript += step.value.prompt;
    if (typed === null) {
      transcript += '\n';
      answer = '';
      continue;
    }
    answer = typed.length > 0 ? typed.shift()! : null;
  }
}

export async function runSshKeygenInteractive(
  args: readonly string[], host: SshKeygenHost, terminal: SshKeygenTerminal,
): Promise<number> {
  const dialogue = keygenDialogue(args, host);
  let answer: string | null | undefined;
  for (;;) {
    const step = dialogue.next(answer);
    if (step.done === true) return step.value;
    answer = undefined;
    if (step.value.kind === 'print') terminal.print(step.value.line);
    else answer = await terminal.ask(step.value.prompt, step.value.hidden);
  }
}

export type KeygenVfs = Pick<
  VirtualFileSystem, 'readFile' | 'writeFile' | 'resolveInode' | 'mkdirp' | 'normalizePath' | 'checkAccess'
>;

export interface KeygenIdentity {
  readonly uid: number;
  readonly gid: number;
  readonly user: string;
  readonly hostname: string;
  readonly sshDir: string;
  readonly cwd: string;
  readonly hostKeyDir?: string;
  readonly release: OpenSshRelease;
}

function writeFailureReason(vfs: KeygenVfs, target: string, identity: KeygenIdentity): string {
  const components = target.split('/').filter(Boolean).slice(0, -1);
  let path = '';
  for (const component of components) {
    const directory = vfs.resolveInode(path || '/');
    if (directory && !vfs.checkAccess(directory, 'x', identity.uid, identity.gid)) return 'Permission denied';
    path += `/${component}`;
    if (!vfs.resolveInode(path)) return 'No such file or directory';
  }
  return 'Permission denied';
}

export function vfsKeygenHost(vfs: KeygenVfs, identity: KeygenIdentity): SshKeygenHost {
  const absolute = (path: string) => vfs.normalizePath(path, identity.cwd);
  return {
    store: {
      read: (path: string) => vfs.readFile(absolute(path)),
      write: (path: string, content: string, secret: boolean) => {
        const target = absolute(path);
        if (vfs.writeFile(target, content, identity.uid, identity.gid, secret ? 0o077 : 0o022, false, undefined, false)) {
          return null;
        }
        return writeFailureReason(vfs, target, identity);
      },
      isDirectory: (path: string) => vfs.resolveInode(absolute(path))?.type === 'directory',
      makePrivateDirectory: (path: string) => {
        vfs.mkdirp(absolute(path), 0o700, identity.uid, identity.gid);
      },
    },
    separator: '/',
    sshDir: identity.sshDir,
    hostKeyDir: identity.hostKeyDir ?? '/etc/ssh',
    user: identity.user,
    hostname: identity.hostname,
    release: identity.release,
  };
}
