/*
 * Probe — `Move-ADObject` reparente un objet vers une OU (LDAP ModifyDN à
 * nouveau supérieur), et `Get-ADPrincipalGroupMembership` liste les groupes
 * dont un principal est membre direct.
 *
 * Avant : les deux cmdlets étaient inconnues (« is not recognized »). La
 * gestion des utilisateurs/OU/groupes ne pouvait ni déplacer un compte dans
 * son OU métier, ni répondre à la question de l'auditeur « dans quels
 * groupes est ce compte ? » — pourtant `member`/`memberOf` sont déjà des
 * attributs liés du magasin, et l'arbre porte déjà `renameEntry` (RFC 4511
 * §4.9 ModifyDNRequest).
 *
 * Autorité : PowerShell `Move-ADObject -Identity <dn> -TargetPath <ou>` et
 * `Get-ADPrincipalGroupMembership -Identity <principal>` (about_*). Le
 * déplacement conserve le RDN et change le supérieur ; l'appartenance rendue
 * est directe (le `memberOf` du principal, primary group « Domain Users »
 * compris), sans expansion des groupes imbriqués — la limite déjà posée par
 * le magasin.
 *
 * Mesuré avant le correctif (git stash de src/powershell + src/network) :
 * 3 des 4 cas tombent. Passe des deux côtés :
 *  - « TÉMOIN : l'OU, l'utilisateur et le groupe se créent » — New-AD* et
 *    Add-ADGroupMember sont sains, donc un échec des autres cas accuse les
 *    deux nouvelles cmdlets et non un annuaire cassé.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  EquipmentRegistry.resetInstance();
  Logger.reset();
});

const run = async (d: WindowsServer, l: string): Promise<string> =>
  (await PowerShellSubShell.create(d).subShell.processLine(l)).output.join('\n');

async function dc(): Promise<WindowsServer> {
  const server = new WindowsServer('DC01');
  server.setCurrentUser('Administrator');
  await run(server, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(server, 'Install-ADDSForest -DomainName "corp.lab" -DomainNetbiosName "CORP" -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd!" -AsPlainText -Force) -Force');
  await run(server, 'New-ADOrganizationalUnit -Name "Auditeurs" -Path "DC=corp,DC=lab"');
  await run(server, 'New-ADUser -Name jdupont -AccountPassword (ConvertTo-SecureString "Passw0rd!" -AsPlainText -Force) -Enabled $true');
  await run(server, 'New-ADGroup -Name "Analystes" -GroupScope Global');
  await run(server, 'Add-ADGroupMember -Identity "Analystes" -Members jdupont');
  return server;
}

describe('Move-ADObject / Get-ADPrincipalGroupMembership', () => {
  it("TÉMOIN : l'OU, l'utilisateur et le groupe se créent", async () => {
    const server = await dc();
    expect(await run(server, '(Get-ADOrganizationalUnit -Identity "OU=Auditeurs,DC=corp,DC=lab").Name')).toContain('Auditeurs');
    expect(await run(server, '(Get-ADUser jdupont).SamAccountName')).toContain('jdupont');
    expect(await run(server, '(Get-ADGroupMember -Identity "Analystes").SamAccountName')).toContain('jdupont');
  });

  it('Move-ADObject déplace un utilisateur sous une OU', async () => {
    const server = await dc();
    const before = await run(server, '(Get-ADUser jdupont).DistinguishedName');
    expect(before).toMatch(/CN=jdupont,CN=Users,DC=corp,DC=lab/i);
    const dn = before.trim();
    await run(server, `Move-ADObject -Identity "${dn}" -TargetPath "OU=Auditeurs,DC=corp,DC=lab"`);
    const after = await run(server, '(Get-ADUser jdupont).DistinguishedName');
    expect(after).toMatch(/CN=jdupont,OU=Auditeurs,DC=corp,DC=lab/i);
  });

  it("Get-ADPrincipalGroupMembership liste les groupes d'un utilisateur", async () => {
    const server = await dc();
    const out = await run(server, '(Get-ADPrincipalGroupMembership -Identity jdupont).Name');
    expect(out).toMatch(/Analystes/);
    expect(out).toMatch(/Domain Users/);
  });

  it('Move-ADObject échoue proprement vers une OU inexistante', async () => {
    const server = await dc();
    const out = await run(server, 'Move-ADObject -Identity "CN=jdupont,CN=Users,DC=corp,DC=lab" -TargetPath "OU=Absente,DC=corp,DC=lab"');
    expect(out).toMatch(/does not exist/i);
    expect(await run(server, '(Get-ADUser jdupont).DistinguishedName')).toMatch(/CN=Users/i);
  });
});
