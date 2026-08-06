/**
 * Un groupe qu'on ne sait pas calculer ne se négocie pas.
 *
 * **Le défaut, mesuré avant d'être corrigé.** Depuis l'étage 3, `x25519`
 * puis `secp256r1` font un vrai ECDH, et `sharedSecret` abandonne quand
 * le résultat est un point d'ordre faible. Mais tout AUTRE groupe
 * retombait sur `simulatedDigest(aléa_client | aléa_serveur |
 * part_client | part_serveur)` — les quatre valeurs PUBLIQUES de la
 * poignée de main. Une session configurée des deux côtés sur
 * `secp384r1` réussissait donc, et les deux bouts tombaient d'accord sur
 * un secret que n'importe quel témoin recalculait. C'est exactement le
 * défaut que l'étage 3 avait retiré à `x25519`, resté intact partout
 * ailleurs, et il ne se voyait pas parce qu'aucun test ne configurait
 * `secp384r1` des DEUX côtés : les deux qui le nommaient s'en servaient
 * pour provoquer une absence de groupe commun.
 *
 * Le correctif ne consiste pas à implémenter P-384 mais à cesser de
 * prétendre : les deux sessions n'offrent et n'acceptent que ce qu'elles
 * savent calculer, et `sharedSecret` rend `null` — donc une alerte —
 * plutôt qu'une valeur. Une vraie pile TLS ne propose pas un groupe dont
 * elle n'a pas le code.
 *
 * La référence `x25519` dans le MÊME laboratoire est indispensable :
 * sans elle, un labo mal monté et un refus correct seraient
 * indiscernables, les deux se soldant par un échec.
 */

import { describe, it, expect } from 'vitest';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import type { TlsRecord } from '@/network/tls/recordLayer';
import {
  generateKeyExchange, sharedSecret, isImplementedGroup, IMPLEMENTED_GROUPS,
  X25519_GROUP, P256_GROUP,
} from '@/network/tls/keyExchange';

const NOW = Date.parse('2026-02-01T00:00:00Z');

function lab(groupesClient: readonly string[], groupesServeur = groupesClient) {
  const ca = CertificateAuthority.generate('CN=Lab Root CA', { now: NOW });
  const feuille = ca.issueCertificate({
    subject: 'CN=serveur.lab', notBefore: NOW - 1000, notAfter: NOW + 1e9,
  });
  const verifier = new CertificateVerifier({
    trustAnchors: [ca.rootCertificate], clock: () => NOW,
  });
  return {
    server: new TlsServerSession({
      serverCert: feuille.cert, serverPrivateKey: feuille.privateKey,
      supportedGroups: groupesServeur,
    }),
    client: new TlsClientSession({ verifier, supportedGroups: groupesClient }),
  };
}

function jouer(client: TlsClientSession, server: TlsServerSession): void {
  let flight: readonly TlsRecord[] | null = client.start();
  for (let i = 0; i < 10 && server.result === null && flight !== null && flight.length > 0; i++) {
    const reponse = server.handle(flight);
    if (reponse === null) break;
    flight = client.handle(reponse);
  }
}

function decoder(record: TlsRecord): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(record.fragment));
}

describe('la table des groupes dit la vérité', () => {
  it('elle contient exactement ceux qui ont du code derrière', () => {
    expect([...IMPLEMENTED_GROUPS].sort()).toEqual([P256_GROUP, X25519_GROUP].sort());
    expect(isImplementedGroup(X25519_GROUP)).toBe(true);
    expect(isImplementedGroup(P256_GROUP)).toBe(true);
  });

  it('et pas ceux dont ce build n\'a que le nom', () => {
    for (const groupe of ['secp384r1', 'secp521r1', 'ffdhe2048', 'x448']) {
      expect(isImplementedGroup(groupe)).toBe(false);
    }
  });
});

