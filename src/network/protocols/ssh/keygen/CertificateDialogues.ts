import { base64ToBytes, bytesToBase64, bytesToHex } from '@/crypto/encoding';
import { systemRandom } from '@/crypto/random';
import { simulationNowMs } from '@/network/core/SystemClock';
import { keygenBlobDigest, sshKeyTypeLabel, sshPublicKeyBlob, sshPublicKeyFromBlob, type SshPublicKey } from '@/network/devices/linux/network/SshKeygenMaterial';
import {
  CERT_FOREVER,
  SSH_CERT_TYPE_HOST,
  SSH_CERT_TYPE_USER,
  certificateLine,
  certificateTypeName,
  certifyWith,
  type CertificateSigner,
  formatCertificateValidity,
  parseCertificateLine,
  type CertificateOption,
  type SshCertificate,
} from '../certificate/SshCertificate';
import { pkcs11Problem } from './TokenDialogues';
import { signWithAlgorithm } from '../auth/UserauthSignature';
import { agentSignatureFlags } from '../agent/AgentWire';
import { formatAbsoluteTime, parseAbsoluteTime, type ZoneOffset } from './AbsoluteTime';
import { failureText, loadPrivateKey, publicKeyOfFile } from './KeyFileDialogues';
import { print, printError, type KeygenDialogue, type KeygenRequest, type KeygenStep, type SshKeygenHost } from './KeygenTypes';

const NO_SUCH_FILE = 'No such file or directory';
const MAX_PRINCIPALS = 256;
const UINT64_MAX = CERT_FOREVER;
const INT_MAX = 0x7fffffff;
const MULTIPLIERS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

const DEFAULT_EXTENSIONS = ['permit-X11-forwarding', 'permit-agent-forwarding', 'permit-port-forwarding', 'permit-pty', 'permit-user-rc'];

const FLAG_EXTENSIONS: Readonly<Record<string, readonly [string, boolean]>> = {
  'no-x11-forwarding': ['permit-X11-forwarding', false],
  'permit-x11-forwarding': ['permit-X11-forwarding', true],
  'no-agent-forwarding': ['permit-agent-forwarding', false],
  'permit-agent-forwarding': ['permit-agent-forwarding', true],
  'no-port-forwarding': ['permit-port-forwarding', false],
  'permit-port-forwarding': ['permit-port-forwarding', true],
  'no-pty': ['permit-pty', false],
  'permit-pty': ['permit-pty', true],
  'no-user-rc': ['permit-user-rc', false],
  'permit-user-rc': ['permit-user-rc', true],
  'touch-required': ['no-touch-required', false],
  'no-touch-required': ['no-touch-required', true],
};

export function convtime(text: string): number | null {
  if (text === '') return null;
  let total = 0;
  const pattern = /(\d+)([sSmMhHdDwW]?)/y;
  while (pattern.lastIndex < text.length) {
    const match = pattern.exec(text);
    if (match === null) return null;
    const multiplier = match[2] === '' ? 1 : MULTIPLIERS[match[2].toLowerCase()];
    const seconds = Number(match[1]);
    if (seconds > INT_MAX / multiplier || total > INT_MAX - seconds * multiplier) return null;
    total += seconds * multiplier;
  }
  return total;
}

interface Validity {
  readonly from: bigint;
  readonly to: bigint;
}

function relativeTime(text: string, now: number): bigint | string {
  const seconds = convtime(text.slice(1));
  if (seconds === null) return `Invalid relative certificate time ${text}`;
  if (text[0] === '-' && seconds > now) return `Certificate time ${text} cannot be represented`;
  return BigInt(text[0] === '-' ? now - seconds : now + seconds);
}

