/**
 * RFC 8446 §4.4.3 et §4.2.3 — la signature de CertificateVerify porte sur 64
 * espaces, la chaîne de contexte (« TLS 1.3, server CertificateVerify »
 * ou « …client… »), un octet nul et le condensé de transcription.
 *
 * MESURÉ avant correctif : la signature portait sur le seul condensé, donc
 * une signature de serveur était rejouable comme signature de client sur
 * la même transcription.
 *
 * Mesure : contre le commit qui n'avait pas encore RSA-PSS, 3 des 5 cas
 * tombent ; passent dans les deux états le témoin « le client accepte la
 * poignée de main complète » et le refus du condensé nu (signature PKCS#1
 * v1.5 rejetée de toute façon).
 *
 * Les points de transcription du §7.1 sont vérifiés contre un second
 * calendrier de clés dans `tls-aead-suites-probe.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { verifyCertificateVerify } from '@/network/tls/signature13';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { reassembleRecords, fragmentAsRecords, type TlsRecord } from '@/network/tls/recordLayer';
import {
  decodeMessages, encodeMessages, decodeHandshakeMessage, encodeHandshakeMessage,
  type CertificateVerify, type CertificateMessage, type ClientHello,
} from '@/network/tls/messages';
import { transcriptHash, certificateVerifyContent } from '@/network/tls/keySchedule';
import { suiteInfo } from '@/network/tls/suite13';
import { openFlight, sealFlight } from '@/network/tls/handshakeProtection';
import type { CipherSuite } from '@/network/tls/types';
import { hexToBytes } from '@/crypto/encoding';

const NOW = Date.now();

function flight() {
  const ca = CertificateAuthority.generate('CN=ca', { now: NOW });
  const leaf = ca.issueCertificate({ subject: 'CN=srv', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
  const server = new TlsServerSession({ serverCert: leaf.cert, serverPrivateKey: leaf.privateKey });
  const client = new TlsClientSession({ verifier });
  const hello = client.start();
  const down = server.handle(hello) as TlsRecord[];
  const [serverHelloRecord, ...bundleRecords] = down;
  const messages = decodeMessages(openFlight(server.serverHandshakeTrafficSecret!, server.negotiatedCipherSuite as CipherSuite, 0, bundleRecords)!.plaintext);
  return { leaf, hello, serverHelloRecord, messages, client, down, hash: suiteInfo(server.negotiatedCipherSuite).hash };
}

describe('RFC 8446 §4.4.3 — contexte de CertificateVerify', () => {
  it('la signature du serveur vérifie sur le contenu à préfixe de contexte', () => {
    const { leaf, hello, serverHelloRecord, messages, hash: suiteHash } = flight();
    const certificate = messages.find((m): m is CertificateMessage => m.kind === 'certificate')!;
    const verify = messages.find((m): m is CertificateVerify => m.kind === 'certificate_verify')!;
    const before = [
      hello[0].fragment, serverHelloRecord.fragment,
      ...messages.filter((m) => m.kind === 'encrypted_extensions').map(encodeHandshakeMessage),
      encodeHandshakeMessage(certificate),
    ];
    const hash = transcriptHash(before, suiteHash);
    expect(verify.signatureAlgorithm).toBe('rsa_pss_rsae_sha256');
    expect(verifyCertificateVerify(leaf.cert.publicKey, certificateVerifyContent('server', hash), verify.signatureAlgorithm, verify.signature)).toBe(true);
  });

  it('elle ne vérifie PAS sur le condensé nu, ni sous le contexte « client »', () => {
    const { leaf, hello, serverHelloRecord, messages, hash: suiteHash } = flight();
    const certificate = messages.find((m): m is CertificateMessage => m.kind === 'certificate')!;
    const verify = messages.find((m): m is CertificateVerify => m.kind === 'certificate_verify')!;
    const hash = transcriptHash([
      hello[0].fragment, serverHelloRecord.fragment,
      ...messages.filter((m) => m.kind === 'encrypted_extensions').map(encodeHandshakeMessage),
      encodeHandshakeMessage(certificate),
    ], suiteHash);
    expect(verifyCertificateVerify(leaf.cert.publicKey, hexToBytes(hash), verify.signatureAlgorithm, verify.signature)).toBe(false);
    expect(verifyCertificateVerify(leaf.cert.publicKey, certificateVerifyContent('client', hash), verify.signatureAlgorithm, verify.signature)).toBe(false);
  });

  it('le client accepte la poignée de main complète avec ce contexte', () => {
    const { client, down } = flight();
    client.handle(down);
    expect(client.result).toBe('success');
  });
});

describe('RFC 8446 §4.2.3 — RSA-PSS dans CertificateVerify', () => {
  it('un client qui n\'annonce pas rsa_pss_rsae_sha256 ne peut pas être servi par un certificat RSA', () => {
    const ca = CertificateAuthority.generate('CN=ca', { now: NOW });
    const leaf = ca.issueCertificate({ subject: 'CN=srv', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
    const server = new TlsServerSession({ serverCert: leaf.cert, serverPrivateKey: leaf.privateKey });
    const client = new TlsClientSession({ verifier });
    const hello = decodeHandshakeMessage(client.start()[0].fragment) as ClientHello;
    const narrowed = encodeHandshakeMessage({ ...hello, extensions: { ...hello.extensions, signatureAlgorithms: ['ecdsa_secp256r1_sha256'] } });
    const reply = server.handle([{ contentType: 'handshake', legacyVersion: 0x0303, fragment: narrowed }]);
    expect(server.lastAlert?.description).toBe('handshake_failure');
    expect([...reply![0].fragment]).toEqual([2, 40]);
  });

  it('le client refuse une signature RSA PKCS#1 v1.5 : interdite en 1.3 (illegal_parameter)', () => {
    const ca = CertificateAuthority.generate('CN=ca', { now: NOW });
    const leaf = ca.issueCertificate({ subject: 'CN=srv', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
    const server = new TlsServerSession({ serverCert: leaf.cert, serverPrivateKey: leaf.privateKey });
    const client = new TlsClientSession({ verifier });
    const down = server.handle(client.start())!;
    const [serverHello, ...bundleRecords] = down;
    const suite = server.negotiatedCipherSuite as CipherSuite;
    const messages = decodeMessages(openFlight(server.serverHandshakeTrafficSecret!, suite, 0, bundleRecords)!.plaintext);
    const forged = messages.map((m) => (m.kind === 'certificate_verify' ? { ...m, signatureAlgorithm: 'rsa_pkcs1_sha256' } : m));
    const records = sealFlight(server.serverHandshakeTrafficSecret!, suite, 0, encodeMessages(forged)).records;
    client.handle([serverHello, ...records]);
    expect(client.lastAlert?.description).toBe('illegal_parameter');
  });
});
