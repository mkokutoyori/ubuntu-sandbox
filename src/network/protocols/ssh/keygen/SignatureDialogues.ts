import { base64ToBytes, bytesToBase64 } from '@/crypto/encoding';
import { simulationNowMs } from '@/network/core/SystemClock';
import { keygenBlobDigest, sshKeyTypeLabel, sshPublicKeyBlob, sshPublicKeyFromBlob, type SshPublicKey } from '@/network/devices/linux/network/SshKeygenMaterial';
import {
  checkAllowedSigner,
  findPrincipals,
  isRevokedKey,
  matchPrincipals,
  type SignersContext,
  type SignersOutcome,
} from './AllowedSigners';
import { parseAbsoluteTime, type ZoneOffset } from './AbsoluteTime';
import { failureText, loadPrivateKey, publicKeyOfFile } from './KeyFileDialogues';
import { print, printError, type KeygenDialogue, type KeygenRequest, type KeygenStep, type SshKeygenHost } from './KeygenTypes';
import { armorSignature, dearmorSignature, signerOfSignature, signMessage, verifyMessage } from './SshSignatureFormat';

const NO_SUCH_FILE = 'No such file or directory';
const encoder = new TextEncoder();

interface SignatureOptions {
  readonly hashAlgorithm?: string;
  readonly verifyTime: number;
  readonly printPublicKey: boolean;
}

function zoneOffsetOf(host: SshKeygenHost): ZoneOffset {
  return host.zoneOffsetMinutes ?? (() => 0);
}

function nowSeconds(host: SshKeygenHost): number {
  return host.nowSeconds?.() ?? Math.floor(simulationNowMs() / 1000);
}

function processOptions(
  request: KeygenRequest, host: SshKeygenHost, accepts: { hashAlgorithm: boolean; verifyTime: boolean; printPublicKey: boolean },
): SignatureOptions | string {
  let hashAlgorithm: string | undefined;
  let verifyTime = 0;
  let printPublicKey = false;
  for (const option of request.signerOptions) {
    const lowered = option.toLowerCase();
    if (accepts.hashAlgorithm && lowered.startsWith('hashalg=')) {
      hashAlgorithm = option.slice('hashalg='.length);
    } else if (accepts.verifyTime && lowered.startsWith('verify-time=')) {
      const parsed = parseAbsoluteTime(option.slice('verify-time='.length), zoneOffsetOf(host));
      if (parsed === null || parsed === 0) return 'Invalid "verify-time" option';
      verifyTime = parsed;
    } else if (accepts.printPublicKey && lowered === 'print-pubkey') {
      printPublicKey = true;
    } else {
      return `Invalid option "${option}"`;
    }
  }
  return { hashAlgorithm, verifyTime: verifyTime === 0 ? nowSeconds(host) : verifyTime, printPublicKey };
}

function* errors(lines: readonly string[]): Generator<KeygenStep, void, string | null | undefined> {
  for (const line of lines) yield printError(line);
}

function* missing(message: string): KeygenDialogue {
  yield printError(message);
  return 1;
}

function privatePathOf(keyPath: string): string {
  for (const suffix of ['-cert.pub', '.pub']) {
    if (keyPath.length > suffix.length && keyPath.endsWith(suffix)) return keyPath.slice(0, -suffix.length);
  }
  return keyPath;
}

function publicKeyAt(host: SshKeygenHost, path: string): SshPublicKey | null {
  const found = publicKeyOfFile(host, path);
  return found === null ? null : sshPublicKeyFromBlob(base64ToBytes(found.line.split(/\s+/)[1]));
}

function sameBlob(first: Uint8Array, second: Uint8Array): boolean {
  return first.length === second.length && first.every((byte, index) => byte === second[index]);
}

function stdinBytes(host: SshKeygenHost): Uint8Array {
  return encoder.encode(host.stdin ?? '');
}

function* confirmOverwrite(host: SshKeygenHost, path: string): Generator<KeygenStep, boolean, string | null | undefined> {
  if (host.store.read(path) === null) return true;
  yield print(`${path} already exists.`);
  const answer = yield { kind: 'ask', prompt: 'Overwrite (y/n)? ', hidden: false };
  return !!answer && (answer[0] === 'y' || answer[0] === 'Y');
}

function* signDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  const operands = request.operands;
  if (operands.some((operand, index) => operand === '-' && (index > 0 || operands.length > 1))) {
    yield printError('Cannot sign mix of paths and standard input');
    return 255;
  }
  if (request.principals === undefined || request.principals === '') return yield* missing('Too few arguments for sign: missing namespace');
  if (request.file === undefined) return yield* missing('Too few arguments for sign: missing key');
  const options = processOptions(request, host, { hashAlgorithm: true, verifyTime: false, printPublicKey: false });
  if (typeof options === 'string') {
    yield printError(options);
    return 255;
  }
  const publicKey = publicKeyAt(host, request.file);
  if (publicKey === null) {
    yield printError(`Couldn't load public key ${request.file}: ${NO_SUCH_FILE}`);
    return 255;
  }
  const privatePath = privatePathOf(request.file);
  const material = host.store.read(privatePath);
  if (material === null) {
    yield printError(`Load key "${privatePath}": ${NO_SUCH_FILE}`);
    return 255;
  }
  const loaded = yield* loadPrivateKey(host, material, request.oldPassphrase, 'Enter passphrase: ');
  if (loaded.kind !== 'loaded') {
    yield printError(`Load key "${privatePath}": ${failureText(loaded)}`);
    return 255;
  }
  const signingKey = loaded.value.key;
  if (!sameBlob(sshPublicKeyBlob(signingKey), sshPublicKeyBlob(publicKey))) {
    yield printError(`Public key ${request.file} doesn't match private ${privatePath}`);
    return 255;
  }
  const targets = operands.length === 0 ? ['(stdin)'] : operands;
  for (const target of targets) {
    const fromStandardInput = operands.length === 0 || target === '-';
    let message: Uint8Array;
    if (fromStandardInput) {
      message = stdinBytes(host);
    } else {
      const text = host.store.read(target);
      if (text === null) {
        yield printError(`Cannot open ${target} for signing: ${NO_SUCH_FILE}`);
        return 255;
      }
      message = encoder.encode(text);
    }
    if (!request.quiet) yield printError(fromStandardInput ? 'Signing data on standard input' : `Signing file ${target}`);
    const signed = signMessage(signingKey, options.hashAlgorithm, request.principals, message);
    if (signed.ok === false) {
      yield* errors(signed.errors);
      yield printError(`Signing ${target} failed: signature algorithm not supported`);
      return 255;
    }
    const armored = armorSignature(signed.value);
    if (fromStandardInput) {
      for (const line of armored.replace(/\n$/, '').split('\n')) yield print(line);
      continue;
    }
    const caKeyPath = `${target}.sig`;
    if (!(yield* confirmOverwrite(host, caKeyPath))) continue;
    const refusal = host.store.write(caKeyPath, armored, false);
    if (refusal !== null) {
      yield printError(`Cannot open ${caKeyPath}: ${refusal}`);
      return 255;
    }
    if (!request.quiet) yield printError(`Write signature to ${caKeyPath}`);
  }
  return 0;
}

function describeFailure(outcome: SignersOutcome<unknown>): readonly string[] {
  return outcome.logged;
}

function* verifyDialogue(request: KeygenRequest, host: SshKeygenHost, validate: boolean): KeygenDialogue {
  const operation = validate ? 'verify' : 'check-novalidate';
  if (request.principals === undefined || request.principals === '') return yield* missing(`Too few arguments for ${operation}: missing namespace`);
  if (request.caKeyPath === undefined) return yield* missing(`Too few arguments for ${operation}: missing signature file`);
  if (validate && request.file === undefined) return yield* missing('Too few arguments for sign: missing allowed keys file');
  if (validate && request.identity === undefined) return yield* missing('Too few arguments for verify: missing principal identity');
  const options = processOptions(request, host, { hashAlgorithm: false, verifyTime: true, printPublicKey: true });
  if (typeof options === 'string') {
    yield printError(options);
    return 255;
  }
  const namespace = request.principals;
  const principal = validate ? request.identity : undefined;
  let verdict: SshPublicKey | null = null;
  let signerBlob = new Uint8Array(0);
  const checked = yield* checkSignature(request, host, namespace, options, validate);
  if (checked !== null) {
    verdict = checked.key;
    signerBlob = checked.blob;
  }
  if (verdict === null) {
    if (!request.quiet) yield print('Could not verify signature.');
    return 255;
  }
  if (!request.quiet) {
    const fingerprint = keygenBlobDigest(bytesToBase64(signerBlob), request.hash);
    const type = sshKeyTypeLabel(verdict.algorithm);
    yield print(principal === undefined
      ? `Good "${namespace}" signature with ${type} key ${fingerprint}`
      : `Good "${namespace}" signature for ${principal} with ${type} key ${fingerprint}`);
  }
  if (options.printPublicKey) yield print(`${verdict.algorithm} ${bytesToBase64(signerBlob)}`);
  return 0;
}

