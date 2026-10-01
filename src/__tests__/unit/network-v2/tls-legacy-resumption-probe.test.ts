/**
 * TLS ≤ 1.2 : reprise de session par identifiant (RFC 5246 §7.3), par
 * ticket (RFC 5077), extended_master_secret (RFC 7627) et
 * renegotiation_info (RFC 5746).
 *
 * MESURÉ avant correctif : aucune reprise ≤ 1.2 (chaque connexion refaisait
 * la poignée de main complète avec certificat), le master secret ne
 * dépendait pas du condensé de session (attaque de triple poignée de
 * main, RFC 7627 §1) et ni renegotiation_info ni le SCSV n'existaient
 * (renégociation non sûre, RFC 5746 §1).
 *
 * Avant correctif, 13 des 15 cas tombent ; les deux témoins (une poignée de
 * main complète sans cache conclut avec un sessionId vide ; un serveur sans
 * EMS n'envoie pas l'extension) passent dans les deux états.
 */
import { describe, it, expect } from 'vitest';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsServerSession, type TlsServerConfig } from '@/network/tls/TlsServerSession';
import { TlsClientSession, type TlsClientConfig } from '@/network/tls/TlsClientSession';
import type { TlsRecord } from '@/network/tls/recordLayer';
import { encryptApplicationData, decryptApplicationData } from '@/network/http/https/ApplicationDataCipher';
import { LegacySessionStore } from '@/network/tls/legacy/legacySessions';
import { bytesToUtf8, utf8ToBytes } from '@/crypto/encoding';

const NOW = Date.now();
const ca = CertificateAuthority.generate('CN=Root', { now: NOW });
const leaf = ca.issueCertificate({ subject: 'CN=srv', notBefore: NOW - 1000, notAfter: NOW + 1e9, subjectAltNames: ['srv.lab'] } as never);
const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

function connect(
  client: Partial<TlsClientConfig>, server: Partial<TlsServerConfig>,
  tamper?: (records: readonly TlsRecord[], direction: 'up' | 'down') => readonly TlsRecord[],
) {
  const s = new TlsServerSession({ serverCert: leaf.cert, serverPrivateKey: leaf.privateKey, ...server });
  const c = new TlsClientSession({ verifier, serverName: 'srv.lab', versions: ['1.2'], ...client });
  const up: TlsRecord[][] = []; const down: TlsRecord[][] = [];
  let out: readonly TlsRecord[] | null = c.start();
  for (let i = 0; i < 6 && out !== null && out.length > 0; i++) {
    if (tamper) out = tamper(out, 'up');
    up.push([...out]);
    let reply: readonly TlsRecord[] | null = s.handle(out);
    if (reply === null || reply.length === 0) break;
    if (tamper) reply = tamper(reply, 'down');
    down.push([...reply]);
    out = c.handle(reply);
  }
  return { client: c, server: s, up, down };
}

function json(record: TlsRecord): { kind: string; [key: string]: unknown }[] {
  const parsed = JSON.parse(bytesToUtf8(record.fragment));
  return Array.isArray(parsed) ? parsed : [parsed];
}

function exchange(client: TlsClientSession, server: TlsServerSession): void {
  const sealed = encryptApplicationData(client.clientTraffic(), 0, utf8ToBytes('ping'));
  expect(bytesToUtf8(decryptApplicationData(server.clientTraffic(), 0, sealed.records).plaintext)).toBe('ping');
  const reply = encryptApplicationData(server.serverTraffic(), 0, utf8ToBytes('pong'));
  expect(bytesToUtf8(decryptApplicationData(client.serverTraffic(), 0, reply.records).plaintext)).toBe('pong');
}

const KEY = new Uint8Array(32).fill(7);

describe('extended_master_secret (RFC 7627) et renegotiation_info (RFC 5746)', () => {
  it('témoin : sans cache, la poignée de main complète conclut et le ServerHello a un sessionId vide', () => {
    const { client, down } = connect({}, {});
    expect(client.result).toBe('success');
    expect(json(down[0][0]).find((m) => m.kind === 'legacy_server_hello')!.sessionId).toBe('');
  });

  it('par défaut les deux extensions sont offertes et renvoyées', () => {
    const { up, down } = connect({}, {});
    const hello = JSON.parse(bytesToUtf8(up[0][0].fragment));
    expect(hello.legacyExtensions.extendedMasterSecret).toBe(true);
    expect(hello.legacyExtensions.renegotiationInfo).toBe('');
    const serverHello = json(down[0][0]).find((m) => m.kind === 'legacy_server_hello') as unknown as { extensions: Record<string, unknown> };
    expect(serverHello.extensions.extendedMasterSecret).toBe(true);
    expect(serverHello.extensions.renegotiationInfo).toBe('');
  });

  it('un serveur sans EMS : pas d\'extension renvoyée, la poignée de main conclut quand même', () => {
    const { client, down } = connect({}, { extendedMasterSecret: false });
    expect(client.result).toBe('success');
    const serverHello = json(down[0][0]).find((m) => m.kind === 'legacy_server_hello') as unknown as { extensions: Record<string, unknown> };
    expect(serverHello.extensions.extendedMasterSecret).toBeUndefined();
  });

  it('RFC 5746 §3.5 : un ClientHello initial à renegotiation_info non vide est refusé', () => {
    const { server } = connect({}, {}, (records, direction) => {
      if (direction !== 'up' || records[0].contentType !== 'handshake') return records;
      const hello = JSON.parse(bytesToUtf8(records[0].fragment));
      hello.legacyExtensions.renegotiationInfo = 'abcd';
      return [{ ...records[0], fragment: utf8ToBytes(JSON.stringify(hello)) }];
    });
    expect(server.result).toBe('reject');
    expect(server.lastAlert?.description).toBe('handshake_failure');
  });

  function stripRenegotiation(records: readonly TlsRecord[], direction: 'up' | 'down'): readonly TlsRecord[] {
    if (direction !== 'down' || records[0].contentType !== 'handshake') return records;
    const bundle = json(records[0]) as { kind: string; extensions?: Record<string, unknown> }[];
    for (const message of bundle) if (message.kind === 'legacy_server_hello') delete message.extensions!.renegotiationInfo;
    return [{ ...records[0], fragment: utf8ToBytes(JSON.stringify(bundle)) }, ...records.slice(1)];
  }

  it('RFC 5746 §4.1 : un client abandonne devant un serveur sans renegotiation_info', () => {
    const { client } = connect({}, {}, stripRenegotiation);
    expect(client.result).toBe('failure');
    expect(client.lastAlert?.description).toBe('handshake_failure');
  });
});

