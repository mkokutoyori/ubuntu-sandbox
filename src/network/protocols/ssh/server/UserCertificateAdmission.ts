import { base64ToBytes, bytesToBase64 } from '@/crypto/encoding';
import { keygenBlobDigest, sshKeyTypeLabel, sshPublicKeyBlob, type SshPublicKey } from '@/network/devices/linux/network/SshKeygenMaterial';
import {
  certificateAuthorityRefusal,
  parseCertificateBlob,
  verifyCertificateSignature,
  type SshCertificate,
} from '../certificate/SshCertificate';
import { matchesPatternList } from '../client/SshClientConfigFile';
import { addressListMatches, parseAuthorizedKeyOptions, parseAuthorizedKeysLine, sourceMatchesFromPattern, type AuthorizedKey, type AuthorizedKeyOptions, type KeySource } from '../SshPureUtils';

export interface AdmissionLog {
  readonly level: 'error' | 'info' | 'verbose';
  readonly text: string;
}

export interface TextFile {
  readonly path: string;
  readonly text: string | null;
}

export interface CertificateAdmissionRequest {
  readonly certificate: SshCertificate;
  readonly user: string;
  readonly source: KeySource;
  readonly nowSeconds: bigint;
  readonly caSignatureAlgorithms: readonly string[];
  readonly trustedCaKeys: TextFile | null;
  readonly principalsFile: TextFile | null;
  readonly authorizedKeys: TextFile | null;
  readonly revokedBy: (key: SshPublicKey) => string | null;
}

export interface CertificateAdmission {
  readonly key: AuthorizedKey | null;
  readonly logs: readonly AdmissionLog[];
}

type Merged = { readonly options: AuthorizedKeyOptions } | { readonly refusal: string };

function blobText(key: SshPublicKey): string {
  return bytesToBase64(sshPublicKeyBlob(key));
}

function fingerprint(key: SshPublicKey): string {
  return keygenBlobDigest(blobText(key), 'sha256') ?? '(null)';
}

function certificateRestrictions(certificate: SshCertificate, logs: AdmissionLog[]): { options: AuthorizedKeyOptions } | { refusal: string } {
  let command: string | undefined;
  let sourceAddress: string | undefined;
  for (const option of certificate.critical) {
    if (option.name === 'verify-required') continue;
    if (option.name === 'force-command' && option.value !== null) {
      if (command !== undefined) {
        logs.push({ level: 'error', text: 'Certificate has multiple force-command options' });
        return { refusal: 'Invalid certificate options' };
      }
      command = option.value;
    } else if (option.name === 'source-address' && option.value !== null) {
      if (sourceAddress !== undefined) {
        logs.push({ level: 'error', text: 'Certificate has multiple source-address options' });
        return { refusal: 'Invalid certificate options' };
      }
      if (!validCidrList(option.value)) {
        logs.push({ level: 'error', text: 'Certificate source-address contents invalid' });
        return { refusal: 'Invalid certificate options' };
      }
      sourceAddress = option.value;
    } else {
      logs.push({ level: 'error', text: `Certificate critical option "${option.name}" is not supported` });
      return { refusal: 'Invalid certificate options' };
    }
  }
  const granted = new Set<string>();
  for (const extension of certificate.extensions) {
    if (['permit-X11-forwarding', 'permit-agent-forwarding', 'permit-port-forwarding', 'permit-pty', 'permit-user-rc', 'no-touch-required'].includes(extension.name)) {
      granted.add(extension.name);
    } else {
      logs.push({ level: 'info', text: `Certificate extension "${extension.name}" is not supported` });
    }
  }
  return {
    options: {
      ...(command === undefined ? {} : { command }),
      ...(sourceAddress === undefined ? {} : { from: sourceAddress }),
      noPty: !granted.has('permit-pty'),
      noPortForwarding: !granted.has('permit-port-forwarding'),
      noAgentForwarding: !granted.has('permit-agent-forwarding'),
      noX11Forwarding: !granted.has('permit-X11-forwarding'),
    },
  };
}

function validCidrList(list: string): boolean {
  return list.split(',').every((entry) => /^!?(\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?|[0-9a-fA-F:]+(\/\d{1,3})?)$/.test(entry.trim()));
}

function merge(primary: AuthorizedKeyOptions, certificate: AuthorizedKeyOptions): Merged {
  if (primary.command !== undefined && certificate.command !== undefined && primary.command !== certificate.command) {
    return { refusal: 'forced command options do not match' };
  }
  const command = primary.command ?? certificate.command;
  const from = primary.from ?? certificate.from;
  return {
    options: {
      ...(command === undefined ? {} : { command }),
      ...(from === undefined ? {} : { from }),
      ...(primary.environment === undefined ? {} : { environment: primary.environment }),
      ...(primary.permitOpen === undefined ? {} : { permitOpen: primary.permitOpen }),
      noPty: primary.noPty === true || certificate.noPty === true,
      noPortForwarding: primary.noPortForwarding === true || certificate.noPortForwarding === true,
      noAgentForwarding: primary.noAgentForwarding === true || certificate.noAgentForwarding === true,
      noX11Forwarding: primary.noX11Forwarding === true || certificate.noX11Forwarding === true,
    },
  };
}