export function parseValidity(text: string, now: number, zoneOffset: ZoneOffset): Validity | string {
  if (text.startsWith('+') && !text.includes(':')) {
    const seconds = convtime(text.slice(1));
    if (seconds === null) return `Invalid relative certificate life ${text}`;
    return { from: BigInt(Math.floor((now - 59) / 60) * 60), to: BigInt(now + seconds) };
  }
  const colon = text.indexOf(':');
  if (colon <= 0 || colon === text.length - 1) return `Invalid certificate life specification ${text}`;
  const fromText = text.slice(0, colon);
  const toText = text.slice(colon + 1);
  let from: bigint;
  if (fromText[0] === '-' || fromText[0] === '+') {
    const relative = relativeTime(fromText, now);
    if (typeof relative === 'string') return relative;
    from = relative;
  } else if (fromText === 'always') {
    from = 0n;
  } else {
    const absolute = parseAbsoluteTime(fromText, zoneOffset);
    if (absolute === null) return `Invalid from time "${fromText}"`;
    from = BigInt(absolute);
  }
  let to: bigint;
  if (toText[0] === '-' || toText[0] === '+') {
    const relative = relativeTime(toText, now);
    if (typeof relative === 'string') return relative;
    to = relative;
  } else if (toText === 'forever') {
    to = UINT64_MAX;
  } else {
    const absolute = parseAbsoluteTime(toText, zoneOffset);
    if (absolute === null) return `Invalid to time "${toText}"`;
    to = BigInt(absolute);
  }
  if (to <= from) return 'Empty certificate validity interval';
  return { from, to };
}

interface CertificateOptions {
  readonly critical: readonly CertificateOption[];
  readonly extensions: readonly CertificateOption[];
}

function compareOptions(first: CertificateOption & { critical: boolean }, second: CertificateOption & { critical: boolean }): number {
  if (first.critical !== second.critical) return first.critical ? 1 : -1;
  if (first.name !== second.name) return first.name < second.name ? -1 : 1;
  if ((first.value === null) !== (second.value === null)) return first.value === null ? -1 : 1;
  if (first.value !== null && second.value !== null && first.value !== second.value) return first.value < second.value ? -1 : 1;
  return 0;
}

function certificateOptions(requested: readonly string[], hostCertificate: boolean): CertificateOptions | string {
  let enabled = hostCertificate ? new Set<string>() : new Set(DEFAULT_EXTENSIONS);
  let command: string | undefined;
  let sourceAddress: string | undefined;
  const custom: Array<CertificateOption & { critical: boolean }> = [];
  for (const option of requested) {
    const lowered = option.toLowerCase();
    if (lowered === 'clear') {
      enabled = new Set();
    } else if (FLAG_EXTENSIONS[lowered] !== undefined) {
      const [name, on] = FLAG_EXTENSIONS[lowered];
      if (on) enabled.add(name);
      else enabled.delete(name);
    } else if (lowered.startsWith('force-command=')) {
      if (option.length === 'force-command='.length) return 'Empty force-command option';
      if (command !== undefined) return 'force-command already specified';
      command = option.slice('force-command='.length);
    } else if (lowered.startsWith('source-address=')) {
      if (option.length === 'source-address='.length) return 'Empty source-address option';
      if (sourceAddress !== undefined) return 'source-address already specified';
      sourceAddress = option.slice('source-address='.length);
    } else if (lowered.startsWith('extension:') || lowered.startsWith('critical:')) {
      const body = option.slice(option.indexOf(':') + 1);
      const equals = body.indexOf('=');
      custom.push({
        name: equals < 0 ? body : body.slice(0, equals), value: equals < 0 ? null : body.slice(equals + 1),
        critical: lowered.startsWith('critical:'),
      });
    } else {
      return `Unsupported certificate option "${option}"`;
    }
  }
  const all: Array<CertificateOption & { critical: boolean }> = [...custom];
  if (command !== undefined) all.push({ name: 'force-command', value: command, critical: true });
  if (sourceAddress !== undefined) all.push({ name: 'source-address', value: sourceAddress, critical: true });
  for (const name of enabled) all.push({ name, value: null, critical: false });
  all.sort(compareOptions);
  return {
    critical: all.filter((entry) => entry.critical).map(({ name, value }) => ({ name, value })),
    extensions: all.filter((entry) => !entry.critical).map(({ name, value }) => ({ name, value })),
  };
}

