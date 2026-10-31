/**
 * Sonde : un poste Linux (ldap-utils, krb5-user, libsasl2-modules-gssapi-mit)
 * obtient un TGT du KDC du controleur de domaine puis `ldapsearch -Y
 * GSS-SPNEGO` conduit l'echange SPNEGO avec le serveur LDAP du DC et lit
 * l'annuaire a travers la couche decidee par les drapeaux du contexte — chaque
 * octet passe par le fil.
 *
 * Autorite : le client suit cyrus-sasl `gssapi_spnego_ssf` et le NegTokenInit
 * que MIT krb5 emet (voir `probe-ldapsearch-gss-spnego-replays-the-real-client`) ;
 * l'annonce `supportedSASLMechanisms: GSSAPI, GSS-SPNEGO, ...` suit l'ordre de
 * MS-ADTS. Non attestable : la reponse exacte d'Active Directory au NegTokenInit
 * (le simulateur repond comme MIT : accept-completed, mecanisme Kerberos,
 * AP-REP, sans mechListMIC) ; l'annonce d'EXTERNAL et de DIGEST-MD5 que fait un
 * vrai DC, que ce DC ne sait pas conduire ; la taille de tampon d'emission du
 * DC en l'absence de negociation (65536, valeur par defaut de Cyrus SASL).
 *
 * Mesure avant la correction (ni client ni serveur GSS-SPNEGO) : 6 des 8 cas
 * tombent. Passent avant comme apres : le temoin « the lab is sound » (le TGT
 * s'obtient par le client Kerberos deja present) et « a required strength
 * beyond what the mechanism offers finds no mechanism » (libsasl2 ecarte la
 * liste avant tout mecanisme).
 */
import { describe, it, expect } from 'vitest';
import type { LinuxPC } from '@/network/devices/LinuxPC';
import { ADMIN_PASSWORD, DC_ADDRESS, buildLab } from './openldap-lab-support';

const KRB5 = 'KRB5_CONFIG=/tmp/krb5.conf';
const SEARCH = `${KRB5} ldapsearch -H ldap://dc01.corp.local -Y GSS-SPNEGO -b dc=corp,dc=local -s base -LLL dn`;

async function authenticatedWorkstation(): Promise<LinuxPC> {
  const { workstation } = await buildLab();
  await workstation.executeCommand('apt install -y libsasl2-modules-gssapi-mit');
  await workstation.executeCommand(`echo '${DC_ADDRESS} dc01.corp.local dc01' | sudo tee -a /etc/hosts > /dev/null`);
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

describe('ldapsearch -Y GSS-SPNEGO binds to the domain controller', () => {
  it('the lab is sound', async () => {
    const workstation = await authenticatedWorkstation();
    expect(await workstation.executeCommand(`${KRB5} klist`)).toContain('krbtgt/CORP.LOCAL@CORP.LOCAL');
  });

  it('the root DSE announces GSSAPI then GSS-SPNEGO', async () => {
    const { workstation } = await buildLab();
    await workstation.executeCommand(`echo '${DC_ADDRESS} dc01.corp.local dc01' | sudo tee -a /etc/hosts > /dev/null`);
    const output = await workstation.executeCommand('ldapsearch -x -H ldap://dc01.corp.local -b "" -s base -LLL supportedSASLMechanisms');
    expect(output.indexOf('supportedSASLMechanisms: GSSAPI')).toBeGreaterThanOrEqual(0);
    expect(output.indexOf('supportedSASLMechanisms: GSS-SPNEGO')).toBeGreaterThan(output.indexOf('supportedSASLMechanisms: GSSAPI'));
  });

  it('reads the directory through a confidentiality layer and says so', async () => {
    const workstation = await authenticatedWorkstation();
    const output = await workstation.executeCommand(SEARCH);
    expect(output).toContain('SASL/GSS-SPNEGO authentication started');
    expect(output).toContain('SASL username: Administrator@CORP.LOCAL');
    expect(output).toContain('SASL SSF: 256');
    expect(output).toContain('SASL data security layer installed.');
    expect(output).toContain('dn: DC=corp,DC=local');
  });

  it('keeps the service ticket in the cache under the name that was asked for', async () => {
    const workstation = await authenticatedWorkstation();
    await workstation.executeCommand(SEARCH);
    expect(await workstation.executeCommand(`${KRB5} klist`)).toContain('\tTicket server: ldap/dc01.corp.local@CORP.LOCAL');
  });

  it('maxssf=0 removes the layer, as the real mechanism does', async () => {
    const workstation = await authenticatedWorkstation();
    await workstation.executeCommand(SEARCH);
    const wrapped = await bytesOf(workstation, SEARCH);
    const bare = await bytesOf(workstation, SEARCH.replace('-Y GSS-SPNEGO', '-Y GSS-SPNEGO -O maxssf=0'));
    expect(bare.output).toContain('SASL SSF: 0');
    expect(bare.output).not.toContain('SASL data security layer installed.');
    expect(bare.output).toContain('dn: DC=corp,DC=local');
    expect(wrapped.sent).toBeGreaterThan(bare.sent);
    expect(wrapped.received).toBeGreaterThan(bare.received);
  });

  it('maxssf=1 still yields the full layer, because the mechanism does not negotiate one', async () => {
    const workstation = await authenticatedWorkstation();
    const output = await workstation.executeCommand(SEARCH.replace('-Y GSS-SPNEGO', '-Y GSS-SPNEGO -O maxssf=1'));
    expect(output).toContain('SASL SSF: 256');
    expect(output).toContain('dn: DC=corp,DC=local');
  });

  it('a required strength beyond what the mechanism offers finds no mechanism', async () => {
    const workstation = await authenticatedWorkstation();
    const output = await workstation.executeCommand(SEARCH.replace('-Y GSS-SPNEGO', '-Y GSS-SPNEGO -O minssf=300'));
    expect(output).toContain('No worthy mechs found');
    expect(output).not.toContain('dn: DC=corp,DC=local');
  });

  it('after kdestroy the missing credentials are reported in the mechanism\'s own words', async () => {
    const workstation = await authenticatedWorkstation();
    await workstation.executeCommand(SEARCH);
    await workstation.executeCommand(`${KRB5} kdestroy`);
    const output = await workstation.executeCommand(SEARCH);
    expect(output).toContain('SPNEGO cannot find mechanisms to negotiate');
    expect(output).not.toContain('dn: DC=corp,DC=local');
  });
});
