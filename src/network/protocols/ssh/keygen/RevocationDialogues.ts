import { base64ToBytes, bytesToFileText, fileTextToBytes } from '@/crypto/encoding';
import { sha1, sha256 } from '@/crypto/hash';
import { simulationNowMs } from '@/network/core/SystemClock';
import { sshPublicKeyBlob, sshPublicKeyFromBlob, type SshPublicKey } from '@/network/devices/linux/network/SshKeygenMaterial';
import { KeyRevocationList } from '../certificate/KeyRevocationList';
import { parseCertificateLine, type SshCertificate } from '../certificate/SshCertificate';
import { publicKeyOfFile } from './KeyFileDialogues';
import { parsePublicKeyText } from './AllowedSigners';
import { print, printError, type KeygenDialogue, type KeygenRequest, type SshKeygenHost } from './KeygenTypes';

const NO_SUCH_FILE = 'No such file or directory';
const UINT64_MAX = 0xffffffffffffffffn;
const LOAD_FAILURES = {
  'bad-magic': 'KRL file has invalid magic number',
  'invalid-format': 'invalid format',
  'signature-invalid': 'incorrect signature',
  'key-revoked': 'key is revoked',
} as const;

function* fatal(message: string): KeygenDialogue {
  yield printError(message);
  return 255;
}

function loadKrl(host: SshKeygenHost, path: string): { krl: KeyRevocationList } | { error: string } {
  const text = host.store.read(path);
  if (text === null) return { error: `Unable to load KRL ${path}: ${NO_SUCH_FILE}` };
  const parsed = KeyRevocationList.parse(fileTextToBytes(text));
  if (parsed.ok === false) return { error: `${parsed.logs.map((line) => `${line}\n`).join('')}Invalid KRL file ${path}: ${LOAD_FAILURES[parsed.failure]}` };
  return { krl: parsed.krl };
}

function parseSerial(text: string): bigint | null {
  const trimmed = text.trim();
  if (/^0[xX][0-9a-fA-F]+$/.test(trimmed) || /^\d+$/.test(trimmed)) {
    const value = BigInt(trimmed);
    return value > UINT64_MAX ? null : value;
  }
  return /^0[0-7]+$/.test(trimmed) ? BigInt(`0o${trimmed.slice(1)}`) : null;
}

type Revocation = { error: string } | null;

function revokeFromLine(
  krl: KeyRevocationList, line: string, location: string, file: string, authority: SshPublicKey | null, wildcard: boolean,
): Revocation {
  const lowered = line.toLowerCase();
  if (lowered.startsWith('serial:')) {
    if (authority === null && !wildcard) return { error: 'revoking certificates by serial number requires specification of a CA key' };
    const value = line.slice(7).trim();
    const dash = value.indexOf('-', 1);
    const first = parseSerial(dash < 0 ? value : value.slice(0, dash));
    if (value === '' || first === null) return { error: `${location}: invalid serial "${value}"` };
    let last = first;
    if (dash >= 0) {
      const rest = value.slice(dash + 1);
      const parsed = parseSerial(rest);
      if (rest === '' || parsed === null) return { error: `${location}: invalid serial "${rest}"` };
      last = parsed;
      if (last <= first) return { error: `${location}: invalid serial range ${first}:${last}` };
    }
    krl.revokeSerialRange(authority, first, last);
    return null;
  }
  if (lowered.startsWith('id:')) {
    if (authority === null && !wildcard) return { error: 'revoking certificates by key ID requires specification of a CA key' };
    krl.revokeKeyId(authority, line.slice(3).trim());
    return null;
  }
  if (lowered.startsWith('hash:')) {
    const value = line.slice(5).trim();
    if (!value.startsWith('SHA256:')) return { error: `${file}:${location.split(':').pop()}: unsupported hash algorithm` };
    let digits = value.slice(7);
    while (digits.length % 4 !== 0) digits += '=';
    let hash: Uint8Array;
    try {
      hash = base64ToBytes(digits);
    } catch {
      return { error: `${location}: decode hash failed: invalid format` };
    }
    return krl.revokeSha256(hash) ? null : { error: 'update_krl_from_file: revoke key failed: invalid format' };
  }
  let mode: 'plain' | 'key' | 'sha1' | 'sha256' = 'plain';
  let rest = line;
  for (const [prefix, kind] of [['key:', 'key'], ['sha1:', 'sha1'], ['sha256:', 'sha256']] as const) {
    if (lowered.startsWith(prefix)) { mode = kind; rest = line.slice(prefix.length).trim(); break; }
  }
  const certificate = parseCertificateLine(rest)?.certificate ?? null;
  const key = certificate === null ? parsePublicKeyText(rest) : certificate.subject;
  if (key === null) return { error: `${location}: invalid key: invalid format` };
  const blob = sshPublicKeyBlob(key);
  if (mode === 'key') krl.revokeKeyExplicit(key);
  else if (mode === 'sha1') krl.revokeSha1(sha1(blob));
  else if (mode === 'sha256') krl.revokeSha256(sha256(blob));
  else krl.revokeKey(certificate ?? key);
  return null;
}