function algorithmMatches(requested: string, key: SshPublicKey): boolean {
  const canonical: Record<string, string> = {
    rsa: 'ssh-rsa', 'rsa-sha2-256': 'ssh-rsa', 'rsa-sha2-512': 'ssh-rsa', 'ssh-rsa': 'ssh-rsa',
    ed25519: 'ssh-ed25519', 'ssh-ed25519': 'ssh-ed25519', ecdsa: 'ecdsa-sha2-nistp256',
  };
  return (canonical[requested] ?? requested) === key.algorithm
    || (requested === 'ecdsa' && key.algorithm.startsWith('ecdsa-'));
}

function loadAgentAuthority(
  host: SshKeygenHost, caPath: string,
): { readonly key: SshPublicKey; readonly sign: CertificateSigner } | string {
  const found = publicKeyOfFile(host, caPath);
  if (found === null) {
    return `Cannot load CA public key ${caPath}: ${host.store.read(caPath) === null && host.store.read(`${caPath}.pub`) === null ? NO_SUCH_FILE : 'invalid format'}`;
  }
  const key = sshPublicKeyFromBlob(base64ToBytes(found.line.split(/\s+/)[1]));
  if (key === null) return `Cannot load CA public key ${caPath}: invalid format`;
  const agent = host.agent;
  if (agent === undefined) return 'Cannot use public key for CA signature: agent not present';
  const blob = bytesToBase64(sshPublicKeyBlob(key));
  const held = agent.identities().find((entry) => bytesToBase64(entry.blob) === blob);
  if (held === undefined) return `CA key ${caPath} not found in agent`;
  const sign: CertificateSigner = (data, algorithm) => agent.sign(held.blob, data, agentSignatureFlags(algorithm));
  return { key, sign };
}

function* fatal(message: string): KeygenDialogue {
  yield printError(message);
  return 255;
}

function parseSerial(text: string): { serial: bigint; increment: boolean } | string {
  const increment = text.startsWith('+');
  const digits = increment ? text.slice(1) : text;
  if (!/^\d+$/.test(digits) || BigInt(digits) >= UINT64_MAX) return `Invalid serial number "${digits}"`;
  return { serial: BigInt(digits), increment };
}

