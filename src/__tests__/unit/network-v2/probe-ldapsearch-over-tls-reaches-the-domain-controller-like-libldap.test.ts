/**
 * Sonde : un poste Linux interroge le controleur de domaine en LDAPS et en
 * StartTLS, et le sort de la connexion suit les regles de libldap : le nom
 * demande doit figurer dans le certificat selon `TLS_REQCERT` et `TLS_REQSAN`,
 * la cle publique doit correspondre a `TLS_PEERKEY_HASH` si on l'a epinglee, le
 * magasin de confiance de la machine est ce que `/etc/ssl/certs/ca-certificates.crt`
 * contient. Le DC presente un certificat auto-signe au nom DNS de la machine
 * (CN et SAN `dc01.corp.local`), comme une vraie machine du domaine.
 *
 * Autorite : le jeu complet de 600 combinaisons du vrai client est rejoue sans
 * reseau dans `probe-ldapsearch-judges-the-tls-peer-like-libldap` ; cette sonde
 * ne verifie que le raccordement de bout en bout au DC du simulateur, dont
 * les issues sont celles que ces regles donnent a CE certificat (verifiees ici
 * contre les memes regles lues dans tls_g.c de OPENLDAP_REL_ENG_2_6_10).
 * Non attestable : le certificat qu'un vrai controleur Active Directory
 * presente (modele de certificat, chaine, SAN supplementaires).
 *
 * Mesure avant la modification : 11 des 13 cas tombent (le DC presentait
 * « CN=CORP.LOCAL » sans SAN, le nom n'etait pas verifie a la facon de libldap
 * et l'epinglage n'existait pas). Passent avant comme apres : « REQCERT never et
 * allow levent le controle du nom, try le garde » — l'ancien verificateur du
 * RFC 6125 refusait deja un nom etranger pour try — et « les options que GnuTLS
 * ignore » (PROTOCOL_MIN / PROTOCOL_MAX, ECNAME, CRLCHECK, RANDFILE, DHFILE : le
 * vrai client les accepte puis n'en fait rien ; mesure avec les sept valeurs
 * ci-dessous, contre un slapd en TLS 1.3, avec des valeurs que le serveur aurait refusees si elles avaient joue).
 */
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LinuxPC } from '@/network/devices/LinuxPC';
import type { WindowsServer } from '@/network/devices/WindowsServer';
import { certToPem } from '@/network/pki/pem';
import { encodeSubjectPublicKeyInfo } from '@/network/pki/der/X509Der';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { DC_ADDRESS, buildLab } from './openldap-lab-support';

const PROBE = `ldapsearch -d 1 -x -b '' -s base -LLL dn 2>&1`;

