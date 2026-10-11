/**
 * Sonde : `TLS_CIPHER_SUITE` (`LDAPTLS_CIPHER_SUITE`) est evaluee par
 * `ldapsearch` de bout en bout, de la commande a la poignee de main avec le
 * controleur de domaine du laboratoire : la chaine restreint ce que le client
 * annonce, et l'echec se raconte avec les phrases de libldap / GnuTLS.
 *
 * Autorite : le vrai `ldapsearch` 2.6.10 (GnuTLS 3.8.3). Les phrases viennent de
 * `gnutls_strerror` et ont ete lues sur le vrai client : « A TLS fatal alert has
 * been received. » (alerte du pair, 53 couples face a `openssl s_server`, sonde
 * voisine), « No or insufficient priorities were set. » (aucune version TLS
 * utilisable : TLS 1.3 retire sans groupe, DTLS seul, %NO_EXTENSIONS sans
 * TLS 1.2), « The TLS connection was non-properly terminated. » (`ldaps://` sur
 * le port `ldap://` d'un vrai slapd, qui ferme sans repondre). Sous StartTLS le
 * meme texte est rendu en « additional info: ... » apres « Connect error (-11) ».
 * Le certificat du controleur est RSA : SUITEB128 (ECDSA seul) et une liste de
 * signatures ECDSA n'ont aucune suite commune avec lui.
 *
 * Mesure avant la modification (partie poignee de main) : 9 des 13 cas tombent (la chaine n'etait pas
 * evaluee : tout aboutissait comme NORMAL, et l'echec d'une poignee de main
 * se disait « (unknown error code) »). Passent des deux cotes : le temoin
 * NORMAL, les deux retraits de version qui laissent l'autre version negociable,
 * et le retrait des groupes (TLS 1.2 par echange RSA).
 *
 * Profil de verification : le controleur presente un certificat RSA de 2048 bits
 * (taille du gabarit « Controleur de domaine » d'AD CS ; le simulateur en donnait
 * un de 1024). Avec l'ancre installee, NORMAL / LEGACY / %PROFILE_LOW /
 * %PROFILE_MEDIUM l'acceptent, %PROFILE_HIGH / ULTRA / FUTURE / SUITEB128 / SUITEB192
 * le refusent par « peer cert untrusted or revoked (0x102) » (mesures de la sonde
 * gnutls-verification-profile). Avant la modification : 5 de ces cas tombent.
 * SECURE192 n'y figure pas : il demande secp384r1, que la pile ne calcule pas.
 *
 * Non attestable : ce qu'un vrai controleur Active Directory (Schannel) repond a
 * un client sans suite commune (alerte ou fermeture) ; un vrai slapd ferme sans
 * alerte dans ce cas, le laboratoire envoie l'alerte comme le fait la pile TLS
 * simulee de tous ses serveurs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { LinuxPC } from '@/network/devices/LinuxPC';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { DC_ADDRESS, buildLab } from './openldap-lab-support';

const ALERT = "TLS: can't connect: A TLS fatal alert has been received..";
const NO_PRIORITIES = "TLS: can't connect: No or insufficient priorities were set..";

const CASES: readonly (readonly [string, string | null])[] = [
  ['NORMAL', null],
  ['NORMAL:-VERS-TLS1.3', null],
  ['NORMAL:-VERS-TLS1.2', null],
  ['NORMAL:-GROUP-ALL', null],
  ['SUITEB128', ALERT],
  ['NORMAL:-SIGN-ALL:+SIGN-ECDSA-SHA256', ALERT],
  ['NORMAL:-VERS-TLS1.3:-ECDHE-RSA:-RSA:-DHE-RSA', ALERT],
  ['NONE:+VERS-TLS1.3:+AES-128-GCM:+AEAD:+SIGN-ALL', NO_PRIORITIES],
  ['NORMAL:-VERS-ALL:+VERS-DTLS1.2', NO_PRIORITIES],
  ['NORMAL:%NO_EXTENSIONS:-VERS-TLS1.2', NO_PRIORITIES],
];

describe('TLS_CIPHER_SUITE decides the handshake of ldapsearch with the domain controller', () => {
  let workstation: LinuxPC;

  beforeAll(async () => {
    workstation = (await buildLab()).workstation;
  }, 120000);

  function search(priority: string, mode = `-H ldaps://${DC_ADDRESS}`): Promise<string> {
    return workstation.executeCommand(
      `LDAPTLS_REQCERT=never LDAPTLS_CIPHER_SUITE='${priority}' ldapsearch -d -1 -x ${mode} -b '' -s base -LLL dn 2>&1`,
    );
  }

  for (const [priority, line] of CASES) {
    it(`${priority} ${line === null ? 'reaches the directory' : `fails with ${line.replace("TLS: can't connect: ", '')}`}`, async () => {
      const output = await search(priority);
      if (line === null) {
        expect(output).toContain('dn:');
        expect(output).not.toContain("TLS: can't connect");
      } else {
        expect(output).toContain(line);
        expect(output).toContain("Can't contact LDAP server (-1)");
        expect(output).not.toContain('dn:');
      }
    });
  }

  it('under StartTLS the text becomes additional information of a connect error', async () => {
    const output = await search('SUITEB128', `-H ldap://${DC_ADDRESS} -ZZ`);
    expect(output).toContain('ldap_start_tls: Connect error (-11)');
    expect(output).toContain('additional info: A TLS fatal alert has been received.');
  });

  it('a string libldap cannot parse stops before any byte is sent', async () => {
    const output = await search('NORMAL:-CIPHER-ALL');
    expect(output).toContain('TLS: could not set cipher list NORMAL:-CIPHER-ALL.');
    expect(output).not.toContain("TLS: can't connect");
  });

  it('a server that is not speaking TLS ends the handshake without an alert', async () => {
    const output = await search('NORMAL', `-H ldaps://${DC_ADDRESS}:389`);
    expect(output).toContain("TLS: can't connect: The TLS connection was non-properly terminated..");
  });
});

describe('the verification profile of the priority string judges the certificate of the domain controller', () => {
  let workstation: LinuxPC;

  beforeAll(async () => {
    const lab = await buildLab();
    workstation = lab.workstation;
    await workstation.executeCommand(`echo '${DC_ADDRESS} dc01.corp.local dc01' >> /etc/hosts`);
    await workstation.executeCommand(`LDAPTLS_REQCERT=never ldapsearch -x -H ldaps://${DC_ADDRESS} -b '' -s base -LLL dn`);
    const identity = (lab.controller as unknown as { ldapStartTlsIdentity: { cert: X509Certificate } }).ldapStartTlsIdentity;
    workstation.addTrustedCertificateAuthority(identity.cert);
  }, 120000);

  function strict(priority: string): Promise<string> {
    return workstation.executeCommand(
      `LDAPTLS_CIPHER_SUITE='${priority}' ldapsearch -d -1 -x -H ldaps://dc01.corp.local -b '' -s base -LLL dn 2>&1`,
    );
  }

  for (const [priority, accepted] of [
    ['NORMAL', true], ['LEGACY', true], ['NORMAL:%PROFILE_LOW', true], ['NORMAL:%PROFILE_MEDIUM', true],
    ['NORMAL:%PROFILE_HIGH', false], ['NORMAL:%PROFILE_ULTRA', false], ['NORMAL:%PROFILE_FUTURE', false],
    ['NORMAL:%PROFILE_SUITEB128', false], ['NORMAL:%PROFILE_SUITEB192', false],
  ] as const) {
    it(`${priority} ${accepted ? 'accepts' : 'refuses (0x102)'} a 2048-bit RSA certificate`, async () => {
      const output = await strict(priority);
      if (accepted) {
        expect(output).toContain('dn:');
        expect(output).not.toContain('peer cert untrusted');
      } else {
        expect(output).toContain('TLS: peer cert untrusted or revoked (0x102)');
        expect(output).toContain("TLS: can't connect: (unknown error code).");
        expect(output).not.toContain('dn:');
      }
    });
  }
});