export function* certifyDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  const zoneOffset: ZoneOffset = host.zoneOffsetMinutes ?? (() => 0);
  const now = host.nowSeconds?.() ?? Math.floor(simulationNowMs() / 1000);
  let serial = { serial: 0n, increment: false };
  if (request.serial !== undefined) {
    const parsed = parseSerial(request.serial);
    if (typeof parsed === 'string') return yield* fatal(parsed);
    serial = parsed;
  }
  let validity: Validity = { from: 0n, to: UINT64_MAX };
  if (request.validity !== undefined) {
    const parsed = parseValidity(request.validity, now, zoneOffset);
    if (typeof parsed === 'string') return yield* fatal(parsed);
    validity = parsed;
  }
  if (request.identity === undefined) return yield* fatal('Must specify key id (-I) when certifying');
  const options = certificateOptions(request.signerOptions, request.hostCertificate);
  if (typeof options === 'string') return yield* fatal(options);
  const caPath = request.caKeyPath ?? '';
  if (request.pkcs11Provider !== undefined) {
    const publicCa = publicKeyOfFile(host, caPath);
    if (publicCa === null) return yield* fatal(`Couldn't load CA public key "${caPath}": ${host.store.read(caPath) === null && host.store.read(`${caPath}.pub`) === null ? NO_SUCH_FILE : 'invalid format'}`);
    yield* pkcs11Problem(host, request.pkcs11Provider);
    return yield* fatal('cannot read public key from pkcs11');
  }
  let caKey: SshPublicKey;
  let signWith: CertificateSigner;
  if (request.preferAgent) {
    const agentCa = loadAgentAuthority(host, caPath);
    if (typeof agentCa === 'string') return yield* fatal(agentCa);
    caKey = agentCa.key;
    signWith = agentCa.sign;
  } else {
    const material = host.store.read(caPath);
    if (material === null) return yield* fatal(`Load key "${caPath}": ${NO_SUCH_FILE}`);
    const loaded = yield* loadPrivateKey(host, material, request.oldPassphrase, 'Enter passphrase: ');
    if (loaded.kind !== 'loaded') return yield* fatal(`Load key "${caPath}": ${failureText(loaded)}`);
    const privateKey = loaded.value.key;
    caKey = privateKey;
    signWith = (data, algorithm) => signWithAlgorithm(privateKey, algorithm, data);
  }
  if (request.type !== undefined && !algorithmMatches(request.type, caKey)) {
    return yield* fatal(`CA key type ${caKey.algorithm} doesn't match specified ${request.type}`);
  }
  const principals = request.principals === undefined ? [] : request.principals.split(',');
  if (principals.some((principal) => principal === '')) return yield* fatal('Empty principal name');
  if (principals.length > MAX_PRINCIPALS) return yield* fatal('Too many certificate principals specified');
  for (const target of request.operands) {
    const existing = parseCertificateLine(host.store.read(target) ?? '');
    if (existing !== null) {
      return yield* fatal(`do_ca_sign: key "${target}" type ${sshKeyTypeLabel(existing.certificate.subject.algorithm)}-CERT cannot be certified`);
    }
    const found = publicKeyOfFile(host, target);
    if (found === null) return yield* fatal(`load pubkey "${target}": ${host.store.read(target) === null && host.store.read(`${target}.pub`) === null ? NO_SUCH_FILE : 'invalid format'}`);
    const subject = sshPublicKeyFromBlob(base64ToBytes(found.line.split(/\s+/)[1]));
    if (subject === null) return yield* fatal(`load pubkey "${target}": invalid format`);
    const certificate = certifyWith({
      subject, serial: serial.serial, type: request.hostCertificate ? SSH_CERT_TYPE_HOST : SSH_CERT_TYPE_USER,
      keyId: request.identity, principals, validAfter: validity.from, validBefore: validity.to,
      critical: options.critical, extensions: options.extensions,
    }, caKey, request.type, systemRandom, signWith);
    if (certificate === null) return yield* fatal(`Couldn't certify ${target} via agent: agent refused operation`);
    const output = `${target.endsWith('.pub') ? target.slice(0, -'.pub'.length) : target}-cert.pub`;
    const failure = host.store.write(output, `${certificateLine(certificate, found.comment)}\n`, false);
    if (failure !== null) return yield* fatal(`Unable to save public key to ${output}: ${failure}`);
    if (!request.quiet) {
      const forText = request.principals === undefined ? '' : ` for ${request.principals}`;
      yield printError(`Signed ${certificateTypeName(certificate)} key ${output}: id "${certificate.keyId}" serial ${certificate.serial}${forText} valid ${formatCertificateValidity(certificate, zoneOffset)}`);
    }
    if (serial.increment) serial = { serial: serial.serial + 1n, increment: true };
  }
  return 0;
}

