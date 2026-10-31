/**
 * Sonde : `ldapsearch -Y GS2-KRB5` contre le controleur de domaine du
 * simulateur. Un vrai Active Directory n'annonce que GSSAPI, GSS-SPNEGO,
 * EXTERNAL et DIGEST-MD5 (MS-ADTS) : le DC ne conduit pas GS2, il refuse le
 * bind avec le code 7 (RFC 4511, authMethodNotSupported) apres que le client
 * a parle. Non attestable : le texte de diagnostic qu'Active Directory joint a
 * ce refus, que ce DC ne fournit pas.
 *
 * Mesure avant la correction (greffon libgs2 absent du client) : 1 des 3 cas
 * tombe, celui qui lance le mecanisme ; passent avant comme apres le temoin
 * « the lab is sound » et « the root DSE does not announce GS2-KRB5 ».
 */
import { describe, it, expect } from 'vitest';
import { ADMIN_PASSWORD, DC_ADDRESS, buildLab } from './openldap-lab-support';

const KRB5 = 'KRB5_CONFIG=/tmp/krb5.conf';

async function authenticatedWorkstation() {
  const { workstation } = await buildLab();
  await workstation.executeCommand('apt install -y libsasl2-modules-gssapi-mit');
  await workstation.executeCommand(`echo '${DC_ADDRESS} dc01.corp.local dc01' | sudo tee -a /etc/hosts > /dev/null`);
  await workstation.executeCommand(
    `printf '[libdefaults]\\n default_realm = CORP.LOCAL\\n dns_lookup_kdc = false\\n[realms]\\n CORP.LOCAL = {\\n  kdc = ${DC_ADDRESS}\\n }\\n' > /tmp/krb5.conf`,
  );
  await workstation.executeCommand(`echo '${ADMIN_PASSWORD}' | ${KRB5} kinit Administrator`);
  return workstation;
}

describe('ldapsearch -Y GS2-KRB5 meets the domain controller', () => {
  it('the lab is sound: GSS-SPNEGO reads the directory', async () => {
    const workstation = await authenticatedWorkstation();
    const spnego = await workstation.executeCommand(`${KRB5} ldapsearch -H ldap://dc01.corp.local -Y GSS-SPNEGO -b dc=corp,dc=local -s base -LLL dn`);
    expect(spnego).toContain('dn: DC=corp,DC=local');
  });

  it('the root DSE does not announce GS2-KRB5', async () => {
    const workstation = await authenticatedWorkstation();
    const output = await workstation.executeCommand('ldapsearch -x -H ldap://dc01.corp.local -b "" -s base -LLL supportedSASLMechanisms');
    expect(output).toContain('supportedSASLMechanisms: GSSAPI');
    expect(output).not.toContain('GS2-KRB5');
  });

  it('the bind is refused as a method the server does not support, after the client has spoken', async () => {
    const workstation = await authenticatedWorkstation();
    const output = await workstation.executeCommand(`${KRB5} ldapsearch -H ldap://dc01.corp.local -Y GS2-KRB5 -U Administrator -b dc=corp,dc=local -s base -LLL dn`);
    expect(output).toContain('SASL/GS2-KRB5 authentication started');
    expect(output).toContain('Authentication method not supported (7)');
    expect(output).not.toContain('dn: DC=corp,DC=local');
  });
});
