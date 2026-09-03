/**
 * `Remove-ADGroupMember` — les dix parametres de la commande, et le
 * retrait qui ne detruit plus ce qu'on ne lui a pas demande de detruire.
 *
 * Sources. La forme, les positions, le tuyau, la confirmation par defaut
 * et le texte de `-DisablePermissiveModify` viennent de la page de la
 * commande (`MicrosoftDocs/windows-powershell-docs`,
 * `Remove-ADGroupMember.md`), dont les EXEMPLES montrent l'invite de
 * confirmation et dont le bloc `-Confirm` porte « Default value: True ».
 * « The specified account name is not a member of the group. » est
 * atteste deux fois : dans cette page et comme `ERROR_MEMBER_NOT_IN_ALIAS`
 * (1377) dans la table des codes Win32 de `MicrosoftDocs/win32`. Le texte
 * du refus de confirmation est celui d'un hote PowerShell qui ne peut pas
 * demander.
 *
 * Discrimine par `git stash` : 11 cas tombent avant correctif. Les 5
 * autres sont nommes ici plutot que laisses a decouvrir :
 *   - « un retrait ordinaire » est le TEMOIN, et il porte deja
 *     `-Confirm:$false` : sans lui, une implantation qui refuserait TOUT
 *     passerait une sonde faite seulement de refus ;
 *   - « la position 0 et la position 1 » passait avant parce que le lot
 *     precedent, en donnant `positional[1]` a `membersOf`, l'avait deja
 *     ouverte pour les DEUX commandes de la famille ;
 *   - « un groupe inconnu est refuse » et « les parametres obligatoires »
 *     etaient deja justes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetForestRegistry } from '@/network/devices/windows/server/ad/forest/Forest';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { parseDN } from '@/network/devices/windows/server/ad/ldap/LdapDN';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetForestRegistry();
  Logger.reset();
});

const MDP = '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)';
const PWD = '-AccountPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)';
const NON_INTERACTIF = 'Windows PowerShell is in NonInteractive mode.';

type Shell = ReturnType<typeof PowerShellSubShell.create>['subShell'];
const shellOf = (d: WindowsServer): Shell => PowerShellSubShell.create(d).subShell;
const run = async (sh: Shell, line: string) => (await sh.processLine(line)).output.join('\n').trim();

async function promotedDc(name = 'DC01', domain = 'corp.local'): Promise<{ dc: WindowsServer; sh: Shell }> {
  const dc = new WindowsServer(name);
  dc.powerOn();
  dc.setCurrentUser('Administrator');
  const sh = shellOf(dc);
  await run(sh, 'Install-WindowsFeature -Name AD-Domain-Services');
  await run(sh, `Install-ADDSForest -DomainName "${domain}" -Force ${MDP}`);
  return { dc, sh };
}

async function lab(): Promise<Shell> {
  const { sh } = await promotedDc();
  for (const u of ['alice', 'bob', 'carol']) await run(sh, `New-ADUser -Name "${u}" -SamAccountName "${u}" ${PWD}`);
  await run(sh, 'New-ADGroup -Name "G" -GroupScope Global');
  await run(sh, 'Add-ADGroupMember -Identity "G" -Members "alice","bob"');
  return sh;
}

const membersOf = async (sh: Shell, group = 'G') =>
  run(sh, `(Get-ADGroup -Identity "${group}" -Properties Members).Members`);

describe('Remove-ADGroupMember — la confirmation est reelle', () => {
  it('demande confirmation par defaut, et ne retire RIEN tant qu elle n est pas obtenue', async () => {
    const sh = await lab();
    expect(await run(sh, 'Remove-ADGroupMember -Identity "G" -Members "alice"')).toContain(NON_INTERACTIF);
    expect(await membersOf(sh)).toBe('alice, bob');
  });

  it('TEMOIN : -Confirm:$false retire pour de bon, des deux cotes', async () => {
    const sh = await lab();
    expect(await run(sh, 'Remove-ADGroupMember -Identity "G" -Members "alice" -Confirm:$false')).toBe('');
    expect(await membersOf(sh)).toBe('bob');
    expect(await run(sh, '(Get-ADUser -Identity "alice" -Properties MemberOf).MemberOf')).not.toContain('G');
  });

  it('$ConfirmPreference gouverne la decision, et il etait declare sans etre lu', async () => {
    const sh = await lab();
    await run(sh, '$ConfirmPreference = "Low"');
    expect(await run(sh, 'Remove-ADGroupMember -Identity "G" -Members "alice"')).toContain(NON_INTERACTIF);
    expect(await membersOf(sh)).toBe('alice, bob');
    await run(sh, '$ConfirmPreference = "None"');
    expect(await run(sh, 'Remove-ADGroupMember -Identity "G" -Members "alice"')).toBe('');
    expect(await membersOf(sh)).toBe('bob');
  });

  it('-Confirm demande explicitement, meme quand la preference ne l exigerait pas', async () => {
    const sh = await lab();
    await run(sh, '$ConfirmPreference = "None"');
    expect(await run(sh, 'Remove-ADGroupMember -Identity "G" -Members "alice" -Confirm')).toContain(NON_INTERACTIF);
    expect(await membersOf(sh)).toBe('alice, bob');
  });
});

describe('Remove-ADGroupMember — ce qui n a pas ete demande n est pas detruit', () => {
  const sansConfirmation = async (sh: Shell) => run(sh, '$ConfirmPreference = "None"');

  it('un membre INCONNU est refuse et le groupe reste INTACT — il etait vide en silence', async () => {
    const sh = await lab();
    await sansConfirmation(sh);
    expect(await run(sh, 'Remove-ADGroupMember -Identity "G" -Members "zorglub"'))
      .toContain("Cannot find an object with identity: 'zorglub'.");
    expect(await membersOf(sh)).toBe('alice, bob');
  });

  it('un client LDAP qui efface TOUT l attribut member efface aussi les liens inverses', async () => {
    const { dc, sh } = await promotedDc('DC9', 'ldap.local');
    await run(sh, `New-ADUser -Name "dave" -SamAccountName "dave" ${PWD}`);
    await run(sh, 'New-ADGroup -Name "Efface" -GroupScope Global');
    await run(sh, 'Add-ADGroupMember -Identity "Efface" -Members "dave"');
    expect(await run(sh, '(Get-ADUser -Identity "dave" -Properties MemberOf).MemberOf')).toContain('Efface');

    const tree = dc.getDirectoryStore()!.getTree();
    tree.modifyEntry(parseDN('CN=Efface,CN=Users,DC=ldap,DC=local'), [{ op: 'delete', type: 'member', values: [] }]);

    expect(await membersOf(sh, 'Efface')).toBe('');
    expect(await run(sh, '(Get-ADUser -Identity "dave" -Properties MemberOf).MemberOf')).not.toContain('Efface');
  });

  it('un seul membre irresolvable laisse le groupe intact — la commande est une seule modification', async () => {
    const sh = await lab();
    await sansConfirmation(sh);
    expect(await run(sh, 'Remove-ADGroupMember -Identity "G" -Members "alice","zorglub"'))
      .toContain("Cannot find an object with identity: 'zorglub'.");
    expect(await membersOf(sh)).toBe('alice, bob');
  });

  it('la modification permissive est le defaut : retirer un NON-membre ne dit rien', async () => {
    const sh = await lab();
    await sansConfirmation(sh);
    expect(await run(sh, 'Remove-ADGroupMember -Identity "G" -Members "carol"')).toBe('');
    expect(await membersOf(sh)).toBe('alice, bob');
  });

  it('-DisablePermissiveModify refuse un NON-membre, dans les mots de Windows', async () => {
    const sh = await lab();
    await sansConfirmation(sh);
    expect(await run(sh, 'Remove-ADGroupMember -Identity "G" -Members "carol" -DisablePermissiveModify'))
      .toContain('The specified account name is not a member of the group.');
    expect(await membersOf(sh)).toBe('alice, bob');
  });
});

describe('Remove-ADGroupMember — les autres parametres', () => {
  const sansConfirmation = async (sh: Shell) => run(sh, '$ConfirmPreference = "None"');

  it('accepte Identity en position 0 et Members en position 1', async () => {
    const sh = await lab();
    await sansConfirmation(sh);
    expect(await run(sh, 'Remove-ADGroupMember "G" "alice"')).toBe('');
    expect(await membersOf(sh)).toBe('bob');
  });

  it('recoit Identity par le tuyau, un appel par groupe', async () => {
    const sh = await lab();
    await sansConfirmation(sh);
    expect(await run(sh, 'Get-ADGroup -Identity "G" | Remove-ADGroupMember -Members "alice"')).toBe('');
    expect(await membersOf(sh)).toBe('bob');
  });

  it('-WhatIf annonce sans rien faire', async () => {
    const sh = await lab();
    await sansConfirmation(sh);
    expect(await run(sh, 'Remove-ADGroupMember -Identity "G" -Members "alice" -WhatIf')).toContain('What if:');
    expect(await membersOf(sh)).toBe('alice, bob');
  });

  it('-PassThru rend le groupe modifie, et sans lui la commande est muette', async () => {
    const sh = await lab();
    await sansConfirmation(sh);
    expect(await run(sh, 'Remove-ADGroupMember -Identity "G" -Members "alice"')).toBe('');
    const out = await run(sh, 'Remove-ADGroupMember -Identity "G" -Members "bob" -PassThru');
    expect(out).toContain('CN=G,CN=Users,DC=corp,DC=local');
  });

  it('un groupe inconnu, et un identifiant qui n est pas un groupe, sont refuses', async () => {
    const sh = await lab();
    await sansConfirmation(sh);
    expect(await run(sh, 'Remove-ADGroupMember -Identity "Fantome" -Members "alice"'))
      .toContain("Cannot find an object with identity: 'Fantome'.");
    expect(await run(sh, 'Remove-ADGroupMember -Identity "alice" -Members "bob"'))
      .toContain("Cannot find an object with identity: 'alice'.");
  });

  it('exige Identity et Members', async () => {
    const sh = await lab();
    await sansConfirmation(sh);
    expect(await run(sh, 'Remove-ADGroupMember -Identity "G"')).toContain('missing mandatory parameters');
    expect(await run(sh, 'Remove-ADGroupMember -Members "alice"')).toContain('missing mandatory parameters');
  });
});

describe('Remove-ADGroupMember — sur un autre controleur de domaine', () => {
  it('-Server passe par une vraie connexion LDAP et le retrait arrive des deux cotes', async () => {
    const { dc: dc1, sh: sh1 } = await promotedDc('DC1', 'lab.local');
    const { dc: dc2, sh: sh2 } = await promotedDc('DC2', 'autre.local');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    new Cable('c-dc1').connect(dc1.getPorts()[0], sw.getPorts()[0]);
    new Cable('c-dc2').connect(dc2.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    dc1.getPorts()[0].configureIP(new IPAddress('192.168.60.10'), mask);
    dc2.getPorts()[0].configureIP(new IPAddress('192.168.60.11'), mask);

    await run(sh1, `New-ADUser -Name "carol" -SamAccountName "carol" ${PWD}`);
    await run(sh1, 'New-ADGroup -Name "Distants" -GroupScope Global');
    await run(sh1, 'Add-ADGroupMember -Identity "Distants" -Members "carol"');
    expect(await membersOf(sh1, 'Distants')).toBe('carol');

    expect(await run(sh2, 'Remove-ADGroupMember -Identity "Distants" -Members "carol" -Confirm:$false -Server "192.168.60.10" -AuthType Basic -Credential "Administrator:P@ssw0rd"')).toBe('');
    expect(await membersOf(sh1, 'Distants')).toBe('');
    expect(await run(sh1, '(Get-ADUser -Identity "carol" -Properties MemberOf).MemberOf')).not.toContain('Distants');
  });
});
