/**
 * Vérification de l'identité du serveur (RFC 6125 §6) et son usage par le
 * client TLS (RFC 8446 §4.4.2.? : le client authentifie le serveur ; RFC 6066 §3).
 *
 * Mesuré AVANT correctif (git stash push -- src/network) : 6 cas sur 16 tombent.
 *   - un générique « *.com » couvrant un suffixe public était accepté
 *   - un SAN DNS de forme « 10.0.0.1 » était accepté pour une référence IP, et
 *     un SAN IP pour une référence DNS (les types se confondaient)
 *   - une référence IPv6 sous une autre forme d'écriture ne correspondait pas
 *   - un nom de référence terminé par un point était refusé
 *   - le client TLS n'envoyait le nom qu'en SNI et n'en vérifiait jamais le
 *     certificat : un serveur au certificat d'un autre nom était accepté
 * Passent avant et après (témoins) : correspondance exacte insensible à la
 * casse, générique d'un seul niveau, générique n'incluant pas le domaine nu,
 * générique non initial refusé, repli sur le CN seulement sans SAN DNS, SAN IP,
 * SAN IP refusé pour une référence DNS (refusé avant par hasard : le texte
 * ne coïncidait pas), générique partiel refusé, certificat de bon nom accepté.
 * Le comportement de curl est conservé : sans aucun SAN, le CN sert aussi à une
 * référence IP.
 */
import { describe, it, expect } from 'vitest';
import { certificateMatchesHostname, CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { TlsRecord } from '@/network/tls/recordLayer';

const NOW = Date.now();

function certOf(subject: string, san?: string[]): X509Certificate {
  const ca = CertificateAuthority.generate('CN=ca', { now: NOW });
  return ca.issueCertificate({
    subject, notBefore: NOW - 1000, notAfter: NOW + 1e9,
    ...(san ? { subjectAltNames: san } : {}),
  } as never).cert;
}

describe('RFC 6125 — correspondance', () => {
  it('témoin : nom exact, sans égard à la casse', () => {
    expect(certificateMatchesHostname(certOf('CN=x', ['DNS:Www.Example.com']), 'wWw.example.COM')).toBe(true);
  });
  it('témoin : un générique couvre exactement un niveau', () => {
    const cert = certOf('CN=x', ['DNS:*.example.com']);
    expect(certificateMatchesHostname(cert, 'a.example.com')).toBe(true);
    expect(certificateMatchesHostname(cert, 'a.b.example.com')).toBe(false);
  });
  it('témoin : un générique ne couvre pas le domaine nu', () => {
    expect(certificateMatchesHostname(certOf('CN=x', ['DNS:*.example.com']), 'example.com')).toBe(false);
  });
  it('témoin : un générique hors de l’étiquette de gauche est refusé', () => {
    expect(certificateMatchesHostname(certOf('CN=x', ['DNS:www.*.example.com']), 'www.a.example.com')).toBe(false);
  });
  it('témoin : le CN sert de repli seulement sans SAN', () => {
    expect(certificateMatchesHostname(certOf('CN=www.example.com'), 'www.example.com')).toBe(true);
    expect(certificateMatchesHostname(certOf('CN=www.example.com', ['DNS:other.example.com']), 'www.example.com')).toBe(false);
  });
  it('témoin : une référence IP correspond à un SAN IP', () => {
    expect(certificateMatchesHostname(certOf('CN=x', ['IP:10.0.0.1']), '10.0.0.1')).toBe(true);
  });

  it('un générique sur un suffixe public (*.com) est refusé', () => {
    expect(certificateMatchesHostname(certOf('CN=x', ['DNS:*.com']), 'a.com')).toBe(false);
  });
  it('un SAN DNS qui ressemble à une adresse n’autorise pas une référence IP', () => {
    expect(certificateMatchesHostname(certOf('CN=x', ['DNS:10.0.0.1']), '10.0.0.1')).toBe(false);
  });
  it('un SAN IP n’autorise pas une référence DNS de même texte', () => {
    expect(certificateMatchesHostname(certOf('CN=x', ['IP:10.0.0.1']), 'host')).toBe(false);
  });
  it('une référence IPv6 correspond quelle que soit son écriture', () => {
    expect(certificateMatchesHostname(certOf('CN=x', ['IP:2001:db8::1']), '2001:0db8:0:0:0:0:0:1')).toBe(true);
  });
  it('témoin : sans aucun SAN, le CN sert aussi à une référence IP (comportement de curl)', () => {
    expect(certificateMatchesHostname(certOf('CN=10.0.0.9'), '10.0.0.9')).toBe(true);
  });
  it('un nom de référence terminé par un point est normalisé', () => {
    expect(certificateMatchesHostname(certOf('CN=x', ['DNS:www.example.com']), 'www.example.com.')).toBe(true);
  });
  it('un générique partiel (f*.example.com) est refusé', () => {
    expect(certificateMatchesHostname(certOf('CN=x', ['DNS:f*.example.com']), 'foo.example.com')).toBe(false);
  });
});

function handshake(serverName: string | undefined, certNames: string[]): TlsClientSession {
  const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
  const issued = ca.issueCertificate({
    subject: 'CN=ignored', notBefore: NOW - 1000, notAfter: NOW + 1e9, subjectAltNames: certNames,
  } as never);
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
  const server = new TlsServerSession({ serverCert: issued.cert, serverPrivateKey: issued.privateKey });
  const client = new TlsClientSession({ verifier, serverName });
  let flight: readonly TlsRecord[] | null = client.start();
  for (let i = 0; i < 6 && flight; i++) {
    const reply = server.handle(flight);
    if (!reply) break;
    flight = client.handle(reply);
  }
  return client;
}

describe('le client TLS authentifie le nom demandé', () => {
  it('témoin : un certificat du bon nom est accepté', () => {
    expect(handshake('www.example.com', ['DNS:www.example.com']).result).toBe('success');
  });
  it('témoin : sans nom demandé, aucune vérification d’identité', () => {
    expect(handshake(undefined, ['DNS:www.example.com']).result).toBe('success');
  });
  it('un certificat d’un autre nom est refusé, avec l’alerte bad_certificate', () => {
    const client = handshake('www.example.com', ['DNS:evil.example.net']);
    expect(client.result).toBe('failure');
    expect(client.lastAlert?.description).toBe('bad_certificate');
  });
  it('un générique de l’autre domaine est refusé', () => {
    expect(handshake('www.example.com', ['DNS:*.example.net']).result).toBe('failure');
  });
});
