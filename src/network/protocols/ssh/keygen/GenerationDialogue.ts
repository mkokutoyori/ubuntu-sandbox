import {
  KEYGEN_ALGORITHMS,
  keygenAlgorithmFor,
  keygenDigest,
  keygenPair,
  keygenRandomart,
  sshKeyTypeLabel,
} from '@/network/devices/linux/network/SshKeygenMaterial';
import { enrollSecurityKeyDialogue, isSecurityKeyType } from './TokenDialogues';
import { askFile, askNewPassphrase, privateFormatOf } from './KeyFileDialogues';
import { directoryOf, print, type KeygenDialogue, type KeygenRequest, type SshKeygenHost } from './KeygenTypes';

export const DEFAULT_KEYGEN_TYPE = 'rsa';

const RSA_MINIMUM_BITS = 1024;
const RSA_MAXIMUM_BITS = 16384;
const ECDSA_LENGTHS: readonly number[] = [256, 384, 521];
const HOST_KEY_TYPES = ['rsa', 'ecdsa', 'ed25519'];

function bitsProblem(type: string, bits: number | undefined): string | null {
  if (bits === undefined) return null;
  if (type === 'rsa') {
    if (bits < RSA_MINIMUM_BITS) return `Invalid RSA key length: minimum is ${RSA_MINIMUM_BITS} bits`;
    if (bits > RSA_MAXIMUM_BITS) return `Invalid RSA key length: maximum is ${RSA_MAXIMUM_BITS} bits`;
  }
  if (type === 'ecdsa' && !ECDSA_LENGTHS.includes(bits)) {
    return 'Invalid ECDSA key length: valid lengths are 256, 384 or 521 bits';
  }
  return null;
}

function samePath(left: string, right: string): boolean {
  return left.replace(/\\/g, '/') === right.replace(/\\/g, '/');
}

export function* generationDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  const requested = request.type ?? DEFAULT_KEYGEN_TYPE;
  const type = requested.toLowerCase();
  if (isSecurityKeyType(type)) {
    if (!request.quiet) yield print(`Generating public/private ${requested} key pair.`);
    return yield* enrollSecurityKeyDialogue(request, host);
  }
  const algorithm = keygenAlgorithmFor(type, request.bits);
  if (KEYGEN_ALGORITHMS[type] === undefined || algorithm === undefined) {
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
  if (samePath(directoryOf(file), host.sshDir) && !host.store.isDirectory(host.sshDir)) {
    host.store.makePrivateDirectory(host.sshDir);
    if (!request.quiet) yield print(`Created directory '${host.sshDir}'.`);
  }
  if (host.store.read(file) !== null) {
    yield print(`${file} already exists.`);
    const answer = yield { kind: 'ask', prompt: 'Overwrite (y/n)? ', hidden: false };
    if (!answer || (answer[0] !== 'y' && answer[0] !== 'Y')) return 1;
  }
  const passphrase = request.newPassphrase ?? (yield* askNewPassphrase());
  const comment = request.comment ?? `${host.user}@${host.hostname}`;
  const format = privateFormatOf(request);
  const pair = keygenPair(algorithm, comment, request.bits, passphrase === '' && format === undefined
    ? undefined
    : { passphrase, cipher: request.keyCipher, rounds: request.rounds, format });
  const privateFailure = host.store.write(file, pair.priv, true);
  if (privateFailure !== null) {
    yield print(`Saving key "${file}" failed: ${privateFailure}`);
    return 1;
  }
  if (!request.quiet) yield print(`Your identification has been saved in ${file}`);
  const publicFailure = host.store.write(`${file}.pub`, `${pair.pub}\n`, false);
  if (publicFailure !== null) {
    yield print(`Unable to save public key to ${file}.pub: ${publicFailure}`);
    return 1;
  }
  if (request.quiet) return 0;
  yield print(`Your public key has been saved in ${file}.pub`);
  yield print('The key fingerprint is:');
  yield print(`${keygenDigest(pair.pub, request.hash)} ${comment}`);
  yield print("The key's randomart image is:");
  for (const line of keygenRandomart(pair.pub, request.hash).split('\n')) yield print(line);
  return 0;
}

export function* allHostKeysDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  const directory = `${request.file ?? ''}${host.hostKeyDir}`.replace(/[/\\]$/, '');
  const generated: string[] = [];
  const problems: string[] = [];
  for (const type of HOST_KEY_TYPES) {
    const privatePath = `${directory}/ssh_host_${type}_key`;
    if (host.store.read(privatePath) !== null) continue;
    const label = sshKeyTypeLabel(KEYGEN_ALGORITHMS[type]);
    generated.push(label);
    const pair = keygenPair(KEYGEN_ALGORITHMS[type], `${host.user}@${host.hostname}`);
    const privateFailure = host.store.write(privatePath, pair.priv, true);
    if (privateFailure !== null) {
      problems.push(`Could not save your private key in ${privatePath}: ${privateFailure}`);
      continue;
    }
    const publicFailure = host.store.write(`${privatePath}.pub`, `${pair.pub}\n`, false);
    if (publicFailure !== null) problems.push(`Could not save your public key in ${privatePath}.pub: ${publicFailure}`);
  }
  if (generated.length > 0) yield print(`ssh-keygen: generating new host keys: ${generated.map((label) => `${label} `).join('')}`);
  for (const problem of problems) yield print(problem);
  return problems.length === 0 ? 0 : 255;
}
