/**
 * Sonde : un poste Linux (paquets ldap-utils, krb5-user et
 * libsasl2-modules-gssapi-mit) obtient un TGT du KDC du controleur de domaine
 * avec `kinit`, puis `ldapsearch -Y GSSAPI` demande un billet pour
 * `ldap/dc01.corp.local`, le range dans le cache, conduit l'echange RFC 4752
 * avec le DC et lit l'annuaire a travers la couche de securite — chaque octet
 * passe par le fil, compte sur l'interface.
 *
 * Autorite : l'echange et les jetons sont ceux que le vrai `ldapsearch` echange
 * avec un vrai slapd et un vrai KDC MIT (voir la sonde de rejeu
 * `probe-ldapsearch-gssapi-replays-the-real-client`) ; ici c'est le serveur LDAP
 * du DC du simulateur qui y repond. Les textes du DC (`80090308 ... data 52e`)
 * sont ceux d'Active Directory. Non attestable : la taille de tampon et la
 * liste de couches que le DC annonce (celles d'un slapd, 65536 octets, ne sont
 * pas celles d'Active Directory ; la valeur retenue est la politique LDAP par
 * defaut MaxReceiveBuffer, 10485760), et le refus d'une identite d'autorisation
 * qui n'est pas celle du client, dont le texte exact d'Active Directory n'est
 * pas atteignable ici.
 *
 * Mesure avant correction (greffon GSSAPI du client present, serveur du DC
 * verifiant un AP-REQ nu au lieu des trois binds de RFC 4752) : 4 des 8 cas
 * tombent, ceux qui lisent l'annuaire. Passent avant et apres, chacun pour sa
 * raison : le temoin « the lab is sound » (le TGT s'obtient par le client
 * Kerberos deja present) ; le billet rangé dans le cache (l'acquisition se
 * fait cote client, avant le serveur) ; le refus d'une identite d'autorisation
 * (l'ancien serveur refusait tout bind qu'il ne comprenait pas) ; et la
 * disparition des identifiants apres `kdestroy` (le client s'arrete avant le
 * serveur).
 */
import { describe, it, expect } from 'vitest';
import type { LinuxPC } from '@/network/devices/LinuxPC';
import { ADMIN_PASSWORD, DC_ADDRESS, buildLab } from './openldap-lab-support';

const KRB5 = 'KRB5_CONFIG=/tmp/krb5.conf';
const SEARCH = `${KRB5} ldapsearch -H ldap://dc01.corp.local -Y GSSAPI -b dc=corp,dc=local -s base -LLL dn`;

async function authenticatedWorkstation(): Promise<LinuxPC> {
  const { workstation } = await buildLab();
  await workstation.executeCommand('apt install -y libsasl2-modules-gssapi-mit');
  await workstation.executeCommand(`echo '${DC_ADDRESS} dc01.corp.local dc01' >> /etc/hosts`);
  await workstation.executeCommand(
    `printf '[libdefaults]\\n default_realm = CORP.LOCAL\\n dns_lookup_kdc = false\\n[realms]\\n CORP.LOCAL = {\\n  kdc = ${DC_ADDRESS}\\n }\\n' > /tmp/krb5.conf`,
  );
  await workstation.executeCommand(`echo '${ADMIN_PASSWORD}' | ${KRB5} kinit Administrator`);
  return workstation;
}

async function bytesOf(workstation: LinuxPC, command: string): Promise<{ output: string; sent: number; received: number }> {
  const port = workstation.getPort('eth0')!;
  const before = port.getCounters();
  const output = await workstation.executeCommand(command);
  const after = port.getCounters();
  return { output, sent: after.bytesOut - before.bytesOut, received: after.bytesIn - before.bytesIn };
}

describe('ldapsearch -Y GSSAPI binds to the domain controller', () => {
  it('the lab is sound', async () => {
    const workstation = await authenticatedWorkstation();
    expect(await workstation.executeCommand(`${KRB5} klist`)).toContain('krbtgt/CORP.LOCAL@CORP.LOCAL');
  });

  it('reads the directory through a confidentiality layer and says so', async () => {
    const workstation = await authenticatedWorkstation();
    const output = await workstation.executeCommand(SEARCH);
    expect(output).toContain('SASL/GSSAPI authentication started');
    expect(output).toContain('SASL username: Administrator@CORP.LOCAL');
    expect(output).toContain('SASL SSF: 256');
    expect(output).toContain('SASL data security layer installed.');
    expect(output).toContain('dn: DC=corp,DC=local');
  });

  it('keeps the service ticket in the cache under the name that was asked for', async () => {
    const workstation = await authenticatedWorkstation();
    await workstation.executeCommand(SEARCH);
    const listing = await workstation.executeCommand(`${KRB5} klist`);
    expect(listing).toMatch(/ldap\/dc01\.corp\.local@\n\s+renew until/);
    expect(listing).toContain('\tTicket server: ldap/dc01.corp.local@CORP.LOCAL');
  });

  it('the second run finds the ticket in the cache and does not ask the KDC again', async () => {
    const workstation = await authenticatedWorkstation();
    const first = await bytesOf(workstation, SEARCH);
    const second = await bytesOf(workstation, SEARCH);
    expect(first.output).toContain('dn: DC=corp,DC=local');
    expect(second.output).toContain('dn: DC=corp,DC=local');
    expect(second.sent).toBeLessThan(first.sent);
  });

  it('the wrapped layer costs bytes on the wire that the same search without a layer does not', async () => {
    const workstation = await authenticatedWorkstation();
    await workstation.executeCommand(SEARCH);
    const wrapped = await bytesOf(workstation, SEARCH);
    const bare = await bytesOf(workstation, SEARCH.replace('-Y GSSAPI', '-Y GSSAPI -O maxssf=0'));
    expect(bare.output).toContain('dn: DC=corp,DC=local');
    expect(wrapped.sent).toBeGreaterThan(bare.sent);
    expect(wrapped.received).toBeGreaterThan(bare.received);
  });

  it('an integrity layer is negotiated when only that much is allowed', async () => {
    const workstation = await authenticatedWorkstation();
    const output = await workstation.executeCommand(SEARCH.replace('-Y GSSAPI', '-Y GSSAPI -O maxssf=1'));
    expect(output).toContain('SASL SSF: 1');
    expect(output).toContain('dn: DC=corp,DC=local');
  });

  it('the identity of another user is refused as authorization identity', async () => {
    const workstation = await authenticatedWorkstation();
    const output = await workstation.executeCommand(`${SEARCH.replace('-Y GSSAPI', '-Y GSSAPI -X u:somebody')}; echo "exit=$?"`);
    expect(output).toContain('Invalid credentials (49)');
    expect(output).toContain('exit=49');
  });

  it('after kdestroy the credentials are reported missing again', async () => {
    const workstation = await authenticatedWorkstation();
    await workstation.executeCommand(SEARCH);
    await workstation.executeCommand(`${KRB5} kdestroy`);
    const output = await workstation.executeCommand(SEARCH);
    expect(output).toContain('No Kerberos credentials available');
    expect(output).not.toContain('dn: DC=corp,DC=local');
  });
});
