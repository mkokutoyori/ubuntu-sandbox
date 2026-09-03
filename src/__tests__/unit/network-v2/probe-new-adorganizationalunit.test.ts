/**
 * `New-ADOrganizationalUnit` applique tout ce qu'il accepte.
 *
 * Autorite : la documentation du cmdlet prise a sa SOURCE
 * (MicrosoftDocs/windows-powershell-docs, `docset/winserver2025-ps/
 * ActiveDirectory/New-ADOrganizationalUnit.md`), learn.microsoft.com
 * etant bloque par le mandataire de sortie. Elle declare DIX-HUIT
 * parametres ; l'implantation de depart en declarait QUATRE et n'en
 * evaluait que DEUX — `Description` et `ProtectedFromAccidentalDeletion`
 * etaient ranges dans `parameters` et lus par personne, ce que la
 * convention du depot interdit.
 *
 * Ce que la mesure a trouve, defaut par defaut :
 *
 *   Les HUIT proprietes (`-City` `l`, `-Country` `c`, `-Description`,
 *     `-DisplayName`, `-ManagedBy` `managedBy`, `-PostalCode`,
 *     `-State` `st`, `-StreetAddress` `street`) etaient acceptees et
 *     JETEES : `Get-ADOrganizationalUnit` ne rendait que Name, DN et
 *     ObjectClass, quoi qu'on ait pose.
 *   `-PassThru` : la documentation ecrit « By default, this cmdlet does
 *     not generate any output ». Le cmdlet rendait TOUJOURS l'objet.
 *   `-WhatIf` : mesure sur un domaine neuf, l'OU etait creee POUR DE
 *     VRAI. Meme classe de defaut que celui ferme sur
 *     `Install-ADDSForest`, et il y echappait pour la meme raison — le
 *     parametre n'etait pas DECLARE.
 *   `-ProtectedFromAccidentalDeletion` : sans effet, et sans defaut.
 *     Or une OU creee par ce cmdlet EST protegee — c'est le piege le
 *     plus classique d'AD, celui qui fait qu'un `Remove-` echoue sur une
 *     OU qu'on vient de creer.
 *   `-OtherAttributes`, `-Instance` : acceptes et jetes.
 *
 * La protection n'est PAS un booleen ici, et c'est ce qui compte : sur
 * une vraie machine ce sont des ACE. Le mecanisme d'ACL du depot
 * (`DirectoryStore.getAcl`/`setAcl`, `AdAccessRule`) existait deja, donc
 * la protection les ECRIT plutot qu'un drapeau a cote — un Deny explicite
 * de `Delete` et `DeleteTree` a `Everyone` sur l'objet, un Deny de
 * `DeleteChild` sur son parent, ce que la recherche atteste. Il fallait
 * pour cela qu'un Deny explicite l'emporte sur les Allow ET sur le
 * privilege d'administration, sans quoi la protection ne protegerait de
 * personne — c'est justement pourquoi il faut la lever avant de
 * supprimer.
 *
 * `Set-` et `Remove-ADOrganizationalUnit` n'existaient pas et sont
 * ecrits ICI, non par elargissement mais par NECESSITE : sans un chemin
 * de suppression, la protection serait un critere range que rien
 * n'evalue ; et sans le `Set-`, une OU protegee par defaut ne pourrait
 * JAMAIS etre supprimee, ce qui serait une souriciere.
 *
 * Discrimine par `git stash` : 15 cas sur 23 tombent avant correctif.
 * Les 8 autres sont nommes plutot que laisses a decouvrir, et TROIS
 * d'entre eux passaient pour une raison qui ne prouve rien :
 *   - `-Path`, le TEMOIN, le nom obligatoire, le nom positionnel, le
 *     doublon et le chemin introuvable etaient DEJA justes ;
 *   - « rend l'objet avec -PassThru » passait parce que le cmdlet rendait
 *     TOUJOURS l'objet — il ne devient une preuve qu'une fois le silence
 *     par defaut pose, dont il garde l'autre cote ;
 *   - « la creation reste possible apres l'essai » passait parce que
 *     `-WhatIf` creait pour de vrai, si bien que l'OU existait deja quand
 *     le second appel echouait ;
 *   - « lever la protection retire le Deny DeleteChild du parent »
 *     passait a VIDE, aucune ACE n'ayant jamais ete ecrite.
 */