describe('ldapsearch over TLS reaches the domain controller like libldap', () => {
  let workstation: LinuxPC;
  let controller: WindowsServer;
  let pin: string;

  beforeAll(async () => {
    const lab = await buildLab();
    workstation = lab.workstation;
    controller = lab.controller;
    await workstation.executeCommand(`echo '${DC_ADDRESS} dc01.corp.local dc01' | sudo tee -a /etc/hosts > /dev/null`);
    await workstation.executeCommand(`LDAPTLS_REQCERT=never ldapsearch -x -H ldaps://${DC_ADDRESS} -b '' -s base -LLL dn`);
    const cert = (controller as unknown as { ldapStartTlsIdentity: { cert: X509Certificate } }).ldapStartTlsIdentity.cert;
    workstation.writeFileFromEditor('/tmp/dc.pem', certToPem(cert));
    workstation.writeFileFromEditor('/tmp/empty.conf', '');
    pin = createHash('sha256').update(encodeSubjectPublicKeyInfo(cert.publicKey)).digest('base64');
  }, 120000);

  function search(host: string, env = '', mode = ''): Promise<string> {
    return workstation.executeCommand(`LDAPCONF=/tmp/empty.conf LDAPTLS_CACERT=/tmp/dc.pem ${env} ${PROBE.replace('ldapsearch', `ldapsearch ${mode} -H ldaps://${host}`)}`);
  }

  it('the lab is sound: the DC presents the certificate of its DNS host name', () => {
    const cert = (controller as unknown as { ldapStartTlsIdentity: { cert: X509Certificate } }).ldapStartTlsIdentity.cert;
    expect(cert.subject).toBe('CN=dc01.corp.local');
    expect(cert.extensions?.subjectAltName).toEqual(['DNS:dc01.corp.local']);
  });

  it('the DNS name of the DC is accepted when its certificate is trusted', async () => {
    expect(await search('dc01.corp.local')).toContain('dn:');
  });

  it('the address of the DC is refused: it is neither in the SAN nor the common name', async () => {
    const output = await search(DC_ADDRESS);
    expect(output).toContain('TLS: hostname (10.0.0.10) does not match common name in certificate (dc01.corp.local).');
    expect(output).toContain("Can't contact LDAP server (-1)");
  });

  it('the short name is refused too', async () => {
    expect(await search('dc01')).toContain('TLS: hostname (dc01) does not match common name in certificate (dc01.corp.local).');
  });

  it('REQSAN try says it is the subjectAltName that does not match', async () => {
    expect(await search(DC_ADDRESS, 'LDAPTLS_REQSAN=try')).toContain('TLS: hostname (10.0.0.10) does not match subjectAltName in certificate.');
  });

  it('REQSAN never lifts the name check', async () => {
    expect(await search(DC_ADDRESS, 'LDAPTLS_REQSAN=never')).toContain('dn:');
  });

  it('REQCERT never and allow lift the name check, try keeps it', async () => {
    expect(await search(DC_ADDRESS, 'LDAPTLS_REQCERT=never')).toContain('dn:');
    expect(await search(DC_ADDRESS, 'LDAPTLS_REQCERT=allow')).toContain('dn:');
    expect(await search(DC_ADDRESS, 'LDAPTLS_REQCERT=try')).toContain("Can't contact LDAP server (-1)");
  });

  it('the pin of the right key is accepted, a wrong one is refused with the real trace line', async () => {
    expect(await search('dc01.corp.local', `LDAPTLS_PEERKEY_HASH=sha256:${pin}`)).toContain('dn:');
    const output = await search('dc01.corp.local', `LDAPTLS_PEERKEY_HASH=sha256:${Buffer.alloc(32).toString('base64')}`);
    expect(output).toContain('tlsg_session_pinning: public key hash does not match provided pin.');
    expect(output).not.toContain('dn:');
  });

  it('an unknown pin algorithm under StartTLS is a server-down error, not a connect error', async () => {
    const output = await workstation.executeCommand(
      `LDAPCONF=/tmp/empty.conf LDAPTLS_CACERT=/tmp/dc.pem LDAPTLS_PEERKEY_HASH=md9:AAAA ldapsearch -x -ZZ -H ldap://dc01.corp.local -b '' -s base -LLL dn 2>&1`,
    );
    expect(output).toContain("ldap_start_tls: Can't contact LDAP server (-1)");
    expect(output).toContain('additional info: (unknown error code)');
  });

  it('StartTLS applies the same name check as LDAPS', async () => {
    const refused = await workstation.executeCommand(
      `LDAPCONF=/tmp/empty.conf LDAPTLS_CACERT=/tmp/dc.pem ldapsearch -x -ZZ -H ldap://${DC_ADDRESS} -b '' -s base -LLL dn 2>&1`,
    );
    expect(refused).toContain('ldap_start_tls: Connect error (-11)');
    const accepted = await workstation.executeCommand(
      `LDAPCONF=/tmp/empty.conf LDAPTLS_CACERT=/tmp/dc.pem ldapsearch -x -ZZ -H ldap://dc01.corp.local -b '' -s base -LLL dn 2>&1`,
    );
    expect(accepted).toContain('dn:');
  });

  it('a certificate that is not trusted is refused whatever its name, unless TLS_REQCERT allows it', async () => {
    const refused = await workstation.executeCommand(
      `LDAPCONF=/tmp/empty.conf LDAPTLS_CACERT=/tmp/empty.conf ldapsearch -d 1 -x -H ldaps://dc01.corp.local -b '' -s base -LLL dn 2>&1`,
    );
    expect(refused).toContain('TLS: peer cert untrusted or revoked (0x42)');
    const allowed = await workstation.executeCommand(
      `LDAPCONF=/tmp/empty.conf LDAPTLS_CACERT=/tmp/empty.conf LDAPTLS_REQCERT=allow ldapsearch -x -H ldaps://dc01.corp.local -b '' -s base -LLL dn 2>&1`,
    );
    expect(allowed).toContain('dn:');
  });

  it('the options the GnuTLS build of libldap ignores leave the connection alone', async () => {
    const ignored = [
      'LDAPTLS_PROTOCOL_MIN=3.4 LDAPTLS_PROTOCOL_MAX=3.3', 'LDAPTLS_PROTOCOL_MAX=3.0', 'LDAPTLS_PROTOCOL_MIN=banana',
      'LDAPTLS_ECNAME=bogus', 'LDAPTLS_CRLCHECK=all', 'LDAPTLS_RANDFILE=/nonexistent', 'LDAPTLS_DHFILE=/nonexistent',
    ];
    for (const assignment of ignored) {
      expect(await search('dc01.corp.local', assignment), assignment).toContain('dn:');
    }
  });

  it('the CA bundle file is the trust store: a CA added to the machine appears in it', async () => {
    const cert = (controller as unknown as { ldapStartTlsIdentity: { cert: X509Certificate } }).ldapStartTlsIdentity.cert;
    expect(await workstation.executeCommand('cat /etc/ssl/certs/ca-certificates.crt')).toBe('');
    workstation.addTrustedCertificateAuthority(cert);
    expect(await workstation.executeCommand('cat /etc/ssl/certs/ca-certificates.crt')).toContain('BEGIN CERTIFICATE');
  });
});
