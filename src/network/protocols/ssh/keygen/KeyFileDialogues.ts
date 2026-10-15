import { base64ToBytes, bytesToBase64 } from '@/crypto/encoding';
import {
  keygenBlobDigest,
  keygenBubblebabble,
  keygenKeyFacts,
  keygenKeyWithComment,
  keygenLoadPrivate,
  keygenPublicBlobOfFile,
  keygenPublicLineOf,
  keygenRandomart,
  keygenSerializePrivate,
  sshKeyTypeLabel,
  sshPublicKeyBlob,
  sshPublicKeyFromBlob,
  type SshPrivateKey,
  type SshPublicKey,
} from '@/network/devices/linux/network/SshKeygenMaterial';
import { sshfpRecords } from '../SshfpRecord';
import { publicKeyFromPkcs1, publicKeyFromSpki, pemArmour, pemBody, publicKeySpki, rsaPublicKeyPkcs1 } from './SshPublicKeyDer';
import { print, type KeygenDialogue, type KeygenRequest, type KeygenStep, type SshKeygenHost } from './KeygenTypes';

const DEFAULT_TYPE = 'rsa';
const RFC4716_BEGIN = '---- BEGIN SSH2 PUBLIC KEY ----';
const RFC4716_END = '---- END SSH2 PUBLIC KEY ----';
const HOST_KEY_FILES = ['rsa', 'ecdsa', 'ed25519'];

const DEFAULT_FILE_NAMES: Readonly<Record<string, string>> = {
  ed25519: 'id_ed25519',
  rsa: 'id_rsa',
  ecdsa: 'id_ecdsa',
};

export function defaultKeygenFile(host: SshKeygenHost, type: string): string {
  return `${host.sshDir}/${DEFAULT_FILE_NAMES[type.toLowerCase()] ?? DEFAULT_FILE_NAMES[DEFAULT_TYPE]}`;
}

export function* askFile(host: SshKeygenHost, prompt: string, type: string): Generator<KeygenStep, string | null, string | null | undefined> {
  const fallback = defaultKeygenFile(host, type);
  const answer = yield { kind: 'ask', prompt: `${prompt} (${fallback}): `, hidden: false };
  if (answer === null || answer === undefined) return null;
  return answer === '' ? fallback : answer;
}

export function* askNewPassphrase(): Generator<KeygenStep, string, string | null | undefined> {
  for (;;) {
    const first = (yield { kind: 'ask', prompt: 'Enter passphrase (empty for no passphrase): ', hidden: true }) ?? '';
    const second = (yield { kind: 'ask', prompt: 'Enter same passphrase again: ', hidden: true }) ?? '';
    if (first === second) return first;
    yield print('Passphrases do not match.  Try again.');
  }
}

const KEY_TYPE_LABEL = sshKeyTypeLabel;

function* ask(prompt: string): Generator<KeygenStep, string, string | null | undefined> {
  return (yield { kind: 'ask', prompt, hidden: true }) ?? '';
}

interface LoadedPrivate {
  readonly key: SshPrivateKey;
  readonly material: string;
  readonly passphrase: string;
}

type LoadOutcome =
  | { readonly kind: 'loaded'; readonly value: LoadedPrivate }
  | { readonly kind: 'failed'; readonly wrongPassphrase: boolean; readonly cipher?: string }
  | { readonly kind: 'format' };

function* loadPrivateKey(
  host: SshKeygenHost, material: string, givenPassphrase: string | undefined, promptText: string,
): Generator<KeygenStep, LoadOutcome, string | null | undefined> {
  const first = keygenLoadPrivate(material, '');
  if (first.kind === 'key') return { kind: 'loaded', value: { key: first.key, material, passphrase: '' } };
  if (first.kind === 'invalid-format') return { kind: 'format' };
  if (first.kind === 'unsupported-cipher') return { kind: 'failed', wrongPassphrase: false, cipher: first.cipher };
  const passphrase = givenPassphrase ?? (yield* ask(promptText));
  const second = keygenLoadPrivate(material, passphrase);
  if (second.kind === 'key') return { kind: 'loaded', value: { key: second.key, material, passphrase } };
  return { kind: 'failed', wrongPassphrase: true };
}

function failureText(outcome: Exclude<LoadOutcome, { kind: 'loaded' }>): string {
  if (outcome.kind === 'format') return 'invalid format';
  if (outcome.wrongPassphrase) return 'incorrect passphrase supplied to decrypt private key';
  return `unknown cipher: ${outcome.cipher ?? ''}`;
}