export function* generateRevocationListDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  const output = request.file;
  if (output === undefined || output === '') return yield* fatal('KRL generation requires an output file');
  const exists = host.store.read(output) !== null;
  if (!exists && request.updateRevocationList) return yield* fatal(`KRL "${output}" does not exist`);
  let authority: SshPublicKey | null = null;
  let wildcard = false;
  if (request.caKeyPath !== undefined) {
    if (request.caKeyPath.toLowerCase() === 'none') {
      wildcard = true;
    } else {
      const found = publicKeyOfFile(host, request.caKeyPath);
      authority = found === null ? null : sshPublicKeyFromBlob(base64ToBytes(found.line.split(/\s+/)[1]));
      if (authority === null) return yield* fatal(`Cannot load CA public key ${request.caKeyPath}: ${NO_SUCH_FILE}`);
    }
  }
  let krl = new KeyRevocationList();
  if (request.updateRevocationList) {
    const loaded = loadKrl(host, output);
    if ('error' in loaded) return yield* fatal(loaded.error);
    krl = loaded.krl;
  }
  if (request.serial !== undefined) {
    const version = parseSerial(request.serial.replace(/^\+/, ''));
    if (version !== null && version !== 0n) krl.version = version;
  }
  if (request.comment !== undefined) krl.comment = request.comment;
  for (const specification of request.operands) {
    const text = specification === '-' ? host.stdin ?? '' : host.store.read(specification);
    if (text === null) return yield* fatal(`fopen ${specification}: ${NO_SUCH_FILE}`);
    const displayed = specification === '-' ? '(standard input)' : specification;
    if (!request.quiet) yield print(`Revoking from ${displayed}`);
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (let index = 0; index < lines.length; index++) {
      const cleaned = lines[index].replace(/#.*$/, '').trim();
      if (cleaned === '') continue;
      const failure = revokeFromLine(krl, cleaned, `${displayed}:${index + 1}`, specification, authority, wildcard);
      if (failure !== null) return yield* fatal(failure.error);
    }
  }
  const now = host.nowSeconds?.() ?? Math.floor(simulationNowMs() / 1000);
  const refusal = host.store.write(output, bytesToFileText(krl.toBytes(now)), false);
  if (refusal !== null) return yield* fatal(`write ${output}: ${refusal}`);
  return 0;
}

export function* checkRevocationListDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  const input = request.file;
  if (input === undefined || input === '') return yield* fatal('KRL checking requires an input file');
  const loaded = loadKrl(host, input);
  if ('error' in loaded) return yield* fatal(loaded.error);
  if (request.fingerprint) for (const line of loaded.krl.dump(host.zoneOffsetMinutes ?? (() => 0))) yield print(line);
  let status = 0;
  for (const target of request.operands) {
    const found = publicKeyOfFile(host, target);
    const certificateText = host.store.read(target);
    const certificate: SshCertificate | null = certificateText === null ? null : parseCertificateLine(certificateText.split('\n')[0] ?? '')?.certificate ?? null;
    const key = certificate ?? (found === null ? null : sshPublicKeyFromBlob(base64ToBytes(found.line.split(/\s+/)[1])));
    if (key === null) return yield* fatal(`Cannot load public key ${target}: ${NO_SUCH_FILE}`);
    const comment = found?.comment ?? parseCertificateLine(certificateText ?? '')?.comment ?? '';
    const revoked = loaded.krl.isRevoked(key);
    yield print(`${target}${comment === '' ? '' : ` (${comment})`}: ${revoked ? 'REVOKED' : 'ok'}`);
    if (revoked) status = 1;
  }
  return status;
}