import { describe, it, expect } from 'vitest';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const MDP = '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd!" -AsPlainText -Force)';
const LIBRE = '-ProtectedFromAccidentalDeletion $false';

async function controleur(nom = 'DC01') {
  const dc = new WindowsServer(nom);
  dc.powerOn();
  const ps = PowerShellSubShell.create(dc).subShell;
  const run = async (l: string) => (await ps.processLine(l)).output.join('\n').trim();
  await run('Install-WindowsFeature -Name AD-Domain-Services');
  await run(`Install-ADDSForest -DomainName "corp.local" -Force ${MDP}`);
  return { dc, run };
}

describe('New-ADOrganizationalUnit — les proprietes sont posees', () => {
  it('les huit proprietes documentees sont conservees et relues', async () => {
    const { run } = await controleur();
    await run('New-ADOrganizationalUnit -Name "Sieges" -Description "Le siege" -DisplayName "Siege social"'
      + ' -City "Douala" -Country "CM" -State "Littoral" -StreetAddress "rue 1" -PostalCode "0001"'
      + ` -ManagedBy "Administrator" ${LIBRE}`);
    const vue = await run('Get-ADOrganizationalUnit -Identity "Sieges" | Format-List'
      + ' Description, DisplayName, City, Country, State, StreetAddress, PostalCode, ManagedBy');
    for (const attendu of ['Le siege', 'Siege social', 'Douala', 'CM', 'Littoral', 'rue 1', '0001', 'Administrator']) {
      expect(vue).toContain(attendu);
    }
  });

  it('-OtherAttributes pose un attribut que les parametres ne couvrent pas', async () => {
    const { run } = await controleur();
    await run(`New-ADOrganizationalUnit -Name "Autres" -OtherAttributes @{ postOfficeBox = "BP 42" } ${LIBRE}`);
    expect(await run('(Get-ADOrganizationalUnit -Identity "Autres").postOfficeBox')).toBe('BP 42');
  });

  it('-Instance sert de gabarit, et un parametre explicite l\'emporte', async () => {
    const { run } = await controleur();
    await run(`New-ADOrganizationalUnit -Name "Modele" -City "Douala" -Country "CM" ${LIBRE}`);
    await run(`$m = Get-ADOrganizationalUnit -Identity "Modele"; New-ADOrganizationalUnit -Name "Copie" -Instance $m -City "Yaounde" ${LIBRE}`);
    const vue = await run('Get-ADOrganizationalUnit -Identity "Copie" | Format-List City, Country');
    expect(vue).toContain('Yaounde');
    expect(vue).toContain('CM');
  });

  it('-Path cree l\'OU dans le conteneur nomme', async () => {
    const { run } = await controleur();
    await run(`New-ADOrganizationalUnit -Name "Parent" ${LIBRE}`);
    await run(`New-ADOrganizationalUnit -Name "Enfant" -Path "OU=Parent,DC=corp,DC=local" ${LIBRE}`);
    expect(await run('(Get-ADOrganizationalUnit -Identity "Enfant").DistinguishedName'))
      .toBe('OU=Enfant,OU=Parent,DC=corp,DC=local');
  });
});

describe('New-ADOrganizationalUnit — sortie et essai', () => {
  it('ne rend RIEN sans -PassThru', async () => {
    const { run } = await controleur();
    expect(await run(`New-ADOrganizationalUnit -Name "Muette" ${LIBRE}`)).toBe('');
  });

  it('rend l\'objet avec -PassThru', async () => {
    const { run } = await controleur();
    const sortie = await run(`New-ADOrganizationalUnit -Name "Bavarde" -PassThru ${LIBRE}`);
    expect(sortie).toContain('Bavarde');
    expect(sortie).toContain('OU=Bavarde,DC=corp,DC=local');
  });

  it('-WhatIf annonce l\'operation sans creer l\'OU', async () => {
    const { run } = await controleur();
    const sortie = await run('New-ADOrganizationalUnit -Name "Essai" -WhatIf');
    expect(sortie).toContain('What if:');
    expect(await run('Get-ADOrganizationalUnit -Identity "Essai"')).toContain('Cannot find an object');
  });

  it('la creation reste possible apres l\'essai', async () => {
    const { run } = await controleur();
    await run('New-ADOrganizationalUnit -Name "Essai" -WhatIf');
    await run(`New-ADOrganizationalUnit -Name "Essai" ${LIBRE}`);
    expect(await run('(Get-ADOrganizationalUnit -Identity "Essai").Name')).toBe('Essai');
  });
});