function publicLineOfPrivateText(text: string): string | null {
  const blob = keygenPublicBlobOfFile(text);
  if (blob === null) return null;
  const key = sshPublicKeyFromBlob(blob);
  if (key === null) return null;
  const loaded = keygenLoadPrivate(text, '');
  return `${key.algorithm} ${bytesToBase64(blob)}${loaded.kind === 'key' && loaded.key.comment !== '' ? ` ${loaded.key.comment}` : ''}`;
}

const PUBLIC_LINE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))\s+([A-Za-z0-9+/=]+)(?:\s+(.*))?$/;

function parsePublicLine(line: string): { line: string; comment: string } | null {
  const match = PUBLIC_LINE.exec(line.trim());
  if (match === null || sshPublicKeyFromBlob(base64ToBytes(match[2])) === null) return null;
  return { line: `${match[1]} ${match[2]}`, comment: match[3] ?? '' };
}

function publicKeyOfFile(host: SshKeygenHost, path: string): { line: string; comment: string } | null {
  const text = host.store.read(path);
  if (text !== null) {
    const direct = parsePublicLine(text.split('\n')[0] ?? '');
    if (direct !== null) return direct;
  }
  const sibling = host.store.read(`${path}.pub`);
  if (sibling !== null) {
    const parsed = parsePublicLine(sibling.split('\n')[0] ?? '');
    if (parsed !== null) return parsed;
  }
  if (text !== null) {
    const derived = publicLineOfPrivateText(text);
    if (derived !== null) {
      const parsed = parsePublicLine(derived);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function fingerprintLine(publicLine: string, comment: string, request: KeygenRequest): string | null {
  const facts = keygenKeyFacts(publicLine);
  const digest = request.bubblebabble ? keygenBubblebabble(publicLine) : keygenBlobDigest(publicLine.split(/\s+/)[1] ?? '', request.hash);
  if (digest === null) return null;
  return `${facts.bits} ${digest} ${comment === '' ? 'no comment' : comment} (${KEY_TYPE_LABEL(publicLine.split(/\s+/)[0])})`;
}

function* printFingerprint(publicLine: string, comment: string, request: KeygenRequest): KeygenDialogue {
  const line = fingerprintLine(publicLine, comment, request);
  if (line === null) return 255;
  yield print(line);
  if (request.verbose) {
    for (const art of keygenRandomart(publicLine, request.bubblebabble ? 'sha1' : request.hash).split('\n')) yield print(art);
  }
  return 0;
}

export function* fingerprintDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  const target = request.file ?? (yield* askFile(host, 'Enter file in which the key is', request.type ?? DEFAULT_TYPE));
  if (target === null) return 1;
  const text = host.store.read(target);
  const sibling = host.store.read(`${target}.pub`);
  if (text === null && sibling === null) {
    yield print(`ssh-keygen: ${target}: No such file or directory`);
    return 255;
  }
  const single = publicKeyOfFile(host, target);
  if (single !== null) return yield* printFingerprint(single.line, single.comment, request);
  let shown = 0;
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    let parsed = parsePublicLine(line);
    let comment = parsed?.comment ?? '';
    if (parsed === null) {
      const [field, ...rest] = line.split(/\s+/);
      parsed = parsePublicLine(rest.join(' '));
      comment = field;
    }
    if (parsed === null) continue;
    shown += 1;
    const status = yield* printFingerprint(parsed.line, comment, request);
    if (status !== 0) return status;
  }
  if (shown === 0) {
    yield print(`${target} is not a public key file.`);
    return 1;
  }
  return 0;
}

export function* printPublicDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  const source = request.file ?? (yield* askFile(host, 'Enter file in which the key is', request.type ?? DEFAULT_TYPE));
  if (source === null) return 1;
  const material = host.store.read(source);
  if (material === null) {
    yield print(`${source}: No such file or directory`);
    return 255;
  }
  const loaded = yield* loadPrivateKey(host, material, request.oldPassphrase, 'Enter passphrase: ');
  if (loaded.kind !== 'loaded') {
    yield print(`Load key "${source}": ${failureText(loaded)}`);
    return 255;
  }
  yield print(keygenPublicLineOf(loaded.value.key));
  return 0;
}

function protectionFor(request: KeygenRequest, passphrase: string) {
  return { passphrase, cipher: request.keyCipher, rounds: request.rounds };
}