function sourceRefusal(options: AuthorizedKeyOptions, user: string, source: KeySource, location: string, logs: AdmissionLog[]): string | null {
  if (options.from !== undefined && !sourceMatchesFromPattern(source.ip, source.host ?? '', options.from)) {
    logs.push({
      level: 'info',
      text: `${location}: Authentication tried for ${user} with correct key but not from a permitted host (host=${source.host ?? source.ip}, ip=${source.ip}, required=${options.from}).`,
    });
    return 'Refused by key options';
  }
  return null;
}

function certificateSourceRefusal(options: AuthorizedKeyOptions, user: string, source: KeySource, location: string, logs: AdmissionLog[]): string | null {
  if (options.from !== undefined && !addressListMatches(options.from, source.ip)) {
    logs.push({
      level: 'info',
      text: `${location}: Authentication tried for ${user} with valid certificate but not from a permitted source address (${source.ip}).`,
    });
    return 'Refused by certificate options';
  }
  return null;
}

function principalsLine(line: string, certificate: SshCertificate): AuthorizedKeyOptions | null | 'invalid' {
  const trimmed = line.replace(/#.*$/, '').trim();
  if (trimmed === '') return null;
  const lastSpace = Math.max(trimmed.lastIndexOf(' '), trimmed.lastIndexOf('\t'));
  const optionsText = lastSpace < 0 ? '' : trimmed.slice(0, lastSpace).trim();
  const principal = lastSpace < 0 ? trimmed : trimmed.slice(lastSpace + 1);
  const options = optionsText === '' ? {} : parseAuthorizedKeyOptions(optionsText);
  if ((options.unsupported?.length ?? 0) > 0) return 'invalid';
  return certificate.principals.includes(principal) ? options : null;
}

function matchingPrincipalsFile(file: TextFile, certificate: SshCertificate): AuthorizedKeyOptions | null {
  for (const line of (file.text ?? '').split('\n')) {
    const matched = principalsLine(line, certificate);
    if (matched !== null && matched !== 'invalid') return matched;
  }
  return null;
}

function trustedCaListed(file: TextFile, caKey: SshPublicKey): boolean {
  const target = blobText(caKey);
  for (const line of (file.text ?? '').split('\n')) {
    const key = parseAuthorizedKeysLine(line);
    if (key !== null && key.material === target) return true;
  }
  return false;
}

function viaTrustedCa(request: CertificateAdmissionRequest, logs: AdmissionLog[]): AuthorizedKey | null {
  const { certificate, trustedCaKeys } = request;
  if (trustedCaKeys === null || trustedCaKeys.text === null || !trustedCaListed(trustedCaKeys, certificate.caKey)) return null;
  const caFingerprint = fingerprint(certificate.caKey);
  const fail = (reason: string): null => {
    logs.push({ level: 'error', text: reason });
    return null;
  };
  let principalsOptions: AuthorizedKeyOptions | null = null;
  const usePrincipalsFile = request.principalsFile !== null;
  if (request.principalsFile !== null && request.principalsFile.text !== null) {
    principalsOptions = matchingPrincipalsFile(request.principalsFile, certificate);
  }
  if (usePrincipalsFile && principalsOptions === null) return fail('Certificate does not contain an authorized principal');
  const refusal = certificateAuthorityRefusal(certificate, {
    wantHost: false, requirePrincipal: true, wildcardPattern: false, verifyTime: request.nowSeconds,
    name: usePrincipalsFile ? undefined : request.user,
  });
  if (refusal !== null) return fail(refusal);
  const restrictions = certificateRestrictions(certificate, logs);
  if ('refusal' in restrictions) return fail(restrictions.refusal);
  const location = trustedCaKeys.path;
  const certificateRefusal = certificateSourceRefusal(restrictions.options, request.user, request.source, 'cert', logs);
  if (certificateRefusal !== null) return fail(certificateRefusal);
  let finalOptions = restrictions.options;
  if (principalsOptions !== null) {
    const principalRefusal = sourceRefusal(principalsOptions, request.user, request.source, 'principals', logs);
    if (principalRefusal !== null) return fail('Refused by certificate principals options');
    const merged = merge(principalsOptions, restrictions.options);
    if ('refusal' in merged) return fail(merged.refusal);
    finalOptions = merged.options;
  }
  logs.push({
    level: 'verbose',
    text: `Accepted certificate ID "${certificate.keyId}" (serial ${certificate.serial}) signed by ${sshKeyTypeLabel(certificate.caKey.algorithm)} CA ${caFingerprint} via ${location}`,
  });
  return admitted(certificate, finalOptions);
}

function admitted(certificate: SshCertificate, options: AuthorizedKeyOptions): AuthorizedKey {
  return { algorithm: certificate.algorithm, material: bytesToBase64(certificate.blob), comment: certificate.keyId, options };
}

function viaAuthorizedKeys(request: CertificateAdmissionRequest, logs: AdmissionLog[]): AuthorizedKey | null {
  const { certificate, authorizedKeys } = request;
  if (authorizedKeys === null || authorizedKeys.text === null) return null;
  const caMaterial = blobText(certificate.caKey);
  const lines = authorizedKeys.text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const key = parseAuthorizedKeysLine(lines[index]);
    if (key === null || key.material !== caMaterial || key.options?.certAuthority !== true) continue;
    const location = `${authorizedKeys.path}:${index + 1}`;
    const keyOptions = key.options;
    if ((keyOptions.unsupported?.length ?? 0) > 0) continue;
    const fail = (reason: string): null => {
      logs.push({ level: 'error', text: reason });
      return null;
    };
    const sourceFailure = sourceRefusal(keyOptions, request.user, request.source, location, logs);
    if (sourceFailure !== null) return fail(sourceFailure);
    const restrictions = certificateRestrictions(certificate, logs);
    if ('refusal' in restrictions) return fail(restrictions.refusal);
    const certificateFailure = certificateSourceRefusal(restrictions.options, request.user, request.source, location, logs);
    if (certificateFailure !== null) return fail(certificateFailure);
    const merged = merge(keyOptions, restrictions.options);
    if ('refusal' in merged) return fail(merged.refusal);
    if (keyOptions.principals !== undefined
      && !certificate.principals.some((principal) => matchesPatternList(keyOptions.principals!, principal, false))) {
      return fail('Certificate does not contain an authorized principal');
    }
    const refusal = certificateAuthorityRefusal(certificate, {
      wantHost: false, requirePrincipal: false, wildcardPattern: false, verifyTime: request.nowSeconds,
      name: keyOptions.principals === undefined ? request.user : undefined,
    });
    if (refusal !== null) return fail(refusal);
    logs.push({
      level: 'verbose',
      text: `Accepted certificate ID "${certificate.keyId}" (serial ${certificate.serial}) signed by CA ${sshKeyTypeLabel(certificate.caKey.algorithm)} ${fingerprint(certificate.caKey)} found at ${location}`,
    });
    return admitted(certificate, merged.options);
  }
  return null;
}