describe('reprise par identifiant de session (RFC 5246 §7.3)', () => {
  it('le ServerHello d\'une poignée de main complète porte un identifiant de 32 octets', () => {
    const store = new LegacySessionStore();
    const { down, client } = connect({}, { legacySessionStore: store });
    const hello = json(down[0][0]).find((m) => m.kind === 'legacy_server_hello')!;
    expect(String(hello.sessionId)).toMatch(/^[0-9a-f]{64}$/);
    expect(store.size).toBe(1);
    expect(client.exportLegacySession()?.state.id).toBe(hello.sessionId);
  });

  it('une seconde connexion reprend : poignée de main abrégée, sans certificat, données échangées', () => {
    const store = new LegacySessionStore();
    const first = connect({}, { legacySessionStore: store });
    const session = first.client.exportLegacySession()!;
    const second = connect({ legacySession: session }, { legacySessionStore: store });
    expect(second.client.result).toBe('success');
    expect(second.client.legacyResumed).toBe(true);
    const flight = second.down[0];
    expect(flight.map((r) => r.contentType)).toEqual(['handshake', 'change_cipher_spec', 'handshake']);
    expect(JSON.stringify(json(flight[0]))).not.toContain('legacy_certificate');
    exchange(second.client, second.server);
  });

  it('le master secret mis en cache décide : un master altéré côté client est refusé par le Finished', () => {
    const store = new LegacySessionStore();
    const first = connect({}, { legacySessionStore: store });
    const session = first.client.exportLegacySession()!;
    const forged = { ...session, state: { ...session.state, master: '00'.repeat(48) } };
    const second = connect({ legacySession: forged }, { legacySessionStore: store });
    expect(second.client.result).toBe('failure');
  });

  it('un identifiant inconnu donne une poignée de main complète', () => {
    const store = new LegacySessionStore();
    const first = connect({}, { legacySessionStore: store });
    const session = first.client.exportLegacySession()!;
    const second = connect({ legacySession: session }, { legacySessionStore: new LegacySessionStore() });
    expect(second.client.result).toBe('success');
    expect(second.client.legacyResumed).toBe(false);
  });

  it('une session expirée n\'est pas reprise', () => {
    let now = NOW;
    const store = new LegacySessionStore(60, () => now);
    const first = connect({}, { legacySessionStore: store });
    now += 61_000;
    const second = connect({ legacySession: first.client.exportLegacySession()! }, { legacySessionStore: store });
    expect(second.client.legacyResumed).toBe(false);
    expect(second.client.result).toBe('success');
  });

  it('RFC 7627 §5.3 : session EMS reprise par un client sans EMS → le serveur abandonne', () => {
    const store = new LegacySessionStore();
    const first = connect({}, { legacySessionStore: store });
    const second = connect(
      { legacySession: first.client.exportLegacySession()!, extendedMasterSecret: false }, { legacySessionStore: store },
    );
    expect(second.server.result).toBe('reject');
    expect(second.server.lastAlert?.description).toBe('handshake_failure');
  });

  it('RFC 7627 §5.3 : session sans EMS, client EMS → poignée de main complète, pas de reprise', () => {
    const store = new LegacySessionStore();
    const first = connect({ extendedMasterSecret: false }, { legacySessionStore: store, extendedMasterSecret: false });
    const second = connect({ legacySession: first.client.exportLegacySession()! }, { legacySessionStore: store });
    expect(second.client.result).toBe('success');
    expect(second.client.legacyResumed).toBe(false);
  });
});

describe('reprise par ticket (RFC 5077)', () => {
  it('un NewSessionTicket est émis avant ChangeCipherSpec et le client le conserve', () => {
    const { down, client } = connect({}, { sessionTicketKey: KEY });
    expect(down[1].map((r) => r.contentType)).toEqual(['handshake', 'change_cipher_spec', 'handshake']);
    expect(json(down[1][0])[0].kind).toBe('legacy_new_session_ticket');
    expect(client.exportLegacySession()?.ticket).toMatch(/^[0-9a-f]+$/);
  });

  it('un AUTRE serveur, sans cache mais avec la même clé, reprend la session (sans état)', () => {
    const first = connect({}, { sessionTicketKey: KEY });
    const second = connect({ legacySession: first.client.exportLegacySession()! }, { sessionTicketKey: KEY });
    expect(second.client.legacyResumed).toBe(true);
    exchange(second.client, second.server);
  });

  it('un serveur avec une autre clé ne peut pas ouvrir le ticket : poignée de main complète', () => {
    const first = connect({}, { sessionTicketKey: KEY });
    const second = connect(
      { legacySession: first.client.exportLegacySession()! }, { sessionTicketKey: new Uint8Array(32).fill(9) },
    );
    expect(second.client.result).toBe('success');
    expect(second.client.legacyResumed).toBe(false);
  });
});