export function* changePassphraseDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  const file = request.file ?? (yield* askFile(host, 'Enter file in which the key is', request.type ?? DEFAULT_TYPE));
  if (file === null) return 1;
  const material = host.store.read(file);
  if (material === null) {
    yield print(`ssh-keygen: ${file}: No such file or directory`);
    return 255;
  }
  const loaded = yield* loadPrivateKey(host, material, request.oldPassphrase, 'Enter old passphrase: ');
  if (loaded.kind === 'format') {
    yield print(`Cannot load private key "${file}": invalid format`);
    return 1;
  }
  if (loaded.kind === 'failed') {
    yield print(loaded.wrongPassphrase ? 'Bad passphrase.' : `Failed to load key "${file}": ${failureText(loaded)}`);
    return 1;
  }
  const { key } = loaded.value;
  if (key.comment !== '') yield print(`Key has comment '${key.comment}'`);
  let passphrase = request.newPassphrase;
  if (passphrase === undefined) {
    const first = yield* ask('Enter new passphrase (empty for no passphrase): ');
    const second = yield* ask('Enter same passphrase again: ');
    if (first !== second) {
      yield print('Pass phrases do not match.  Try again.');
      return 1;
    }
    passphrase = first;
  }
  const failure = host.store.write(file, keygenSerializePrivate(key, protectionFor(request, passphrase)), true);
  if (failure !== null) {
    yield print(`Saving key "${file}" failed: ${failure}`);
    return 1;
  }
  if (!request.quiet) yield print('Your identification has been saved with the new passphrase.');
  return 0;
}

export function* changeCommentDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  const file = request.file ?? (yield* askFile(host, 'Enter file in which the key is', request.type ?? DEFAULT_TYPE));
  if (file === null) return 1;
  const material = host.store.read(file);
  if (material === null) {
    yield print(`ssh-keygen: ${file}: No such file or directory`);
    return 255;
  }
  const given = request.oldPassphrase ?? request.newPassphrase;
  const loaded = yield* loadPrivateKey(host, material, given, 'Enter passphrase: ');
  if (loaded.kind !== 'loaded') {
    yield print(`Cannot load private key "${file}": ${failureText(loaded)}`);
    return 1;
  }
  let next = request.comment;
  if (next === undefined) {
    yield print(`Key now has comment '${loaded.value.key.comment}'`);
    next = (yield { kind: 'ask', prompt: 'Enter new comment: ', hidden: false }) ?? '';
  }
  const renamed = keygenKeyWithComment(loaded.value.key, next);
  const failure = host.store.write(file, keygenSerializePrivate(renamed, protectionFor(request, loaded.value.passphrase)), true);
  if (failure !== null) {
    yield print(`Saving key "${file}" failed: ${failure}`);
    return 1;
  }
  const publicFailure = host.store.write(`${file}.pub`, `${keygenPublicLineOf(renamed)}\n`, false);
  if (publicFailure !== null) {
    yield print(`Could not save your public key in ${file}.pub: ${publicFailure}`);
    return 1;
  }
  yield print(next.length > 0 ? `Comment '${next}' applied` : 'Comment removed');
  return 0;
}

function wrapLines(text: string, width: number): string[] {
  const lines: string[] = [];
  for (let at = 0; at < text.length; at += width) lines.push(text.slice(at, at + width));
  return lines;
}

function* exportedKey(request: KeygenRequest, host: SshKeygenHost, publicKey: SshPublicKey): KeygenDialogue {
  const format = request.format ?? 'RFC4716';
  if (format === 'PKCS8') {
    for (const line of pemArmour('PUBLIC KEY', publicKeySpki(publicKey)).split('\n')) yield print(line);
    return 0;
  }
  if (format === 'PEM') {
    if (publicKey.algorithm === 'ssh-ed25519') {
      yield print(`ssh-keygen: unsupported key type ${KEY_TYPE_LABEL(publicKey.algorithm)}`);
      return 255;
    }
    const armoured = publicKey.algorithm === 'ssh-rsa'
      ? pemArmour('RSA PUBLIC KEY', rsaPublicKeyPkcs1(publicKey))
      : pemArmour('PUBLIC KEY', publicKeySpki(publicKey));
    for (const line of armoured.split('\n')) yield print(line);
    return 0;
  }
  const facts = keygenKeyFacts(`${publicKey.algorithm} ${bytesToBase64(sshPublicKeyBlob(publicKey))}`);
  yield print(RFC4716_BEGIN);
  yield print(`Comment: "${facts.bits}-bit ${facts.label}, converted by ${host.user}@${host.hostname} from OpenSSH"`);
  for (const line of wrapLines(bytesToBase64(sshPublicKeyBlob(publicKey)), 70)) yield print(line);
  yield print(RFC4716_END);
  return 0;
}