export function admitUserCertificate(request: CertificateAdmissionRequest): CertificateAdmission {
  const logs: AdmissionLog[] = [];
  const { certificate } = request;
  if (request.caSignatureAlgorithms.length > 0 && !request.caSignatureAlgorithms.includes(certificate.signatureType)) {
    logs.push({ level: 'info', text: `userauth_pubkey: certificate signature algorithm ${certificate.signatureType}: signature algorithm not supported` });
    return { key: null, logs };
  }
  if (!verifyCertificateSignature(certificate)) {
    logs.push({ level: 'error', text: 'userauth_pubkey: parse key: incorrect signature' });
    return { key: null, logs };
  }
  for (const key of [certificate.subject, certificate.caKey]) {
    const file = request.revokedBy(key);
    if (file !== null) {
      logs.push({ level: 'error', text: `Authentication key ${sshKeyTypeLabel(key.algorithm)} ${fingerprint(key)} revoked by file ${file}` });
      return { key: null, logs };
    }
  }
  const trusted = viaTrustedCa(request, logs);
  if (trusted !== null) return { key: trusted, logs };
  return { key: viaAuthorizedKeys(request, logs), logs };
}

export function certificateKeyEvidence(certificate: SshCertificate): {
  keyType: string; keyFingerprint: string; certificate: { keyId: string; serial: string; caType: string; caFingerprint: string };
} {
  return {
    keyType: `${sshKeyTypeLabel(certificate.subject.algorithm)}-CERT`,
    keyFingerprint: keygenBlobDigest(bytesToBase64(certificate.blob), 'sha256') ?? '(null)',
    certificate: {
      keyId: certificate.keyId,
      serial: certificate.serial.toString(),
      caType: sshKeyTypeLabel(certificate.caKey.algorithm),
      caFingerprint: fingerprint(certificate.caKey),
    },
  };
}

export function certificateOfMaterial(material: string): SshCertificate | null {
  try {
    return parseCertificateBlob(base64ToBytes(material));
  } catch {
    return null;
  }
}
