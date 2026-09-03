/**
 * `New-ADGroup` applique ses dix-sept parametres, et `-GroupScope` est
 * OBLIGATOIRE.
 *
 * Autorite : la documentation du cmdlet prise a sa SOURCE
 * (MicrosoftDocs/windows-powershell-docs, `docset/winserver2025-ps/
 * ActiveDirectory/New-ADGroup.md`), learn.microsoft.com etant bloque par
 * le mandataire de sortie. Elle declare DIX-SEPT parametres ;
 * l'implantation en declarait QUATRE.
 *
 * Ce que la mesure a trouve :
 *
 *   `-SamAccountName` etait accepte et JETE : `-Name "Groupe Riche"
 *     -SamAccountName "riche"` rendait `SamAccountName: Groupe Riche`,
 *     donc le compte portait le nom d'affichage et un `Get-ADGroup
 *     -Identity riche` ne trouvait rien.
 *   Les QUATRE proprietes (`-Description`, `-DisplayName`, `-HomePage`
 *     → `wWWHomePage`, `-ManagedBy`) et `-OtherAttributes` etaient
 *     acceptes et jetes.
 *   `-GroupScope` n'etait PAS obligatoire, alors que la documentation le
 *     donne `Required: True, Position: 2` et que la description ecrit
 *     que « Name and GroupScope [...] are required to create a new
 *     group ». Pire : un mot inconnu — `-GroupScope Zorglub` — etait
 *     ACCEPTE et retombait en silence sur `Global`, donc une faute de
 *     frappe creait un groupe dont la portee n'est celle de personne.
 *     `-GroupCategory`, lui, refusait deja correctement.
 *   Les formes NUMERIQUES documentees etaient refusees, alors que la
 *     documentation les donne pour les deux enumerations : `DomainLocal
 *     ou 0`, `Global ou 1`, `Universal ou 2` ; `Distribution ou 0`,
 *     `Security ou 1`.
 *   `-WhatIf` creait le groupe POUR DE VRAI, et `-PassThru` etait
 *     inverse — le cmdlet rendait TOUJOURS l'objet.
 *   `-Instance`, l'entree de pipeline, `-Server`/`-AuthType` et
 *     `Set-ADGroup` n'existaient pas. Le CN venait du compte et non du
 *     `-Name`, et l'objet rendu ne portait pas de `Name` du tout.
 *
 * Ferme en chemin, DEUX duplications — dont une que j'ai introduite :
 * `getGroup` et `listGroups` du fournisseur batissaient le meme objet
 * champ par champ, deux copies qu'il aurait fallu etendre toutes les
 * deux ; et j'avais ecrit un SECOND calcul des bits de `groupType` dans
 * `adGroup.ts` a cote de celui du magasin. Le vocabulaire du groupe
 * porte desormais les bits, et le magasin les lit.
 *
 * Discrimine par `git stash` : 13 cas sur 18 tombent avant correctif.
 * Les 5 autres sont nommes plutot que laisses a decouvrir, et DEUX
 * d'entre eux passaient pour une raison qui ne prouve rien :
 *   - le TEMOIN, `-Path` et les trois portees nommees etaient DEJA
 *     justes ;
 *   - « rend l'objet avec -PassThru » passait parce que le cmdlet
 *     rendait TOUJOURS l'objet, et « sans -GroupCategory le groupe est
 *     de securite » parce que `Security` etait la seule valeur que le
 *     cmdlet savait poser — tous deux ne deviennent des preuves qu'une
 *     fois l'autre cote pose.
 *
 * Le cas « une categorie inconnue est refusee », que j'avais annonce
 * comme deja juste, TOMBE — et pas parce que le refus manquait : il
 * existait, mais nommait le jeu `"Security,Distribution"` la ou la
 * documentation ecrit `Accepted values: Distribution, Security`. L'ordre
 * vient desormais de la table declaree une fois, donc des deux cotes le
 * message dit ce que la vraie machine dit.
 */
import { describe, it, expect } from 'vitest';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const MDP = '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd!" -AsPlainText -Force)';