describe('sharedSecret abandonne au lieu de fabriquer', () => {
  it('un groupe sans implémentation ne rend PAS de secret', () => {
    const a = generateKeyExchange('secp384r1');
    const b = generateKeyExchange('secp384r1');
    expect(sharedSecret(a, b.share)).toBeNull();
    expect(sharedSecret(b, a.share)).toBeNull();
  });

  it('une part de pair malformée non plus', () => {
    // Auparavant ce cas rendait un condensé du contexte : les deux bouts
    // ne pouvaient de toute façon pas s'accorder, mais l'échec arrivait
    // plus tard et sous un autre nom que le sien.
    const kp = generateKeyExchange(X25519_GROUP);
    expect(sharedSecret(kp, 'x25519:pastdelhexa')).toBeNull();
    expect(sharedSecret(kp, 'secp256r1:04aabb')).toBeNull();
    expect(sharedSecret(kp, 'sans-separateur')).toBeNull();
  });

  it('mais un vrai groupe rend toujours le même secret des deux côtés', () => {
    for (const groupe of IMPLEMENTED_GROUPS) {
      const a = generateKeyExchange(groupe);
      const b = generateKeyExchange(groupe);
      const cote = sharedSecret(a, b.share);
      expect(cote).not.toBeNull();
      expect(sharedSecret(b, a.share)).toBe(cote);
    }
  });
});

describe('une poignée de main ne se conclut plus sur un faux secret', () => {
  it('secp384r1 des DEUX côtés échoue désormais', () => {
    const { client, server } = lab(['secp384r1']);
    jouer(client, server);

    expect(client.result).not.toBe('success');
    expect(server.result).not.toBe('accept');
  });

  it('alors que x25519 dans le même laboratoire réussit', () => {
    const { client, server } = lab([X25519_GROUP]);
    jouer(client, server);

    expect(client.result).toBe('success');
    expect(server.result).toBe('accept');
    expect(client.serverApplicationTrafficSecret)
      .toBe(server.serverApplicationTrafficSecret);
  });

  it('et secp256r1 aussi', () => {
    const { client, server } = lab([P256_GROUP]);
    jouer(client, server);
    expect(client.result).toBe('success');
    expect(client.clientApplicationTrafficSecret)
      .toBe(server.clientApplicationTrafficSecret);
  });
});

describe('le client n\'offre que ce qu\'il sait calculer', () => {
  it('un groupe non implémenté disparaît du ClientHello', () => {
    const { client } = lab(['secp384r1', X25519_GROUP]);
    const hello = decoder(client.start()[0]);
    const extensions = hello.extensions as { supportedGroups: string[]; keyShare: string };

    expect(extensions.supportedGroups).toEqual([X25519_GROUP]);
    // Et la part envoyée est bien celle du groupe restant : annoncer
    // x25519 tout en envoyant une part P-384 serait la même erreur d'un
    // cran plus loin.
    expect(extensions.keyShare.startsWith(`${X25519_GROUP}:`)).toBe(true);
  });

  it('un client qui n\'a QUE des groupes non implémentés n\'émet rien', () => {
    const { client } = lab(['secp384r1', 'ffdhe2048']);
    expect(client.start()).toHaveLength(0);
    expect(client.result).toBe('failure');
    expect(client.lastAlert?.description).toBe('handshake_failure');
  });
});

describe('le serveur ne sélectionne pas un groupe qu\'il ne sait pas calculer', () => {
  it('il refuse plutôt que d\'imposer secp384r1 par HelloRetryRequest', () => {
    // Le client propose les deux ; le serveur ne connaît vraiment aucun
    // des siens, il n'a donc rien à retenir.
    const { client, server } = lab([X25519_GROUP, 'secp384r1'], ['secp384r1']);
    const reponse = server.handle(client.start());

    expect(reponse).toBeNull();
    expect(server.result).toBe('reject');
    expect(server.lastAlert?.description).toBe('handshake_failure');
  });

  it('mais un HelloRetryRequest vers un groupe réel fonctionne toujours', () => {
    // Non-régression : c'est le cas nominal du §4.1.4, et il ne doit rien
    // devoir au filtrage.
    const { client, server } = lab([X25519_GROUP, P256_GROUP], [P256_GROUP]);
    jouer(client, server);

    expect(client.result).toBe('success');
    expect(server.result).toBe('accept');
    expect(client.serverApplicationTrafficSecret)
      .toBe(server.serverApplicationTrafficSecret);
  });
});
