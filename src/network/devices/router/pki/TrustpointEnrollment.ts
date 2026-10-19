import { PkiKeyPair, type PkiPrivateKey, type PkiPublicKey } from '@/network/pki/PkiKeyPair';
import { buildCertificateRequest } from '@/network/pki/CertificateSigningRequest';
import { tbsPayload, type X509Certificate } from '@/network/pki/X509Certificate';
import { csrToPem, pemToCert, pemToCrl } from '@/network/pki/pem';
import { certificateFingerprints, iosDate } from './CertificateDisplay';
import type { CiscoSecurityConfig, PkiTrustpoint } from '../security/CiscoSecurityConfig';
import { parseEnrollmentUrl, type PkiEnrollmentClient } from './PkiEnrollmentClient';

export interface TrustpointEnrollmentHost {
  security(): CiscoSecurityConfig;
  client(): PkiEnrollmentClient;
  hostname(): string;
  install(trustpoint: PkiTrustpoint): void;
  now(): number;
  after(ms: number, fn: () => void): unknown;
  cancel(handle: unknown): void;
}

interface PendingEnrollment {
  readonly transaction: number | null;
  readonly key: PkiPrivateKey;
  readonly publicKey: PkiPublicKey;
}

const pending = new WeakMap<PkiTrustpoint, PendingEnrollment>();
const crlTimers = new WeakMap<PkiTrustpoint, unknown>();
const usesCrl = (trustpoint: PkiTrustpoint): boolean =>
  trustpoint.revocationCheck === 'crl' || trustpoint.revocationCheck === 'crl-or-ocsp' || trustpoint.revocationCheck === 'crl-then-ocsp';

export function pendingTransactionOf(trustpoint: PkiTrustpoint): number | null {
  return pending.get(trustpoint)?.transaction ?? null;
}

function endpointOf(trustpoint: PkiTrustpoint) {
  if (!trustpoint.enrollmentUrl) return null;
  return parseEnrollmentUrl(trustpoint.enrollmentUrl);
}

export async function authenticateTrustpoint(host: TrustpointEnrollmentHost, name: string): Promise<string> {
  const trustpoint = host.security().pkiTrustpoints.get(name);
  if (!trustpoint) return `% Trustpoint ${name} not configured`;
  const endpoint = endpointOf(trustpoint);
  if (!endpoint) return `% Trustpoint ${name} has no usable "enrollment url http://..." (selfsigned and terminal have no CA to ask)`;
  const reply = await host.client().getCaCertificate(endpoint);
  if (!reply.ok || reply.status !== 'SUCCESS') {
    return `% Error in receiving Certificate Authority certificate: status = FAIL${reply.error ? ` (${reply.error})` : ''}`;
  }
  const certificate = pemToCert(reply.body);
  if (!certificate) return '% Error in receiving Certificate Authority certificate: status = FAIL (unreadable certificate)';
  return acceptCaCertificate(host, trustpoint, certificate);
}

export function acceptCaCertificate(host: TrustpointEnrollmentHost, trustpoint: PkiTrustpoint, certificate: X509Certificate): string {
  const { md5: md5Digest, sha1: sha1Digest } = certificateFingerprints(certificate);
  const lines = ['Certificate has the following attributes:', `       Fingerprint MD5: ${md5Digest}`, `      Fingerprint SHA1: ${sha1Digest}`];
  if (trustpoint.fingerprint) {
    const wanted = trustpoint.fingerprint.replace(/[\s:]/g, '').toUpperCase();
    const matches = [md5Digest, sha1Digest].some((d) => d.replace(/\s/g, '') === wanted);
    if (!matches) return [...lines, '% Certificate validation failed - fingerprint mismatch', '% Certificate Authority certificate rejected'].join('\n');
    lines.push('% Certificate validated - fingerprint matched.');
  }
  trustpoint.caCert = certificate;
  lines.push('Trustpoint CA certificate accepted.');
  host.install(trustpoint);
  return lines.join('\n');
}

