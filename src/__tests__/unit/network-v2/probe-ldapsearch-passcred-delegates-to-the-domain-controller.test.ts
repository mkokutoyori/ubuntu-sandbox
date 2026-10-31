/**
 * Sonde : `ldapsearch -O passcred` contre le controleur de domaine du
 * simulateur, avec GSSAPI et avec GSS-SPNEGO. Avec un TGT obtenu par
 * `kinit -f`, le client demande au KDC un TGT transmis (TGS-REQ FORWARDED),
 * le range dans un KRB-CRED de l'authenticator, et le serveur LDAP du DC le
 * lit ; avec un TGT ordinaire le KDC repond KDC_ERR_BADOPTION (RFC 4120
 * §3.3.3.1) et le bind continue sans delegation, comme le vrai client.
 *
 * Autorite : voir `probe-gssapi-delegation-matches-mit` et
 * `probe-ldapsearch-passcred-replays-the-real-client`. Non attestable : ce que
 * Active Directory fait d'un TGT transmis (il l'accepte si le compte du service
 * est approuve pour la delegation, ce que ce DC ne modelise pas pour LDAP).
 *
 * Mesure avant la correction : 4 des 6 cas tombent ; passent avant comme apres
 * les deux temoins « the lab is sound ».
 */
import { describe, it, expect } from 'vitest';
import type { LinuxPC } from '@/network/devices/LinuxPC';
import { ADMIN_PASSWORD, DC_ADDRESS, buildLab } from './openldap-lab-support';

const KRB5 = 'KRB5_CONFIG=/tmp/krb5.conf';
const SEARCH = `${KRB5} ldapsearch -H ldap://dc01.corp.local -b dc=corp,dc=local -s base -LLL dn`;

async function workstationWith(kinitOptions: string): Promise<LinuxPC> {
  const { workstation } = await buildLab();
  await workstation.executeCommand('apt install -y libsasl2-modules-gssapi-mit');
  await workstation.executeCommand(`echo '${DC_ADDRESS} dc01.corp.local dc01' | sudo tee -a /etc/hosts > /dev/null`);
  await workstation.executeCommand(
    `printf '[libdefaults]\\n default_realm = CORP.LOCAL\\n dns_lookup_kdc = false\\n[realms]\\n CORP.LOCAL = {\\n  kdc = ${DC_ADDRESS}\\n }\\n' > /tmp/krb5.conf`,
  );
  await workstation.executeCommand(`echo '${ADMIN_PASSWORD}' | ${KRB5} kinit ${kinitOptions} Administrator`);
  return workstation;
}

async function sentBytes(workstation: LinuxPC, command: string): Promise<{ output: string; sent: number }> {
  const port = workstation.getPort('eth0')!;
  const before = port.getCounters();
  const output = await workstation.executeCommand(command);
  return { output, sent: port.getCounters().bytesOut - before.bytesOut };
}

describe.each(['GSSAPI', 'GSS-SPNEGO'])('ldapsearch -Y %s -O passcred against the domain controller', (mechanism) => {
  it('the lab is sound: the search works without delegation', async () => {
    const workstation = await workstationWith('-f');
    const output = await workstation.executeCommand(`${SEARCH} -Y ${mechanism}`);
    expect(output).toContain('dn: DC=corp,DC=local');
  });

  it('forwards a ticket granting ticket when the one in the cache is forwardable, and the bind still works', async () => {
    const workstation = await workstationWith('-f');
    await workstation.executeCommand(`${SEARCH} -Y ${mechanism}`);
    const plain = await sentBytes(workstation, `${SEARCH} -Y ${mechanism}`);
    const delegating = await sentBytes(workstation, `${SEARCH} -Y ${mechanism} -O passcred`);
    expect(delegating.output).toContain('dn: DC=corp,DC=local');
    expect(delegating.output).toContain('SASL SSF: 256');
    expect(delegating.sent - plain.sent).toBeGreaterThan(1000);
  });

  it('drops the delegation silently when the ticket granting ticket is not forwardable, and the bind still works', async () => {
    const workstation = await workstationWith('');
    await workstation.executeCommand(`${SEARCH} -Y ${mechanism}`);
    const delegating = await workstation.executeCommand(`${SEARCH} -Y ${mechanism} -O passcred`);
    expect(delegating).toContain('dn: DC=corp,DC=local');
    expect(delegating).not.toContain('not implemented');
  });
});
