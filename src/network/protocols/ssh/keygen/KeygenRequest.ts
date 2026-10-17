import { bsdGetoptDiagnostic, shortOptions } from '@/network/devices/linux/commands/Getopt';
import { isFingerprintHash, keygenKeyCiphers } from '@/network/devices/linux/network/SshKeygenMaterial';
import type { OpenSshRelease } from '../OpenSshRelease';
import type { ConversionFormat, KeygenRequest, SshKeygenOutcome } from './KeygenTypes';

const KEYGEN_OPTSTRING = '+ABHKLQUXceghiklopquvyC:D:E:F:I:M:N:O:P:R:V:Y:Z:a:b:f:g:m:n:r:s:t:w:z:';

const UINT32_MAX = 0xffffffff;
const INT_MAX = 0x7fffffff;

const UNSIMULATED_OPTIONS: Readonly<Record<string, string>> = {
  D: 'PKCS#11 tokens',
  K: 'FIDO authenticators',
  M: 'DH moduli',
  w: 'FIDO authenticators',
  X: 'DH moduli',
};

const FORMATS: Readonly<Record<string, ConversionFormat>> = {
  rfc4716: 'RFC4716',
  ssh2: 'RFC4716',
  pkcs8: 'PKCS8',
  pem: 'PEM',
};

function strtonum(text: string, max: number): { value: number } | { error: string } {
  if (!/^\s*[-+]?\d+$/.test(text)) return { error: 'invalid' };
  const value = Number.parseInt(text, 10);
  if (value < 1) return { error: 'too small' };
  if (value > max) return { error: 'too large' };
  return { value };
}

export function parseKeygenRequest(args: readonly string[], release: OpenSshRelease): KeygenRequest | SshKeygenOutcome {
  const usage = (lead: string): SshKeygenOutcome => ({ output: `${lead}\n${release.keygenUsage}`, exitCode: 1 });
  const operands: string[] = [];
  const signerOptions: string[] = [];
  const request: { -readonly [K in keyof KeygenRequest]: KeygenRequest[K] } = {
    operands, signerOptions,
    all: false, bubblebabble: false, changeComment: false, changePassphrase: false, convertFrom: false,
    convertTo: false, genericRecord: false, hashHosts: false, fingerprint: false, hash: 'sha256',
    printPublic: false, quiet: false, verbose: false, hostCertificate: false, showCertificate: false, preferAgent: false,
    generateRevocationList: false, updateRevocationList: false, checkRevocationList: false,
  };
  const given = new Set<string>();
  for (const option of shortOptions(args, KEYGEN_OPTSTRING)) {
    if (option.kind === 'operand') {
      operands.push(option.value);
      continue;
    }
    if (option.kind === 'invalid' || option.kind === 'missing-argument') return usage(bsdGetoptDiagnostic(option));
    if (option.kind !== 'option') continue;
    const value = option.argument ?? '';
    given.add(option.letter);
    const unsimulated = UNSIMULATED_OPTIONS[option.letter];
    if (unsimulated !== undefined) {
      return { output: `ssh-keygen: -${option.letter}: ${unsimulated} are not simulated`, exitCode: 255 };
    }
    switch (option.letter) {
      case 'A': request.all = true; break;
      case 'B': request.bubblebabble = true; break;
      case 'b': {
        const parsed = strtonum(value, UINT32_MAX);
        if ('error' in parsed) return { output: `Bits has bad value ${value} (${parsed.error})`, exitCode: 255 };
        request.bits = parsed.value;
        break;
      }
      case 'a': {
        const parsed = strtonum(value, INT_MAX);
        if ('error' in parsed) return { output: `Invalid number: ${value} (${parsed.error})`, exitCode: 255 };
        request.rounds = parsed.value;
        break;
      }
      case 'E':
        if (!isFingerprintHash(value)) return { output: `Invalid hash algorithm "${value}"`, exitCode: 255 };
        request.hash = value;
        break;
      case 'C': request.comment = value; break;
      case 'I': request.identity = value; break;
      case 'n': request.principals = value; break;
      case 'h': request.hostCertificate = true; break;
      case 'k': request.generateRevocationList = true; break;
      case 'u': request.updateRevocationList = true; break;
      case 'Q': request.checkRevocationList = true; break;
      case 'L': request.showCertificate = true; break;
      case 'U': request.preferAgent = true; break;
      case 'V': request.validity = value; break;
      case 'z': request.serial = value; break;
      case 'O': signerOptions.push(value); break;
      case 's': request.caKeyPath = value; break;
      case 'Y': request.signOperation = value; break;
      case 'c': request.changeComment = true; break;
      case 'e': request.convertTo = true; break;
      case 'F': request.findHost = value; break;
      case 'f': request.file = value; break;
      case 'g': request.genericRecord = true; break;
      case 'H': request.hashHosts = true; break;
      case 'i': request.convertFrom = true; break;
      case 'l': request.fingerprint = true; break;
      case 'm': {
        const format = FORMATS[value.toLowerCase()];
        if (format === undefined) return { output: `Unsupported conversion format "${value}"`, exitCode: 255 };
        request.format = format;
        break;
      }
      case 'N': request.newPassphrase = value; break;
      case 'P': request.oldPassphrase = value; break;
      case 'p': request.changePassphrase = true; break;
      case 'q': request.quiet = true; break;
      case 'R': request.deleteHost = value; break;
      case 'r': request.recordHost = value; break;
      case 't': request.type = value; break;
      case 'v': request.verbose = true; break;
      case 'y': request.printPublic = true; break;
      case 'Z':
        if (!keygenKeyCiphers().includes(value)) return { output: `Invalid OpenSSH-format cipher '${value}'`, exitCode: 255 };
        request.keyCipher = value;
        break;
    }
  }
  if (request.signOperation === undefined) {
    if (request.caKeyPath !== undefined && operands.length === 0 && !request.generateRevocationList) return usage('Too few arguments.');
    if (request.caKeyPath === undefined && operands.length > 0 && !request.generateRevocationList && !request.checkRevocationList) return usage('Too many arguments.');
  }
  if (request.fingerprint && request.deleteHost !== undefined) return usage('Cannot use -l with -H or -R.');
  return request;
}
