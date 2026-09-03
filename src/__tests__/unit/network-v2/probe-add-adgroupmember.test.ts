/**
 * `Add-ADGroupMember` — les 11 parametres de la commande, et les regles
 * d'appartenance qu'elle applique.
 *
 * Sources. La forme, les positions, le tuyau et le texte de
 * `-DisablePermissiveModify` viennent de la page de la commande
 * (`MicrosoftDocs/windows-powershell-docs`, `Add-ADGroupMember.md`). Les
 * trois refus d'imbrication viennent de la table des portees de
 * `MicrosoftDocs/windowsserverdocs`
 * (`identity/ad-ds/manage/understand-security-groups.md`, colonnes
 * « Possible members » / « Possible member of ») et leurs libelles de la
 * table des codes d'erreur Win32 de `MicrosoftDocs/win32`
 * (`system-error-codes--8200-8999-`, 8516/8517/8518) ; les trois
 * combinaisons interdites par la premiere sont exactement les trois qui
 * ont un code dedie dans la seconde. « The specified account name is
 * already a member of the group. » est atteste DEUX fois : dans la page
 * de la commande et comme `ERROR_MEMBER_IN_ALIAS` (1378). Le prerequis de
 * `-MemberTimeToLive` (niveau fonctionnel de foret 2016 + fonctionnalite
 * facultative « Privileged Access Management Feature ») vient de
 * `MicrosoftDocs/MIMDocs` (`pam/raise-bastion-functional-level.md`), et le
 * format `<TTL=secondes>,<dn>` de l'analyse qu'en fait un vrai module
 * PowerShell (`YossiSassi/ADGroupMemberTimeBased`).
 *
 * Discrimine par `git stash` : 14 cas tombent avant correctif. Les 5
 * autres sont nommes ici plutot que laisses a decouvrir, chacun avec la
 * raison pour laquelle il ne discrimine rien :
 *   - « une adhesion ordinaire » et « un membre inconnu est refuse » sont
 *     les TEMOINS : la commande faisait deja ces deux choses, et sans eux
 *     une implantation qui refuserait TOUT passerait une sonde faite
 *     seulement de refus ;
 *   - « la modification permissive est le defaut » passait avant parce
 *     que `modifyEntry` dedoublonne depuis toujours — c'est justement le
 *     defaut d'IOS... de LDAP, et ce cas garde qu'il n'a pas change ;
 *   - « -Properties Members est exige » decrit ce qu'un vrai
 *     `Get-ADGroup` fait deja ici, et il est present parce que la
 *     PREMIERE mesure de cette commande a conclu a tort que rien n'etait
 *     enregistre, faute de l'avoir demande ;
 *   - « un groupe local de domaine admet les trois portees » passait
 *     avant parce qu'AUCUNE regle d'imbrication n'existait, donc tout
 *     passait ; il tient la moitie PERMISE de la table, sans quoi un
 *     correctif trop large interdirait l'imbrication legitime.
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

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetForestRegistry();
  Logger.reset();
});

const MDP = '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)';
const PWD = '-AccountPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)';

type Shell = ReturnType<typeof PowerShellSubShell.create>['subShell'];
const shellOf = (d: WindowsServer): Shell => PowerShellSubShell.create(d).subShell;
const run = async (sh: Shell, line: string) => (await sh.processLine(line)).output.join('\n').trim();

async function promotedDc(name = 'DC01', domain = 'corp.local', forestMode?: string): Promise<{ dc: WindowsServer; sh: Shell }> {
  const dc = new WindowsServer(name);
  dc.powerOn();
  dc.setCurrentUser('Administrator');
  const sh = shellOf(dc);
  await run(sh, 'Install-WindowsFeature -Name AD-Domain-Services');
  const mode = forestMode ? ` -ForestMode ${forestMode} -DomainMode ${forestMode}` : '';
  await run(sh, `Install-ADDSForest -DomainName "${domain}"${mode} -Force ${MDP}`);
  return { dc, sh };
}

async function lab(): Promise<{ dc: WindowsServer; sh: Shell }> {
  const { dc, sh } = await promotedDc();
  await run(sh, `New-ADUser -Name "alice" -SamAccountName "alice" ${PWD}`);
  await run(sh, `New-ADUser -Name "bob" -SamAccountName "bob" ${PWD}`);
  await run(sh, 'New-ADGroup -Name "Ingenieurs" -GroupScope Global');
  return { dc, sh };
}

const membersOf = async (sh: Shell, group: string) =>
  run(sh, `(Get-ADGroup -Identity "${group}" -Properties Members).Members`);

describe('Add-ADGroupMember — appartenance', () => {
  it('TEMOIN : une adhesion ordinaire est enregistree des deux cotes', async () => {
    const { sh } = await lab();
    expect(await run(sh, 'Add-ADGroupMember -Identity "Ingenieurs" -Members "alice"')).toBe('');
    expect(await membersOf(sh, 'Ingenieurs')).toContain('alice');
    expect(await run(sh, '(Get-ADUser -Identity "alice" -Properties MemberOf).MemberOf')).toContain('Ingenieurs');
  });

  it('TEMOIN : un membre qui n existe pas est refuse', async () => {
    const { sh } = await lab();
    expect(await run(sh, 'Add-ADGroupMember -Identity "Ingenieurs" -Members "zorglub"'))
      .toContain("Cannot find an object with identity: 'zorglub'.");
  });

  it('le nom des membres n est rendu que sur demande, comme un vrai Get-ADGroup', async () => {
    const { sh } = await lab();
    await run(sh, 'Add-ADGroupMember -Identity "Ingenieurs" -Members "alice"');
    expect(await run(sh, '(Get-ADGroup -Identity "Ingenieurs").Members')).toBe('');
    expect(await membersOf(sh, 'Ingenieurs')).toBe('alice');
  });

  it('accepte Identity en position 0 et Members en position 1', async () => {
    const { sh } = await lab();
    expect(await run(sh, 'Add-ADGroupMember "Ingenieurs" "alice"')).toBe('');
    expect(await membersOf(sh, 'Ingenieurs')).toBe('alice');
  });

  it('recoit Identity par le tuyau, un appel par groupe', async () => {
    const { sh } = await lab();
    await run(sh, 'New-ADGroup -Name "Ventes" -GroupScope Global');
    expect(await run(sh, 'Get-ADGroup -Identity "Ingenieurs" | Add-ADGroupMember -Members "alice"')).toBe('');
    expect(await membersOf(sh, 'Ingenieurs')).toBe('alice');
    await run(sh, 'Get-ADGroup -Filter * | Add-ADGroupMember -Members "bob"');
    expect(await membersOf(sh, 'Ventes')).toContain('bob');
  });

  it('la modification permissive est le defaut : reajouter un membre ne dit rien', async () => {
    const { sh } = await lab();
    await run(sh, 'Add-ADGroupMember -Identity "Ingenieurs" -Members "alice"');
    expect(await run(sh, 'Add-ADGroupMember -Identity "Ingenieurs" -Members "alice"')).toBe('');
    expect(await membersOf(sh, 'Ingenieurs')).toBe('alice');
  });

  it('-DisablePermissiveModify refuse un membre deja present, dans les mots de Windows', async () => {
    const { sh } = await lab();
    await run(sh, 'Add-ADGroupMember -Identity "Ingenieurs" -Members "alice"');
    expect(await run(sh, 'Add-ADGroupMember -Identity "Ingenieurs" -Members "alice" -DisablePermissiveModify'))
      .toContain('The specified account name is already a member of the group.');
  });

  it('-WhatIf annonce sans rien faire', async () => {
    const { sh } = await lab();
    expect(await run(sh, 'Add-ADGroupMember -Identity "Ingenieurs" -Members "alice" -WhatIf')).toContain('What if:');
    expect(await membersOf(sh, 'Ingenieurs')).toBe('');
  });

  it('-PassThru rend le groupe modifie, et sans lui la commande est muette', async () => {
    const { sh } = await lab();
    expect(await run(sh, 'Add-ADGroupMember -Identity "Ingenieurs" -Members "alice"')).toBe('');
    const out = await run(sh, 'Add-ADGroupMember -Identity "Ingenieurs" -Members "bob" -PassThru');
    expect(out).toContain('Ingenieurs');
    expect(out).toContain('CN=Ingenieurs,CN=Users,DC=corp,DC=local');
  });

  it('un seul membre irresolvable laisse le groupe INTACT — la commande est une seule modification', async () => {
    const { sh } = await lab();
    expect(await run(sh, 'Add-ADGroupMember -Identity "Ingenieurs" -Members "alice","zorglub"'))
      .toContain("Cannot find an object with identity: 'zorglub'.");
    expect(await membersOf(sh, 'Ingenieurs')).toBe('');
  });
});

describe('Add-ADGroupMember — portees imbriquees', () => {
  async function scopes(sh: Shell): Promise<void> {
    await run(sh, 'New-ADGroup -Name "GG" -GroupScope Global');
    await run(sh, 'New-ADGroup -Name "GU" -GroupScope Universal');
    await run(sh, 'New-ADGroup -Name "GL" -GroupScope DomainLocal');
  }

  it('un groupe global n admet pas un groupe local de domaine (8516)', async () => {
    const { sh } = await lab();
    await scopes(sh);
    expect(await run(sh, 'Add-ADGroupMember -Identity "GG" -Members "GL"'))
      .toContain('A global group cannot have a local group as a member.');
    expect(await membersOf(sh, 'GG')).toBe('');
  });

  it('un groupe global n admet pas un groupe universel (8517)', async () => {
    const { sh } = await lab();
    await scopes(sh);
    expect(await run(sh, 'Add-ADGroupMember -Identity "GG" -Members "GU"'))
      .toContain('A global group cannot have a universal group as a member.');
  });

  it('un groupe universel n admet pas un groupe local de domaine (8518)', async () => {
    const { sh } = await lab();
    await scopes(sh);
    expect(await run(sh, 'Add-ADGroupMember -Identity "GU" -Members "GL"'))
      .toContain('A universal group cannot have a local group as a member.');
  });

  it('un groupe local de domaine admet les trois portees, et un global admet un global', async () => {
    const { sh } = await lab();
    await scopes(sh);
    expect(await run(sh, 'Add-ADGroupMember -Identity "GL" -Members "GG","GU"')).toBe('');
    expect(await membersOf(sh, 'GL')).toContain('GG');
    expect(await membersOf(sh, 'GL')).toContain('GU');
    await run(sh, 'New-ADGroup -Name "GG2" -GroupScope Global');
    expect(await run(sh, 'Add-ADGroupMember -Identity "GG" -Members "GG2"')).toBe('');
    expect(await membersOf(sh, 'GG')).toBe('GG2');
  });
});

describe('Add-ADGroupMember — appartenance a duree limitee', () => {
  const PAM = "Enable-ADOptionalFeature -Identity 'Privileged Access Management Feature' -Scope ForestOrConfigurationSet -Target corp.local";

  it('-MemberTimeToLive est refuse tant que la fonctionnalite facultative n est pas activee', async () => {
    const { sh } = await lab();
    expect(await run(sh, 'Add-ADGroupMember -Identity "Ingenieurs" -Members "alice" -MemberTimeToLive (New-TimeSpan -Minutes 15)'))
      .toContain('The parameter is incorrect.');
    expect(await membersOf(sh, 'Ingenieurs')).toBe('');
  });

  it('la fonctionnalite elle-meme exige le niveau fonctionnel de foret 2016', async () => {
    const { dc, sh } = await promotedDc('DC02', 'vieux.local', 'Win2012R2');
    await run(sh, "Enable-ADOptionalFeature -Identity 'Privileged Access Management Feature' -Scope ForestOrConfigurationSet -Target vieux.local");
    expect(dc.getDirectoryStore()!.isOptionalFeatureEnabled('Privileged Access Management Feature')).toBe(false);
    const { sh: sh7 } = await lab();
    await run(sh7, PAM);
    expect(await run(sh7, "(Get-ADOptionalFeature -Identity 'Privileged Access Management Feature').EnabledScopes"))
      .toContain('CN=Partitions');
  });

  it('une fois activee, le lien est reel et -ShowMemberTimeToLive en donne les secondes restantes', async () => {
    const { sh } = await lab();
    await run(sh, PAM);
    expect(await run(sh, 'Add-ADGroupMember -Identity "Ingenieurs" -Members "alice" -MemberTimeToLive (New-TimeSpan -Minutes 15)')).toBe('');
    expect(await membersOf(sh, 'Ingenieurs')).toBe('alice');
    const shown = await run(sh, '(Get-ADGroup -Identity "Ingenieurs" -Properties Members -ShowMemberTimeToLive).Members');
    expect(shown).toMatch(/^<TTL=9\d\d>,CN=alice,CN=Users,DC=corp,DC=local$/);
  });

  it('le lien EXPIRE : la duree ecoulee, l appartenance disparait des DEUX cotes', async () => {
    const { dc, sh } = await lab();
    await run(sh, PAM);
    await run(sh, 'Add-ADGroupMember -Identity "Ingenieurs" -Members "alice" -MemberTimeToLive (New-TimeSpan -Minutes 15)');
    await run(sh, 'Add-ADGroupMember -Identity "Ingenieurs" -Members "bob"');
    dc.advanceTime(14 * 60 * 1000);
    expect(await membersOf(sh, 'Ingenieurs')).toContain('alice');
    dc.advanceTime(2 * 60 * 1000);
    expect(await membersOf(sh, 'Ingenieurs')).toBe('bob');
    expect(await run(sh, '(Get-ADUser -Identity "alice" -Properties MemberOf).MemberOf')).not.toContain('Ingenieurs');
  });
});

describe('Add-ADGroupMember — sur un autre controleur de domaine', () => {
  it('-Server passe par une vraie connexion LDAP et le lien arrive des deux cotes', async () => {
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

    expect(await run(sh2, 'Add-ADGroupMember -Identity "Distants" -Members "carol"'))
      .toContain("Cannot find an object with identity: 'Distants'.");

    expect(await run(sh2, 'Add-ADGroupMember -Identity "Distants" -Members "carol" -Server "192.168.60.10" -AuthType Basic -Credential "Administrator:P@ssw0rd"')).toBe('');
    expect(await membersOf(sh1, 'Distants')).toBe('carol');
    expect(await run(sh1, '(Get-ADUser -Identity "carol" -Properties MemberOf).MemberOf')).toContain('Distants');
  });
});
