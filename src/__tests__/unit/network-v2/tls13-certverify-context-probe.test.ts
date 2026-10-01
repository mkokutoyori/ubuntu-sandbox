/**
 * RFC 8446 §4.4.3 — la signature de CertificateVerify porte sur 64
 * espaces, la chaîne de contexte (« TLS 1.3, server CertificateVerify »
 * ou « …client… »), un octet nul et le condensé de transcription.
 *
 * MESURÉ avant correctif : la signature portait sur le seul condensé, donc
 * une signature de serveur était rejouable comme signature de client sur
 * la même transcription.
 *
 * Avant correctif, 2 des 3 cas tombent ; le témoin (le client accepte la
 * poignée de main complète) passe dans les deux états.
 *
 * Limite écrite : la même livraison place les secrets de trafic
 * applicatifs au point ClientHello..Finished du serveur et le secret de
 * reprise après le Finished du client (§7.1). Aucun cas ici ne le
 * discrimine — les éphémères X25519 ne s'injectent pas — ; il est couvert
 * par la cohérence des deux bouts, la reprise PSK et KeyUpdate.
 */
import { describe, it, expect } from 'vitest';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { PkiKeyPair } from '@/network/pki/PkiKeyPair';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { reassembleRecords, type TlsRecord } from '@/network/tls/recordLayer';
import {
  decodeMessages, encodeHandshakeMessage, type CertificateVerify, type CertificateMessage,
} from '@/network/tls/messages';
import { transcriptHash, certificateVerifyContent } from '@/network/tls/keySchedule';

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
  const messages = decodeMessages(reassembleRecords(bundleRecords, true).plaintext);
  return { leaf, hello, serverHelloRecord, messages, client, down };
}

describe('RFC 8446 §4.4.3 — contexte de CertificateVerify', () => {
  it('la signature du serveur vérifie sur le contenu à préfixe de contexte', () => {
    const { leaf, hello, serverHelloRecord, messages } = flight();
    const certificate = messages.find((m): m is CertificateMessage => m.kind === 'certificate')!;
    const verify = messages.find((m): m is CertificateVerify => m.kind === 'certificate_verify')!;
    const before = [
      hello[0].fragment, serverHelloRecord.fragment,
      ...messages.filter((m) => m.kind === 'encrypted_extensions').map(encodeHandshakeMessage),
      encodeHandshakeMessage(certificate),
    ];
    const hash = transcriptHash(before);
    expect(PkiKeyPair.verify(leaf.cert.publicKey, certificateVerifyContent('server', hash), verify.signature)).toBe(true);
  });

  it('elle ne vérifie PAS sur le condensé nu, ni sous le contexte « client »', () => {
    const { leaf, hello, serverHelloRecord, messages } = flight();
    const certificate = messages.find((m): m is CertificateMessage => m.kind === 'certificate')!;
    const verify = messages.find((m): m is CertificateVerify => m.kind === 'certificate_verify')!;
    const hash = transcriptHash([
      hello[0].fragment, serverHelloRecord.fragment,
      ...messages.filter((m) => m.kind === 'encrypted_extensions').map(encodeHandshakeMessage),
      encodeHandshakeMessage(certificate),
    ]);
    expect(PkiKeyPair.verify(leaf.cert.publicKey, hash, verify.signature)).toBe(false);
    expect(PkiKeyPair.verify(leaf.cert.publicKey, certificateVerifyContent('client', hash), verify.signature)).toBe(false);
  });

  it('le client accepte la poignée de main complète avec ce contexte', () => {
    const { client, down } = flight();
    client.handle(down);
    expect(client.result).toBe('success');
  });
});
