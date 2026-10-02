/**
 * Oracle : openssl 3.x réel lit et vérifie les certificats DER produits par
 * `X509Der`, et le décodeur relit ce que openssl produit.
 *
 * Avant correctif, les 8 cas tombent : `X509Der` n'existait pas et le TBS signé
 * était un JSON. Aucun témoin : l'oracle est un processus openssl externe.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PkiKeyPair } from '@/network/pki/PkiKeyPair';
import type { X509Certificate, X509CertificateFields } from '@/network/pki/X509Certificate';
import { encodeCertificate, decodeCertificate, encodeTbsCertificate, tbsBytesOf } from '@/network/pki/der/X509Der';

const dir = mkdtempSync(join(tmpdir(), 'x509der-'));
const openssl = (...args: string[]): string => execFileSync('openssl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function pem(der: Uint8Array): string {
  const b64 = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

function issue(fields: X509CertificateFields, signer: ReturnType<typeof PkiKeyPair.generate>): X509Certificate {
  return { ...fields, signature: PkiKeyPair.sign(signer.privateKey, encodeTbsCertificate(fields)) };
}

const NB = Date.UTC(2026, 0, 1);
const NA = Date.UTC(2036, 0, 1);

function lab(algorithm: 'rsa' | 'ecdsa') {
  const caKeys = PkiKeyPair.generate(algorithm, 1024);
  const leafKeys = PkiKeyPair.generate(algorithm, 1024);
  const signatureAlgorithm = algorithm === 'rsa' ? 'sha256WithRSAEncryption' as const : 'ecdsa-with-SHA256' as const;
  const ca = issue({
    version: 3, serialNumber: '0000000000000001', subject: 'C=FR,O=Lab,CN=Lab CA', issuer: 'C=FR,O=Lab,CN=Lab CA', notBefore: NB, notAfter: NA,
    publicKey: caKeys.publicKey, signatureAlgorithm,
    extensions: { basicConstraints: { cA: true, pathLenConstraint: 0 }, keyUsage: ['keyCertSign', 'cRLSign'], criticalExtensions: ['basicConstraints', 'keyUsage'] },
  }, caKeys);
  const leaf = issue({
    version: 3, serialNumber: '00000000000003e9', subject: 'CN=www.lab', issuer: 'C=FR,O=Lab,CN=Lab CA', notBefore: NB, notAfter: NA,
    publicKey: leafKeys.publicKey, signatureAlgorithm,
    extensions: {
      basicConstraints: { cA: false }, keyUsage: ['digitalSignature', 'keyEncipherment'], extKeyUsage: ['serverAuth', 'clientAuth'],
      subjectAltName: ['DNS:www.lab', 'IP:10.0.0.1', 'email:a@lab', 'URI:http://lab/x'],
      crlDistributionPoints: ['http://lab/ca.crl'],
      authorityInfoAccess: [{ method: 'OCSP', uri: 'http://127.0.0.1:2560' }, { method: 'caIssuers', uri: 'http://lab/ca.crt' }],
      subjectKeyIdentifier: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD',
      authorityKeyIdentifier: { keyid: '01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14' },
    },
  }, caKeys);
  return { ca, leaf };
}

describe.each(['rsa', 'ecdsa'] as const)('X.509 DER (%s) face à openssl réel', (algorithm) => {
  const { ca, leaf } = lab(algorithm);
  const caPath = join(dir, `${algorithm}-ca.pem`);
  const leafPath = join(dir, `${algorithm}-leaf.pem`);
  writeFileSync(caPath, pem(encodeCertificate(ca)));
  writeFileSync(leafPath, pem(encodeCertificate(leaf)));

  it('openssl x509 -text lit le certificat et en restitue les champs', () => {
    const text = openssl('x509', '-in', leafPath, '-noout', '-text');
    expect(text).toContain('Issuer: C = FR, O = Lab, CN = Lab CA');
    expect(text).toContain('Subject: CN = www.lab');
    expect(text).toContain('DNS:www.lab, IP Address:10.0.0.1, email:a@lab, URI:http://lab/x');
    expect(text).toContain('OCSP - URI:http://127.0.0.1:2560');
    expect(text).toContain('TLS Web Server Authentication, TLS Web Client Authentication');
    expect(text).toContain('Digital Signature, Key Encipherment');
  });

  it('openssl verify accepte la signature de l\'émetteur (la signature porte sur le TBS DER)', () => {
    expect(openssl('verify', '-CAfile', caPath, leafPath)).toContain('OK');
  });

  it('le décodeur relit exactement ce que le codeur a écrit', () => {
    expect(decodeCertificate(encodeCertificate(leaf))).toEqual(leaf);
    expect(decodeCertificate(encodeCertificate(ca))).toEqual(ca);
  });

  it('le décodeur relit un certificat fabriqué par openssl', () => {
    const keyPath = join(dir, `${algorithm}-real.key`);
    const certPath = join(dir, `${algorithm}-real.pem`);
    const keyArgs = algorithm === 'rsa' ? ['-newkey', 'rsa:2048'] : ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1'];
    openssl('req', '-x509', ...keyArgs, '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '30', '-subj', '/C=FR/O=Lab/CN=real.lab',
      '-addext', 'subjectAltName=DNS:real.lab,IP:192.0.2.7', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:2');
    const body = readFileSync(certPath, 'utf8').replace(/-----[A-Z ]+-----|\s/g, '');
    const cert = decodeCertificate(Uint8Array.from(Buffer.from(body, 'base64')));
    expect(cert.subject).toBe('C=FR,O=Lab,CN=real.lab');
    expect(cert.extensions?.subjectAltName).toEqual(['DNS:real.lab', 'IP:192.0.2.7']);
    expect(cert.extensions?.basicConstraints).toEqual({ cA: true, pathLenConstraint: 2 });
    expect(PkiKeyPair.verify(cert.publicKey, tbsBytesOf(cert), cert.signature)).toBe(true);
  });
});