async function controleur() {
  const dc = new WindowsServer('DC01');
  dc.powerOn();
  const ps = PowerShellSubShell.create(dc).subShell;
  const run = async (l: string) => (await ps.processLine(l)).output.join('\n').trim();
  await run('Install-WindowsFeature -Name AD-Domain-Services');
  await run(`Install-ADDSForest -DomainName "corp.local" -Force ${MDP}`);
  return { dc, run };
}

describe('New-ADGroup — le nom, le compte et les proprietes', () => {
  it('-SamAccountName est distinct du -Name, et le CN vient du -Name', async () => {
    const { run } = await controleur();
    await run('New-ADGroup -Name "Groupe Riche" -SamAccountName "riche" -GroupScope Global');
    const vue = await run('Get-ADGroup -Identity "riche" | Format-List Name, SamAccountName, DistinguishedName');
    expect(vue).toContain('Groupe Riche');
    expect(vue).toContain('riche');
    expect(await run('(Get-ADGroup -Identity "riche").DistinguishedName'))
      .toBe('CN=Groupe Riche,CN=Users,DC=corp,DC=local');
  });

  it('les quatre proprietes documentees sont conservees et relues', async () => {
    const { run } = await controleur();
    await run('New-ADGroup -Name "Comptables" -GroupScope Global -Description "Le service"'
      + ' -DisplayName "Comptabilite" -HomePage "http://intranet" -ManagedBy "Administrator"');
    const vue = await run('Get-ADGroup -Identity "Comptables" -Properties * | Format-List Description, DisplayName, HomePage, ManagedBy');
    for (const attendu of ['Le service', 'Comptabilite', 'http://intranet', 'Administrator']) {
      expect(vue).toContain(attendu);
    }
  });

  it('-OtherAttributes pose un attribut que les parametres ne couvrent pas', async () => {
    const { run } = await controleur();
    await run('New-ADGroup -Name "Autres" -GroupScope Global -OtherAttributes @{ info = "note interne" }');
    expect(await run('(Get-ADGroup -Identity "Autres" -Properties *).info')).toBe('note interne');
  });

  it('-Instance sert de gabarit, et un parametre explicite l\'emporte', async () => {
    const { run } = await controleur();
    await run('New-ADGroup -Name "Modele" -GroupScope Global -Description "heritee" -DisplayName "modele"');
    await run('$m = Get-ADGroup -Identity "Modele" -Properties *;'
      + ' New-ADGroup -Name "Copie" -GroupScope Global -Instance $m -DisplayName "propre"');
    const vue = await run('Get-ADGroup -Identity "Copie" -Properties * | Format-List Description, DisplayName');
    expect(vue).toContain('heritee');
    expect(vue).toContain('propre');
  });

  it('-Path place le groupe dans le conteneur nomme', async () => {
    const { run } = await controleur();
    await run('New-ADOrganizationalUnit -Name "Groupes" -ProtectedFromAccidentalDeletion $false');
    await run('New-ADGroup -Name "Locaux" -GroupScope DomainLocal -Path "OU=Groupes,DC=corp,DC=local"');
    expect(await run('(Get-ADGroup -Identity "Locaux").DistinguishedName'))
      .toBe('CN=Locaux,OU=Groupes,DC=corp,DC=local');
  });
});

