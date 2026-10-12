/**
 * Sonde : `TLS_CERT` / `TLS_KEY` sont montres au serveur qui demande un certificat
 * client, et c'est le sujet de ce certificat, ecrit comme `ldap_X509dn2bv` (RFC 4514,
 * ordre LDAP : dernier RDN du certificat en premier, noms d'attribut de libldap), qui
 * devient l'identite de SASL/EXTERNAL (« SASL username: ... »). Sans certificat
 * montre, le serveur ne propose pas EXTERNAL et le client ne le choisit pas.
 *
 * Autorite : le vrai `ldapwhoami -Y EXTERNAL` 2.6.10 (GnuTLS 3.8.3) contre un vrai
 * `slapd` (TLSVerifyClient try) avec cinq certificats clients emis par une AC et un sixieme d'une AC
 * inconnue du serveur (jamais envoye) : la ligne `SASL username:` de chacun est
 * consignee ci-dessous, et la reponse du
 * serveur (`dn:cn=alice martin,ou=staff,o=lab,c=fr`) montre que l'identite envoyee
 * est bien celle du certificat. Source lue : `tlsg_session_my_dn` de tls_g.c.
 *
 * Constats : l'ordre est inverse par rapport au certificat ; les types sont en
 * minuscules et `emailAddress` s'ecrit `email` ; `street`, `UID` et `serialNumber`
 * ne sont pas des noms que libldap connait et sortent en OID pointe
 * (2.5.4.9, 0.9.2342.19200300.100.1.1, 2.5.4.5) ; `GN` devient `givenName`.
 *
 * Mesure avant la modification : les 8 cas tombent (la fonction de format et le
 * champ `clientCertificateSent` n'existaient pas ; TLS_CERT et TLS_KEY etaient lus
 * mais jamais presentes, `clientDn` valait toujours null).
 *
 * Non modelise, nomme : un vrai serveur envoie la liste des autorites qu'il
 * accepte (`certificate_authorities`) et GnuTLS ne montre un certificat que si son
 * emetteur y figure (mesure : un certificat d'une AC inconnue du serveur n'est PAS
 * envoye, EXTERNAL n'est alors pas propose) ; la pile TLS simulee n'a pas cette
 * liste et montre son certificat a tout serveur qui en demande un. Le serveur AD du
 * laboratoire ne propose pas EXTERNAL (rien n'est mesurable contre un vrai AD :
 * l'association certificat / compte passe par altSecurityIdentities ou l'UPN).
 */
import { describe, expect, it } from 'vitest';
import { simulationNowMs } from '@/network/core/SystemClock';
import { defaultLdapOptions, TlsRequireCert } from '@/network/ldap/openldap/ldapOptions';
import { connectTls, type TlsConnectHost } from '@/network/ldap/openldap/tls/tlsConnect';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { ldapDistinguishedName } from '@/network/pki/der/DistinguishedName';
import { certToPem, privateKeyToPem } from '@/network/pki/pem';
import { TlsClientSession, type TlsClientConfig } from '@/network/tls/TlsClientSession';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import type { TlsRecord } from '@/network/tls/recordLayer';

const FORMATS: readonly (readonly [string, string])[] = [
  ['C = FR, O = Lab, OU = Staff, CN = Alice Martin', 'cn=Alice Martin,ou=Staff,o=Lab,c=FR'],
  ['C = FR, O = Evil, CN = Mallory', 'cn=Mallory,o=Evil,c=FR'],
  ['DC = local, DC = corp, CN = Users, CN = Bob', 'cn=Bob,cn=Users,dc=corp,dc=local'],
  ['C = FR, emailAddress = bob@lab.fr, CN = Bob', 'cn=Bob,email=bob@lab.fr,c=FR'],
  [
    'C = FR, ST = IdF, L = Paris, street = 1 rue X, O = Lab, OU = R&D, title = Dr, GN = Bob, SN = Dupont, serialNumber = 42, UID = bd, CN = Bob D',
    'cn=Bob D,0.9.2342.19200300.100.1.1=bd,2.5.4.5=42,sn=Dupont,givenName=Bob,title=Dr,ou=R&D,o=Lab,2.5.4.9=1 rue X,l=Paris,st=IdF,c=FR',
  ],
];