describe('New-ADOrganizationalUnit — la protection est une ACL', () => {
  it('une OU creee sans rien preciser est PROTEGEE', async () => {
    const { run } = await controleur();
    await run('New-ADOrganizationalUnit -Name "Sieges"');
    expect(await run('(Get-ADOrganizationalUnit -Identity "Sieges").ProtectedFromAccidentalDeletion')).toBe('True');
    expect(await run('Remove-ADOrganizationalUnit -Identity "Sieges"')).toContain('protected from accidental deletion');
    expect(await run('(Get-ADOrganizationalUnit -Identity "Sieges").Name')).toBe('Sieges');
  });

  it('la protection refuse meme un administrateur du domaine', async () => {
    const { dc, run } = await controleur();
    await run('New-ADOrganizationalUnit -Name "Sieges"');
    expect(dc.getUserManager().currentUser).toBe('Administrator');
    expect(await run('Remove-ADOrganizationalUnit -Identity "Sieges"')).toContain('Access is denied');
  });

  it('la protection s\'ecrit en Deny explicites sur l\'objet', async () => {
    const { dc, run } = await controleur();
    await run('New-ADOrganizationalUnit -Name "Sieges"');
    const acl = dc.getDirectoryStore()!.getAcl('OU=Sieges,DC=corp,DC=local') ?? [];
    const deny = acl.filter(a => a.accessControlType === 'Deny' && a.identitySam === 'Everyone');
    expect(deny.map(a => a.rights).sort()).toEqual(['Delete', 'DeleteTree']);
  });

  it('la protection pose un Deny DeleteChild sur le PARENT', async () => {
    const { dc, run } = await controleur();
    await run(`New-ADOrganizationalUnit -Name "Parent" ${LIBRE}`);
    await run('New-ADOrganizationalUnit -Name "Enfant" -Path "OU=Parent,DC=corp,DC=local"');
    const acl = dc.getDirectoryStore()!.getAcl('OU=Parent,DC=corp,DC=local') ?? [];
    expect(acl.some(a => a.accessControlType === 'Deny' && a.rights === 'DeleteChild')).toBe(true);
  });

  it('-ProtectedFromAccidentalDeletion $false cree une OU supprimable', async () => {
    const { run } = await controleur();
    await run(`New-ADOrganizationalUnit -Name "Libre" ${LIBRE}`);
    expect(await run('(Get-ADOrganizationalUnit -Identity "Libre").ProtectedFromAccidentalDeletion')).toBe('False');
    expect(await run('Remove-ADOrganizationalUnit -Identity "Libre"')).toBe('');
    expect(await run('Get-ADOrganizationalUnit -Identity "Libre"')).toContain('Cannot find an object');
  });

  it('lever la protection par Set- rend l\'OU supprimable', async () => {
    const { run } = await controleur();
    await run('New-ADOrganizationalUnit -Name "Sieges"');
    await run('Set-ADOrganizationalUnit -Identity "Sieges" -ProtectedFromAccidentalDeletion $false');
    expect(await run('Remove-ADOrganizationalUnit -Identity "Sieges"')).toBe('');
    expect(await run('Get-ADOrganizationalUnit -Identity "Sieges"')).toContain('Cannot find an object');
  });

  it('lever la protection retire le Deny DeleteChild du parent', async () => {
    const { dc, run } = await controleur();
    await run(`New-ADOrganizationalUnit -Name "Parent" ${LIBRE}`);
    await run('New-ADOrganizationalUnit -Name "Enfant" -Path "OU=Parent,DC=corp,DC=local"');
    await run('Set-ADOrganizationalUnit -Identity "Enfant" -ProtectedFromAccidentalDeletion $false');
    const acl = dc.getDirectoryStore()!.getAcl('OU=Parent,DC=corp,DC=local') ?? [];
    expect(acl.some(a => a.rights === 'DeleteChild')).toBe(false);
  });
});