export function authenticateFromTerminal(host: TrustpointEnrollmentHost, name: string, text: string): string {
  const trustpoint = host.security().pkiTrustpoints.get(name);
  if (!trustpoint) return `% Trustpoint ${name} not configured`;
  const certificate = pemToCert(text);
  if (!certificate) return '% Error: the pasted text is not a PEM certificate';
  return acceptCaCertificate(host, trustpoint, certificate);
}

function generateKeyFor(host: TrustpointEnrollmentHost, trustpoint: PkiTrustpoint): PkiKeyPair {
  const labelled = trustpoint.rsaKeypair
    ? host.security().cryptoKeys.find((candidate) => candidate.label === trustpoint.rsaKeypair)
    : undefined;
  trustpoint.keyExportable = labelled?.exportable === true;
  return PkiKeyPair.generate('rsa', labelled?.modulus);
}

export function requestFromTerminal(host: TrustpointEnrollmentHost, name: string): string {
  const trustpoint = host.security().pkiTrustpoints.get(name);
  if (!trustpoint) return `% Trustpoint ${name} not configured`;
  if (!trustpoint.caCert) return `% Trustpoint ${name} is not authenticated — run 'crypto pki authenticate ${name}' first`;
  const waiting = pending.get(trustpoint);
  const fresh = waiting ? null : generateKeyFor(host, trustpoint);
  const key = waiting?.key ?? fresh!.privateKey;
  const publicKey = waiting?.publicKey ?? fresh!.publicKey;
  pending.set(trustpoint, { transaction: null, key, publicKey });
  const subject = trustpoint.subjectName || `CN=${host.hostname()}`;
  const names = trustpoint.fqdn ? [trustpoint.fqdn] : undefined;
  const request = buildCertificateRequest(subject, { publicKey, privateKey: key }, names);
  return ['% Start certificate enrollment ..', `% The subject name in the certificate will include: ${subject}`,
    'Certificate Request follows:', '', csrToPem(request).trimEnd(), '', '---End - This line not part of the certificate request---'].join('\n');
}

export function importRouterCertificate(host: TrustpointEnrollmentHost, name: string, text: string): string {
  const trustpoint = host.security().pkiTrustpoints.get(name);
  if (!trustpoint) return `% Trustpoint ${name} not configured`;
  if (!trustpoint.caCert) return `% Trustpoint ${name} is not authenticated — run 'crypto pki authenticate ${name}' first`;
  const waiting = pending.get(trustpoint);
  if (!waiting) return `% No certificate request is pending for trustpoint ${name}: run 'crypto pki enroll ${name}' first`;
  const certificate = pemToCert(text);
  if (!certificate) return '% Error: the pasted text is not a PEM certificate';
  if (certificate.publicKey.material !== waiting.publicKey.material) return '% Error: the certificate does not carry the public key of the pending request';
  if (certificate.issuer !== trustpoint.caCert.subject
    || !PkiKeyPair.verify(trustpoint.caCert.publicKey, tbsPayload(certificate), certificate.signature)) {
    return '% Error: the certificate is not signed by the authenticated CA';
  }
  pending.delete(trustpoint);
  trustpoint.localCert = certificate;
  trustpoint.localKey = waiting.key;
  host.install(trustpoint);
  return '% Router Certificate successfully imported';
}

