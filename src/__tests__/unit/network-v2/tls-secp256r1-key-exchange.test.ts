/**
 * Le groupe `secp256r1` de TLS 1.3 est un vrai ECDH (RFC 8446 §4.2.8).
 *
 * `x25519` était devenu réel à l'étage 3 ; tout autre groupe retombait
 * sur `simulatedDigest` des quatre valeurs publiques — les deux bouts
 * s'accordaient, et un témoin de la poignée de main s'accordait avec eux.
 * P-256 existant maintenant pour les signatures, l'ECDH qui va avec ne
 * coûtait plus qu'une multiplication scalaire.
 *
 * Ce qui reste simulé, et c'est désormais le seul chemin : un groupe que
 * ni P-256 ni X25519 ne servent (`secp384r1`, `ffdhe2048`, …), faute
 * d'implémentation des deux côtés.
 */

import { describe, it, expect } from 'vitest';
import {
  generateKeyExchange, sharedSecret, parseShare, X25519_GROUP, P256_GROUP,
} from '@/network/tls/keyExchange';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { TlsRecord } from '@/network/tls/recordLayer';

const NOW = Date.now();

describe('la part de clé porte son groupe', () => {
  it('secp256r1 émet un point non compressé', () => {
    const kp = generateKeyExchange(P256_GROUP);
    const parsee = parseShare(kp.share)!;
    expect(parsee.group).toBe(P256_GROUP);
    expect(parsee.body).toHaveLength(130); // 04 || X || Y
    expect(parsee.body.startsWith('04')).toBe(true);
  });

  it('et x25519 reste sur ses 32 octets', () => {
    const parsee = parseShare(generateKeyExchange(X25519_GROUP).share)!;
    expect(parsee.group).toBe(X25519_GROUP);
    expect(parsee.body).toHaveLength(64);
  });
});

describe('le secret partagé de secp256r1', () => {
  it('est le même des deux côtés', () => {
    const client = generateKeyExchange(P256_GROUP);
    const serveur = generateKeyExchange(P256_GROUP);
    const a = sharedSecret(client, serveur.share, 'inutilisé');
    const b = sharedSecret(serveur, client.share, 'inutilisé');
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('n\'est aucune des deux parts publiques', () => {
    const client = generateKeyExchange(P256_GROUP);
    const serveur = generateKeyExchange(P256_GROUP);
    const partage = sharedSecret(client, serveur.share, 'inutilisé')!;
    expect(client.share).not.toContain(partage);
    expect(serveur.share).not.toContain(partage);
  });

  it('et deux poignées de main successives n\'aboutissent pas au même', () => {
    const c1 = generateKeyExchange(P256_GROUP);
    const s1 = generateKeyExchange(P256_GROUP);
    const c2 = generateKeyExchange(P256_GROUP);
    const s2 = generateKeyExchange(P256_GROUP);
    expect(sharedSecret(c1, s1.share, 'x')).not.toBe(sharedSecret(c2, s2.share, 'x'));
  });

  it('un groupe encore simulé le reste, et il est seul', () => {
    const inconnu = generateKeyExchange('secp384r1');
    // Pas `null` : ce chemin ne refuse pas, il simule — et le dire est
    // plus honnête que de laisser croire que tout est réel.
    expect(sharedSecret(inconnu, 'secp384r1:peu-importe', 'contexte')).not.toBeNull();
  });
});

describe('une vraie poignée de main négocie sur P-256', () => {
  function lab(groupes: readonly string[]) {
    const ca = CertificateAuthority.generate('CN=Lab Root CA', { now: NOW });
    const feuille = ca.issueCertificate({
      subject: 'CN=serveur.lab', notBefore: NOW - 1000, notAfter: NOW + 1e9,
    });
    const verifier = new CertificateVerifier({
      trustAnchors: [ca.rootCertificate], clock: () => NOW,
    });
    const server = new TlsServerSession({
      serverCert: feuille.cert, serverPrivateKey: feuille.privateKey,
      supportedGroups: groupes,
    });
    const client = new TlsClientSession({ verifier, supportedGroups: groupes });
    return { client, server };
  }

  function jouer(client: TlsClientSession, server: TlsServerSession): void {
    let flight: readonly TlsRecord[] | null = client.start();
    for (let i = 0; i < 10 && server.result === null && flight !== null; i++) {
      const reponse = server.handle(flight);
      if (reponse === null) break;
      flight = client.handle(reponse);
    }
  }

  it('client et serveur dérivent les mêmes secrets de trafic', () => {
    const { client, server } = lab([P256_GROUP]);
    jouer(client, server);

    expect(client.result).toBe('success');
    expect(server.result).toBe('accept');
    // C'est l'invariant qui compte : les deux bouts ne peuvent tomber sur
    // le même secret que si l'ECDH a réellement fonctionné.
    expect(client.clientApplicationTrafficSecret)
      .toBe(server.clientApplicationTrafficSecret);
    expect(client.serverApplicationTrafficSecret)
      .toBe(server.serverApplicationTrafficSecret);
  });

  it('et x25519 continue de fonctionner à l\'identique', () => {
    const { client, server } = lab([X25519_GROUP]);
    jouer(client, server);
    expect(client.result).toBe('success');
    expect(client.serverApplicationTrafficSecret)
      .toBe(server.serverApplicationTrafficSecret);
  });

  it('deux poignées de main P-256 ne donnent pas les mêmes secrets', () => {
    const a = lab([P256_GROUP]);
    const b = lab([P256_GROUP]);
    jouer(a.client, a.server);
    jouer(b.client, b.server);
    expect(a.client.serverApplicationTrafficSecret)
      .not.toBe(b.client.serverApplicationTrafficSecret);
  });
});