export function* convertToDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  const file = request.file ?? (yield* askFile(host, 'Enter file in which the key is', request.type ?? DEFAULT_TYPE));
  if (file === null) return 1;
  if (host.store.read(file) === null) {
    yield print(`ssh-keygen: ${file}: No such file or directory`);
    return 255;
  }
  const parsed = publicKeyOfFile(host, file);
  if (parsed === null) {
    yield print(`Load key "${file}": invalid format`);
    return 255;
  }
  const publicKey = sshPublicKeyFromBlob(base64ToBytes(parsed.line.split(' ')[1]));
  if (publicKey === null) return 255;
  return yield* exportedKey(request, host, publicKey);
}

function rfc4716Blob(text: string): Uint8Array | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const begin = lines.indexOf(RFC4716_BEGIN);
  const end = lines.indexOf(RFC4716_END);
  if (begin < 0 || end < begin) return null;
  const body: string[] = [];
  let continued = false;
  for (const line of lines.slice(begin + 1, end)) {
    if (continued) { continued = line.endsWith('\\'); continue; }
    if (line.includes(':') && !/^[A-Za-z0-9+/=]+$/.test(line)) { continued = line.endsWith('\\'); continue; }
    body.push(line);
  }
  try {
    return base64ToBytes(body.join(''));
  } catch {
    return null;
  }
}

export function* convertFromDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  const file = request.file ?? (yield* askFile(host, 'Enter file in which the key is', request.type ?? DEFAULT_TYPE));
  if (file === null) return 1;
  const text = host.store.read(file);
  if (text === null) {
    yield print(`ssh-keygen: ${file}: No such file or directory`);
    return 255;
  }
  const format = request.format ?? 'RFC4716';
  let key: SshPublicKey | null = null;
  if (format === 'RFC4716') {
    const blob = rfc4716Blob(text);
    key = blob === null ? null : sshPublicKeyFromBlob(blob);
  } else {
    const spki = pemBody(text, 'PUBLIC KEY');
    const pkcs1 = pemBody(text, 'RSA PUBLIC KEY');
    key = spki !== null ? publicKeyFromSpki(spki) : pkcs1 !== null ? publicKeyFromPkcs1(pkcs1) : null;
  }
  if (key === null) {
    yield print(`${file} is not a recognised public key format`);
    return 255;
  }
  yield print(`${key.algorithm} ${bytesToBase64(sshPublicKeyBlob(key))}`);
  return 0;
}

function genericRecord(hostname: string, publicKey: SshPublicKey): string[] {
  return sshfpRecords(hostname, publicKey.algorithm, bytesToBase64(sshPublicKeyBlob(publicKey))).map((record) => {
    const [, , , algorithm, digestType, digest] = record.split(' ');
    const rdata = `${Number(algorithm).toString(16).padStart(2, '0')}${Number(digestType).toString(16).padStart(2, '0')}${digest}`;
    return `${hostname} IN TYPE44 \\# ${rdata.length / 2} ${rdata}`;
  });
}

function* recordsOf(request: KeygenRequest, host: SshKeygenHost, path: string): Generator<KeygenStep, number, string | null | undefined> {
  const parsed = publicKeyOfFile(host, path);
  if (parsed === null) return 0;
  const publicKey = sshPublicKeyFromBlob(base64ToBytes(parsed.line.split(' ')[1]));
  if (publicKey === null) return 0;
  const records = request.genericRecord
    ? genericRecord(request.recordHost!, publicKey)
    : sshfpRecords(request.recordHost!, publicKey.algorithm, parsed.line.split(' ')[1]);
  for (const record of records) yield print(record);
  return records.length;
}

export function* recordDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  if (request.file !== undefined) {
    if (host.store.read(request.file) === null && host.store.read(`${request.file}.pub`) === null) {
      yield print(`${request.file}: No such file or directory`);
      return 255;
    }
    const count = yield* recordsOf(request, host, request.file);
    if (count === 0) {
      yield print(`Failed to read v2 public key from "${request.file}": invalid format`);
      return 255;
    }
    return 0;
  }
  let total = 0;
  for (const type of HOST_KEY_FILES) total += yield* recordsOf(request, host, `${host.hostKeyDir}/ssh_host_${type}_key`);
  if (total === 0) {
    yield print('no keys found.');
    return 255;
  }
  return 0;
}