export async function enrollTrustpoint(host: TrustpointEnrollmentHost, name: string): Promise<string> {
  const trustpoint = host.security().pkiTrustpoints.get(name);
  if (!trustpoint) return `% Trustpoint ${name} not configured`;
  if (!trustpoint.caCert) return `% Trustpoint ${name} is not authenticated — run 'crypto pki authenticate ${name}' first`;
  const endpoint = endpointOf(trustpoint);
  if (!endpoint) return `% Trustpoint ${name} has no usable "enrollment url http://..."`;
  const client = host.client();
  const waiting = pending.get(trustpoint);
  const header = `% Start certificate enrollment ..\n`;
  let reply;
  let key: PkiPrivateKey;
  let keysPublic: PkiPublicKey;
  if (waiting && waiting.transaction !== null) {
    key = waiting.key;
    keysPublic = waiting.publicKey;
    reply = await client.poll(endpoint, waiting.transaction);
  } else {
    const keys = generateKeyFor(host, trustpoint);
    key = keys.privateKey;
    keysPublic = keys.publicKey;
    const subject = trustpoint.subjectName || `CN=${host.hostname()}`;
    const names = trustpoint.fqdn ? [trustpoint.fqdn] : undefined;
    reply = await client.submit(endpoint, csrToPem(buildCertificateRequest(subject, keys, names)));
  }
  if (!reply.ok) return `${header}% Failed to reach the Certificate Authority: ${reply.error ?? 'no answer'}`;
  if (reply.status === 'PENDING') {
    if (reply.transaction !== null) pending.set(trustpoint, { transaction: reply.transaction, key, publicKey: keysPublic });
    return `${header}% Certificate request sent to Certificate Authority\n% The certificate request is pending, re-enter "crypto pki enroll ${name}" to collect it.`;
  }
  if (reply.status !== 'SUCCESS') {
    pending.delete(trustpoint);
    return `${header}% Certificate request rejected by the Certificate Authority`;
  }
  const certificate = pemToCert(reply.body);
  if (!certificate) return `${header}% Certificate received from the Certificate Authority could not be read`;
  pending.delete(trustpoint);
  trustpoint.localCert = certificate;
  trustpoint.localKey = key;
  host.install(trustpoint);
  if (usesCrl(trustpoint)) await requestCrl(host, name);
  return `${header}% Certificate request sent to Certificate Authority\n% The certificate has been granted by CA!\n% Router Certificate successfully imported`;
}

export async function requestCrl(host: TrustpointEnrollmentHost, name: string): Promise<string> {
  const trustpoint = host.security().pkiTrustpoints.get(name);
  if (!trustpoint) return `% Trustpoint ${name} not configured`;
  if (!trustpoint.caCert) return `% Trustpoint ${name} is not authenticated — run 'crypto pki authenticate ${name}' first`;
  const endpoint = endpointOf(trustpoint);
  if (!endpoint) return `% Trustpoint ${name} has no usable "enrollment url http://..."`;
  const reply = await host.client().getCrl(endpoint);
  if (!reply.ok || reply.status !== 'SUCCESS') return `% Error in receiving the CRL from the Certificate Authority${reply.error ? ` (${reply.error})` : ''}`;
  const crl = pemToCrl(reply.body);
  if (!crl || !crl.isValidSignature(trustpoint.caCert.publicKey)) return '% The CRL received is not signed by the Certificate Authority';
  trustpoint.crl = crl;
  host.install(trustpoint);
  const previous = crlTimers.get(trustpoint);
  if (previous !== undefined) host.cancel(previous);
  crlTimers.set(trustpoint, host.after(Math.max(1000, crl.nextUpdate - host.now()), () => { void requestCrl(host, name); }));
  return '';
}

export function clearCrls(host: TrustpointEnrollmentHost): void {
  for (const trustpoint of host.security().pkiTrustpoints.values()) {
    trustpoint.crl = undefined;
    const timer = crlTimers.get(trustpoint);
    if (timer !== undefined) host.cancel(timer);
    crlTimers.delete(trustpoint);
    host.install(trustpoint);
  }
}

export function renderCrls(host: TrustpointEnrollmentHost): string {
  const out: string[] = [];
  for (const trustpoint of host.security().pkiTrustpoints.values()) {
    const crl = trustpoint.crl;
    if (!crl) continue;
    out.push('CRL Issuer Name:', `    ${crl.issuer}`, `LastUpdate: ${iosDate(crl.thisUpdate)}`, `NextUpdate: ${iosDate(crl.nextUpdate)}`,
      'Retrieved from CRL Distribution Point:', '** CDP Not Published - Retrieved via SCEP');
  }
  return out.join('\n');
}