describe('New-ADGroup — -GroupScope est obligatoire et verifie', () => {
  it('l\'omettre est refuse', async () => {
    const { run } = await controleur();
    expect(await run('New-ADGroup -Name "SansScope"'))
      .toContain('missing mandatory parameters: GroupScope');
    expect(await run('Get-ADGroup -Identity "SansScope"')).toContain('Cannot find an object');
  });

  it('une portee inconnue est REFUSEE, pas silencieusement corrigee', async () => {
    const { run } = await controleur();
    const sortie = await run('New-ADGroup -Name "Faux" -GroupScope Zorglub');
    expect(sortie).toContain('DomainLocal,Global,Universal');
    expect(await run('Get-ADGroup -Identity "Faux"')).toContain('Cannot find an object');
  });

  it('les trois portees documentees sont posees', async () => {
    const { run } = await controleur();
    for (const [nom, portee] of [['L', 'DomainLocal'], ['G', 'Global'], ['U', 'Universal']]) {
      await run(`New-ADGroup -Name "${nom}" -GroupScope ${portee}`);
      expect(await run(`(Get-ADGroup -Identity "${nom}").GroupScope`)).toBe(portee);
    }
  });

  it('les formes numeriques documentees sont acceptees', async () => {
    const { run } = await controleur();
    await run('New-ADGroup -Name "Num" -GroupScope 2 -GroupCategory 0');
    const vue = await run('Get-ADGroup -Identity "Num" | Format-List GroupScope, GroupCategory');
    expect(vue).toContain('Universal');
    expect(vue).toContain('Distribution');
  });

  it('-GroupScope est positionnel en seconde place', async () => {
    const { run } = await controleur();
    await run('New-ADGroup "Positionnelle" Universal');
    expect(await run('(Get-ADGroup -Identity "Positionnelle").GroupScope')).toBe('Universal');
  });
});

describe('New-ADGroup — sortie, essai et pipeline', () => {
  it('ne rend RIEN sans -PassThru', async () => {
    const { run } = await controleur();
    expect(await run('New-ADGroup -Name "Muette" -GroupScope Global')).toBe('');
  });

  it('rend l\'objet avec -PassThru', async () => {
    const { run } = await controleur();
    const sortie = await run('New-ADGroup -Name "Bavarde" -GroupScope Global -PassThru');
    expect(sortie).toContain('Bavarde');
    expect(sortie).toContain('CN=Bavarde,CN=Users,DC=corp,DC=local');
  });

  it('-WhatIf annonce l\'operation sans creer le groupe', async () => {
    const { run } = await controleur();
    expect(await run('New-ADGroup -Name "Essai" -GroupScope Global -WhatIf')).toContain('What if:');
    expect(await run('Get-ADGroup -Identity "Essai"')).toContain('Cannot find an object');
  });

  it('un objet passe dans le tuyau cree le groupe avec ses proprietes', async () => {
    const { run } = await controleur();
    expect(await run('[pscustomobject]@{ Name = "ParTuyau"; GroupScope = "Universal"; Description = "via pipeline" } | New-ADGroup')).toBe('');
    const vue = await run('Get-ADGroup -Identity "ParTuyau" -Properties Description | Format-List GroupScope, Description');
    expect(vue).toContain('Universal');
    expect(vue).toContain('via pipeline');
  });

  it('Set-ADGroup modifie une propriete sans toucher aux autres', async () => {
    const { run } = await controleur();
    await run('New-ADGroup -Name "Comptables" -GroupScope Global -Description "avant" -DisplayName "garde"');
    expect(await run('Set-ADGroup -Identity "Comptables" -Description "apres"')).toBe('');
    const vue = await run('Get-ADGroup -Identity "Comptables" -Properties * | Format-List Description, DisplayName');
    expect(vue).toContain('apres');
    expect(vue).toContain('garde');
  });
});

describe('New-ADGroup — ce qui etait deja juste', () => {
  it('TEMOIN — une creation nominale reste une creation', async () => {
    const { run } = await controleur();
    await run('New-ADGroup -Name "Temoin" -GroupScope Global');
    const vue = await run('Get-ADGroup -Identity "Temoin"');
    expect(vue).toContain('Temoin');
    expect(vue).toContain('CN=Temoin,CN=Users,DC=corp,DC=local');
  });

  it('une categorie inconnue est refusee', async () => {
    const { run } = await controleur();
    expect(await run('New-ADGroup -Name "X" -GroupScope Global -GroupCategory Zorglub'))
      .toContain('Distribution,Security');
  });

  it('sans -GroupCategory le groupe est de securite', async () => {
    const { run } = await controleur();
    await run('New-ADGroup -Name "Defaut" -GroupScope Global');
    expect(await run('(Get-ADGroup -Identity "Defaut").GroupCategory')).toBe('Security');
  });
});