function* checkSignature(
  request: KeygenRequest, host: SshKeygenHost, namespace: string, options: SignatureOptions, validate: boolean,
): Generator<KeygenStep, { key: SshPublicKey; blob: Uint8Array } | null, string | null | undefined> {
  const armored = host.store.read(request.caKeyPath ?? '');
  if (armored === null) {
    yield printError(`Couldn't read signature file: ${NO_SUCH_FILE}`);
    return null;
  }
  const blob = dearmorSignature(armored);
  if (blob.ok === false) {
    yield* errors(blob.errors);
    return null;
  }
  const verified = verifyMessage(blob.value, stdinBytes(host), namespace);
  if (verified.ok === false) {
    yield* errors(verified.errors);
    return null;
  }
  const signer = verified.value;
  if (request.recordHost !== undefined && validate) {
    const revoked = host.store.read(request.recordHost);
    if (revoked === null || isRevokedKey(revoked, signer.key) !== false) return null;
  }
  if (!validate) return signer;
  const allowedPath = request.file ?? '';
  const allowed = host.store.read(allowedPath);
  if (allowed === null) {
    yield printError(`Unable to open allowed keys file "${allowedPath}": ${NO_SUCH_FILE}`);
    return null;
  }
  const outcome = checkAllowedSigner(signersContext(host, allowedPath, allowed, options.verifyTime), signer.key, request.identity ?? '', namespace);
  yield* errors(describeFailure(outcome));
  return outcome.kind === 'found' ? signer : null;
}

function signersContext(host: SshKeygenHost, path: string, text: string, verifyTime: number): SignersContext {
  return { path, text, verifyTime, zoneOffset: zoneOffsetOf(host) };
}

function* findPrincipalsDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  if (request.caKeyPath === undefined) return yield* missing('Too few arguments for find-principals:missing signature file');
  if (request.file === undefined) return yield* missing('Too few arguments for find-principals:missing allowed keys file');
  const options = processOptions(request, host, { hashAlgorithm: false, verifyTime: true, printPublicKey: false });
  if (typeof options === 'string') {
    yield printError(options);
    return 255;
  }
  const armored = host.store.read(request.caKeyPath);
  if (armored === null) {
    yield printError(`Couldn't read signature file: ${NO_SUCH_FILE}`);
    yield printError('No principal matched.');
    return 255;
  }
  const blob = dearmorSignature(armored);
  const signer = blob.ok === false ? blob : signerOfSignature(blob.value);
  if (signer.ok === false) {
    yield* errors(signer.errors);
    yield printError('No principal matched.');
    return 255;
  }
  const allowed = host.store.read(request.file);
  if (allowed === null) {
    yield printError(`Unable to open allowed keys file "${request.file}": ${NO_SUCH_FILE}`);
    yield printError('sig_find_principals: sshsig_find_principal: system error');
    yield printError('No principal matched.');
    return 255;
  }
  const outcome = findPrincipals(signersContext(host, request.file, allowed, options.verifyTime), signer.value.key);
  yield* errors(outcome.logged);
  if (outcome.kind === 'found') {
    for (const principal of outcome.value.split(',')) if (principal !== '') yield print(principal);
    return 0;
  }
  if (outcome.kind === 'invalid') yield printError('sig_find_principals: sshsig_find_principal: invalid format');
  yield printError('No principal matched.');
  return 255;
}

function* matchPrincipalsDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  if (request.file === undefined) return yield* missing('Too few arguments for match-principals:missing allowed keys file');
  if (request.identity === undefined) return yield* missing('Too few arguments for match-principals: missing principal ID');
  const options = processOptions(request, host, { hashAlgorithm: false, verifyTime: false, printPublicKey: false });
  if (typeof options === 'string') {
    yield printError(options);
    return 255;
  }
  const allowed = host.store.read(request.file);
  if (allowed === null) {
    yield printError(`Unable to open allowed keys file "${request.file}": ${NO_SUCH_FILE}`);
    yield printError('No principal matched.');
    return 255;
  }
  const outcome = matchPrincipals(signersContext(host, request.file, allowed, options.verifyTime), request.identity);
  yield* errors(outcome.logged);
  if (outcome.kind !== 'found') {
    yield printError('No principal matched.');
    return 255;
  }
  for (const principals of outcome.value) yield print(principals);
  return 0;
}

export function* signatureDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  const operation = request.signOperation ?? '';
  if (operation.startsWith('find-principals')) return yield* findPrincipalsDialogue(request, host);
  if (operation.startsWith('match-principals')) return yield* matchPrincipalsDialogue(request, host);
  if (operation.startsWith('sign')) return yield* signDialogue(request, host);
  if (operation.startsWith('check-novalidate')) return yield* verifyDialogue(request, host, false);
  if (operation.startsWith('verify')) return yield* verifyDialogue(request, host, true);
  yield printError(`Unsupported operation for -Y: "${operation}"`);
  for (const line of host.release.keygenUsage.split('\n')) yield printError(line);
  return 1;
}