describe('New-ADOrganizationalUnit — suppression et arborescence', () => {
  it('une OU qui porte un enfant n\'est pas une feuille', async () => {
    const { run } = await controleur();
    await run(`New-ADOrganizationalUnit -Name "Parent" ${LIBRE}`);
    await run(`New-ADOrganizationalUnit -Name "Enfant" -Path "OU=Parent,DC=corp,DC=local" ${LIBRE}`);
    expect(await run('Remove-ADOrganizationalUnit -Identity "Parent"')).toContain('only on a leaf object');
    expect(await run('(Get-ADOrganizationalUnit -Identity "Enfant").Name')).toBe('Enfant');
  });

  it('-Recursive supprime l\'arbre entier', async () => {
    const { run } = await controleur();
    await run(`New-ADOrganizationalUnit -Name "Parent" ${LIBRE}`);
    await run(`New-ADOrganizationalUnit -Name "Enfant" -Path "OU=Parent,DC=corp,DC=local" ${LIBRE}`);
    expect(await run('Remove-ADOrganizationalUnit -Identity "Parent" -Recursive')).toBe('');
    expect(await run('Get-ADOrganizationalUnit -Identity "Enfant"')).toContain('Cannot find an object');
  });

  it('un enfant protege bloque la suppression recursive', async () => {
    const { run } = await controleur();
    await run(`New-ADOrganizationalUnit -Name "Parent" ${LIBRE}`);
    await run('New-ADOrganizationalUnit -Name "Enfant" -Path "OU=Parent,DC=corp,DC=local"');
    expect(await run('Remove-ADOrganizationalUnit -Identity "Parent" -Recursive')).toContain('protected from accidental deletion');
    expect(await run('(Get-ADOrganizationalUnit -Identity "Parent").Name')).toBe('Parent');
  });

  it('Set- modifie une propriete sans toucher aux autres', async () => {
    const { run } = await controleur();
    await run(`New-ADOrganizationalUnit -Name "Sieges" -Description "avant" -City "Douala" ${LIBRE}`);
    await run('Set-ADOrganizationalUnit -Identity "Sieges" -Description "apres"');
    const vue = await run('Get-ADOrganizationalUnit -Identity "Sieges" | Format-List Description, City');
    expect(vue).toContain('apres');
    expect(vue).toContain('Douala');
  });
});

describe('New-ADOrganizationalUnit — ce qui etait deja juste', () => {
  it('TEMOIN — une creation nominale reste une creation', async () => {
    const { run } = await controleur();
    await run(`New-ADOrganizationalUnit -Name "Sieges" ${LIBRE}`);
    const vue = await run('Get-ADOrganizationalUnit -Identity "Sieges"');
    expect(vue).toContain('Sieges');
    expect(vue).toContain('OU=Sieges,DC=corp,DC=local');
  });

  it('le nom est obligatoire', async () => {
    const { run } = await controleur();
    expect(await run('New-ADOrganizationalUnit')).toContain('missing mandatory parameters: Name');
  });

  it('le nom est positionnel', async () => {
    const { run } = await controleur();
    await run(`New-ADOrganizationalUnit "Positionnelle" ${LIBRE}`);
    expect(await run('(Get-ADOrganizationalUnit -Identity "Positionnelle").Name')).toBe('Positionnelle');
  });

  it('un doublon et un chemin introuvable sont refuses', async () => {
    const { run } = await controleur();
    await run(`New-ADOrganizationalUnit -Name "Sieges" ${LIBRE}`);
    expect(await run(`New-ADOrganizationalUnit -Name "Sieges" ${LIBRE}`)).toContain('already exists');
    expect(await run(`New-ADOrganizationalUnit -Name "Ailleurs" -Path "OU=Nexistepas,DC=corp,DC=local" ${LIBRE}`))
      .toContain('Cannot find an object');
  });
});
