/**
 * Sonde : `TLS_CRLFILE` charge une liste de revocation dans le contexte du client
 * (`gnutls_certificate_set_x509_crl_file`) et la verification de la chaine du
 * serveur la consulte : un certificat dont le numero de serie y figure, sous une
 * liste signee par SON emetteur, est refuse avec l'etat GnuTLS 0x22
 * (INVALID | REVOKED) ; `TLS_REQCERT hard` abandonne la connexion, `allow` ecrit la
 * ligne et continue, `never` ne verifie rien.
 *
 * Autorite : le vrai `ldapsearch` 2.6.10 (GnuTLS 3.8.3) contre un vrai `slapd`
 * (TLSVerifyClient try, certificat serveur emis par une AC RSA 2048), cinq listes x
 * trois valeurs de TLS_REQCERT, TLS_CRLCHECK=all positionne (sans effet sous
 * GnuTLS) : aucune liste, liste revoquant le certificat, liste vide, liste
 * revoquant le certificat mais PERIMEE depuis 2020, liste signee par une autre AC
 * qui cite le meme numero de serie.
 *
 * Constats : une liste perimee revoque quand meme (GnuTLS ne regarde pas
 * `nextUpdate`) ; une liste d'un autre emetteur est ignoree ; `never` n'ecrit
 * rien meme si le certificat est revoque ; `allow` ecrit la ligne 0x22 puis
 * aboutit.
 *
 * Mesure avant la modification : 2 des 16 cas tombent, les deux `allow` sur un
 * certificat revoque : le client acceptait en silence, alors que
 * `tlsg_session_accept` appelle `tlsg_cert_verify` (qui ecrit la ligne 0x22) puis
 * met seulement le code a zero pour ALLOW. Passent des deux cotes : les 14 autres
 * (la liste est lue par le contexte, 1a, et jugee par le verificateur de chaine,
 * y compris la liste perimee et celle d'un autre emetteur).
 */
import { describe, expect, it } from 'vitest';
import { simulationNowMs } from '@/network/core/SystemClock';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { certToPem, crlToPem } from '@/network/pki/pem';
import { defaultLdapOptions, TlsRequireCert } from '@/network/ldap/openldap/ldapOptions';
import { connectTls, type TlsConnectHost } from '@/network/ldap/openldap/tls/tlsConnect';
import { TlsClientSession, type TlsClientConfig } from '@/network/tls/TlsClientSession';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import type { TlsRecord } from '@/network/tls/recordLayer';

const NOW = simulationNowMs();
const FIVE_YEARS = 5 * 365 * 24 * 3600 * 1000;
const REVOKED_LINE = 'TLS: peer cert untrusted or revoked (0x22)';
const CANNOT_CONNECT = "TLS: can't connect: (unknown error code).";

interface Lab {
  readonly files: Readonly<Record<string, string>>;
  readonly server: () => TlsServerSession;
}

function lab(): Lab {
  const authority = CertificateAuthority.generate('CN=Lab CA', { now: NOW });
  const rogue = CertificateAuthority.generate('CN=Rogue CA', { now: NOW });
  const leaf = authority.issueCertificate({ subject: 'CN=vm', notBefore: NOW - 1000, notAfter: NOW + FIVE_YEARS, subjectAltNames: ['DNS:vm'] });
  const empty = authority.publishCRL(NOW);
  authority.revoke(leaf.cert.serialNumber, NOW - 5000);
  const revoked = authority.publishCRL(NOW);
  const stale = authority.publishCRL(NOW - 400 * 24 * 3600 * 1000, 30 * 24 * 3600 * 1000);
  rogue.revoke(leaf.cert.serialNumber, NOW - 5000);
  const foreign = rogue.publishCRL(NOW);
  return {
    files: {
      '/ca.pem': certToPem(authority.rootCertificate), '/crl-revoked.pem': crlToPem(revoked), '/crl-empty.pem': crlToPem(empty),
      '/crl-stale.pem': crlToPem(stale), '/crl-foreign.pem': crlToPem(foreign),
    },
    server: () => new TlsServerSession({ serverCert: leaf.cert, serverPrivateKey: leaf.privateKey }),
  };
}