function describeOptions(options: readonly CertificateOption[], critical: boolean): string[] {
  const lines: string[] = [];
  const flags = ['permit-X11-forwarding', 'permit-agent-forwarding', 'permit-port-forwarding', 'permit-pty', 'permit-user-rc', 'no-touch-required'];
  for (const option of options) {
    if (!critical && flags.includes(option.name) && option.value === null) lines.push(`                ${option.name}`);
    else if (critical && (option.name === 'force-command' || option.name === 'source-address') && option.value !== null) {
      lines.push(`                ${option.name} ${option.value}`);
    } else if (option.value !== null) {
      const raw = new TextEncoder().encode(option.value);
      lines.push(`                ${option.name} UNKNOWN OPTION: ${bytesToHex(new Uint8Array([0, 0, 0, raw.length, ...raw]))} (len ${raw.length + 4})`);
    } else {
      lines.push(`                ${option.name} UNKNOWN FLAG OPTION`);
    }
  }
  return lines;
}

function certificateFingerprint(blob: Uint8Array, hash: string): string | null {
  return keygenBlobDigest(bytesToBase64(blob), hash);
}

function describeCertificate(certificate: SshCertificate, request: KeygenRequest, zoneOffset: ZoneOffset): string[] {
  const subjectType = `${sshKeyTypeLabel(certificate.subject.algorithm)}-CERT`;
  const lines = [
    `        Type: ${certificate.algorithm} ${certificateTypeName(certificate)} certificate`,
    `        Public key: ${subjectType} ${certificateFingerprint(certificate.blob, request.hash)}`,
    `        Signing CA: ${sshKeyTypeLabel(certificate.caKey.algorithm)} ${certificateFingerprint(sshPublicKeyBlob(certificate.caKey), request.hash)} (using ${certificate.signatureType})`,
    `        Key ID: "${certificate.keyId}"`,
    `        Serial: ${certificate.serial}`,
    `        Valid: ${formatCertificateValidity(certificate, zoneOffset)}`,
  ];
  lines.push('        Principals: ' + (certificate.principals.length === 0 ? '(none)' : ''));
  for (const principal of certificate.principals) lines.push(`                ${principal}`);
  lines.push('        Critical Options: ' + (certificate.critical.length === 0 ? '(none)' : ''));
  lines.push(...describeOptions(certificate.critical, true));
  lines.push('        Extensions: ' + (certificate.extensions.length === 0 ? '(none)' : ''));
  lines.push(...describeOptions(certificate.extensions, false));
  return lines;
}

function* askCertificateFile(host: SshKeygenHost): Generator<KeygenStep, string | null, string | null | undefined> {
  const fallback = `${host.sshDir}/id_rsa`;
  const answer = yield { kind: 'ask', prompt: `Enter file in which the key is (${fallback}): `, hidden: false };
  if (answer === null || answer === undefined) return null;
  return answer === '' ? fallback : answer;
}

export function* showCertificateDialogue(request: KeygenRequest, host: SshKeygenHost): KeygenDialogue {
  const zoneOffset: ZoneOffset = host.zoneOffsetMinutes ?? (() => 0);
  const file = request.file ?? (yield* askCertificateFile(host));
  if (file === null) return 1;
  const fromStandardInput = file === '-';
  const text = fromStandardInput ? host.stdin ?? '' : host.store.read(file);
  if (text === null) return yield* fatal(`ssh-keygen: ${file}: ${NO_SUCH_FILE}`);
  const path = fromStandardInput ? '(stdin)' : file;
  let ok = false;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/^[ \t]+/, '');
    if (line === '' || line.startsWith('#')) continue;
    const parsed = parseCertificateLine(line);
    if (parsed === null) {
      const plain = line.split(/\s+/);
      const isKey = plain.length >= 2 && publicKeyHasKnownType(plain[0]);
      yield printError(isKey ? `${path}:${index + 1} is not a certificate` : `${path}:${index + 1}: invalid key: invalid format`);
      continue;
    }
    ok = true;
    yield print(!fromStandardInput && index === 0 ? `${path}:` : `${path}:${index + 1}:`);
    for (const described of describeCertificate(parsed.certificate, request, zoneOffset)) yield print(described);
  }
  return ok ? 0 : 1;
}

function publicKeyHasKnownType(word: string): boolean {
  return /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))$/.test(word);
}