const NOW = simulationNowMs();
const FIVE_YEARS = 5 * 365 * 24 * 3600 * 1000;

describe('the client certificate of ldapsearch', () => {
  for (const [subject, expected] of FORMATS) {
    it(`${subject.slice(0, 48)} is written ${expected.slice(0, 48)}`, () => {
      expect(ldapDistinguishedName(subject)).toBe(expected);
    });
  }

  function fixture(requestClientCertificate: boolean) {
    const authority = CertificateAuthority.generate('CN=Lab CA', { now: NOW });
    const serverLeaf = authority.issueCertificate({ subject: 'CN=vm', notBefore: NOW - 1000, notAfter: NOW + FIVE_YEARS, subjectAltNames: ['DNS:vm'] });
    const clientLeaf = authority.issueCertificate({ subject: 'O=Lab,CN=Alice Martin', notBefore: NOW - 1000, notAfter: NOW + FIVE_YEARS });
    const encoder = new TextEncoder();
    const files: Readonly<Record<string, string>> = {
      '/ca.pem': certToPem(authority.rootCertificate), '/alice.pem': certToPem(clientLeaf.cert), '/alice.key': privateKeyToPem(clientLeaf.privateKey),
    };
    const server = new TlsServerSession({
      serverCert: serverLeaf.cert, serverPrivateKey: serverLeaf.privateKey,
      ...(requestClientCertificate ? {
        requestClientCert: true, clientCertPolicy: 'optional' as const,
        verifier: new CertificateVerifier({ trustAnchors: [authority.rootCertificate] }),
      } : {}),
    });
    let session: TlsClientSession | null = null;
    const host: TlsConnectHost = {
      files: {
        read: (path) => (path in files ? { bytes: encoder.encode(files[path]) } : { error: 'No such file or directory' }),
        regularFiles: () => null,
      },
      localFqdn: async () => 'vm',
      handshake(config: TlsClientConfig) {
        session = new TlsClientSession(config);
        let flight: readonly TlsRecord[] | null = session.start();
        for (let i = 0; i < 10 && server.result === null && flight !== null && flight.length > 0; i++) {
          const reply = server.handle(flight);
          if (reply === null) break;
          flight = session.handle(reply);
        }
        return {
          established: session.result === 'success', alert: session.lastAlert !== null, localAlert: null,
          certificate: session.peerCertificate, chain: session.peerCertificateChain, verification: { ok: true as const },
        };
      },
      detach: () => undefined,
    };
    return { host, server, clientLeaf, session: () => session };
  }

  async function connect(requestClientCertificate: boolean, withCertificate: boolean) {
    const lab = fixture(requestClientCertificate);
    const options = defaultLdapOptions();
    options.tls.requireCert = TlsRequireCert.NEVER;
    options.tls.caCertFile = '/ca.pem';
    if (withCertificate) {
      options.tls.certFile = '/alice.pem';
      options.tls.keyFile = '/alice.key';
    }
    const outcome = await connectTls({ serverName: 'vm', tls: options.tls, implicit: true, debug: () => undefined }, lab.host);
    return { outcome, lab };
  }

  it('is shown to a server that asks for one, which verifies it', async () => {
    const { outcome, lab } = await connect(true, true);
    expect(outcome.ok).toBe(true);
    expect(lab.session()?.clientCertificateSent?.subject).toBe(lab.clientLeaf.cert.subject);
    expect(lab.server.peerCertificate?.subject).toBe(lab.clientLeaf.cert.subject);
    expect(ldapDistinguishedName(lab.session()!.clientCertificateSent!.subject)).toBe('cn=Alice Martin,o=Lab');
  });

  it('is not shown to a server that does not ask (the lab is sound: the same files are configured)', async () => {
    const { outcome, lab } = await connect(false, true);
    expect(outcome.ok).toBe(true);
    expect(lab.session()?.clientCertificateSent).toBeNull();
    expect(lab.server.peerCertificate).toBeNull();
  });

  it('nothing is shown when no certificate is configured, even to a server that asks', async () => {
    const { outcome, lab } = await connect(true, false);
    expect(outcome.ok).toBe(true);
    expect(lab.session()?.clientCertificateSent).toBeNull();
  });
});