function play(client: TlsClientSession, server: TlsServerSession): void {
  let flight: readonly TlsRecord[] | null = client.start();
  for (let i = 0; i < 10 && server.result === null && flight !== null && flight.length > 0; i++) {
    const reply = server.handle(flight);
    if (reply === null) break;
    flight = client.handle(reply);
  }
}

async function connect(
  fixture: Lab, crl: string | null, requireCert: number,
): Promise<{ lines: string[]; ok: boolean }> {
  const lines: string[] = [];
  const encoder = new TextEncoder();
  const options = defaultLdapOptions();
  options.tls.requireCert = requireCert;
  options.tls.caCertFile = '/ca.pem';
  options.tls.crlFile = crl;
  const host: TlsConnectHost = {
    files: {
      read: (path) => (path in fixture.files ? { bytes: encoder.encode(fixture.files[path]) } : { error: 'No such file or directory' }),
      regularFiles: () => null,
    },
    localFqdn: async () => 'vm',
    handshake(config: TlsClientConfig) {
      const session = new TlsClientSession(config);
      play(session, fixture.server());
      const verification = session.peerVerified
        ? { ok: true as const }
        : { ok: false as const, reason: session.peerVerificationReason ?? 'unknown' };
      return {
        established: session.result === 'success', alert: session.lastAlert !== null, localAlert: null,
        certificate: session.peerCertificate, chain: session.peerCertificateChain, verification,
      };
    },
    detach: () => undefined,
  };
  const outcome = await connectTls({ serverName: 'vm', tls: options.tls, implicit: true, debug: (_level: number, text: string) => { lines.push(text.trimEnd()); } }, host);
  return { lines, ok: outcome.ok };
}

const EXPECTED: readonly (readonly [string, string | null, readonly [number, string[], boolean][]])[] = [
  ['no list', null, [[TlsRequireCert.HARD, [], true], [TlsRequireCert.NEVER, [], true], [TlsRequireCert.ALLOW, [], true]]],
  ['a list revoking the certificate', '/crl-revoked.pem', [
    [TlsRequireCert.HARD, [REVOKED_LINE, CANNOT_CONNECT], false], [TlsRequireCert.NEVER, [], true], [TlsRequireCert.ALLOW, [REVOKED_LINE], true],
  ]],
  ['an empty list', '/crl-empty.pem', [[TlsRequireCert.HARD, [], true], [TlsRequireCert.NEVER, [], true], [TlsRequireCert.ALLOW, [], true]]],
  ['a stale list that revokes it', '/crl-stale.pem', [
    [TlsRequireCert.HARD, [REVOKED_LINE, CANNOT_CONNECT], false], [TlsRequireCert.NEVER, [], true], [TlsRequireCert.ALLOW, [REVOKED_LINE], true],
  ]],
  ['a list signed by another authority', '/crl-foreign.pem', [[TlsRequireCert.HARD, [], true], [TlsRequireCert.NEVER, [], true], [TlsRequireCert.ALLOW, [], true]]],
];

describe('TLS_CRLFILE is honoured like libldap does', () => {
  const fixture = lab();

  it('the lab is sound: without any list the certificate of the server is accepted', async () => {
    const outcome = await connect(fixture, null, TlsRequireCert.HARD);
    expect(outcome).toEqual({ lines: [], ok: true });
  });

  for (const [name, file, rows] of EXPECTED) {
    for (const [mode, lines, ok] of rows) {
      it(`${name} under TLS_REQCERT ${Object.entries(TlsRequireCert).find(([, value]) => value === mode)?.[0].toLowerCase()}`, async () => {
        const outcome = await connect(fixture, file, mode);
        expect(outcome.lines.filter((line) => line.startsWith('TLS: peer') || line.startsWith("TLS: can't"))).toEqual(lines);
        expect(outcome.ok).toBe(ok);
      });
    }
  }
});
