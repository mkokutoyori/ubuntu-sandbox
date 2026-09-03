/**
 * `Get-WindowsFeature` et `Install-WindowsFeature` rendent des OBJETS,
 * et `-WhatIf` n'installe rien.
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * Point de depart : la commande du tutoriel
 * `Install-WindowsFeature -Name AD-Domain-Services, DNS
 * -IncludeManagementTools -Restart` fonctionnait deja et rendait le bon
 * tableau. Ce qui suit dans un tutoriel ne fonctionnait pas.
 *
 * **Les deux cmdlets rendaient du TEXTE deja mis en forme.** Preuves
 * mesurees, chacune decisive a elle seule :
 *
 *   Get-WindowsFeature | Measure-Object   -> Count = 1   (une chaine)
 *   Get-WindowsFeature -Name DNS | Get-Member -MemberType Property
 *                                         -> `Length`   (propriete
 *                                            d'une CHAINE)
 *   Get-WindowsFeature | Where-Object Installed  -> RIEN
 *   $r = Install-WindowsFeature -Name DHCP; $r.Success -> vide
 *   Get-WindowsFeature -Name DNS | ConvertTo-Json -> le tableau RENDU,
 *                                            en guise de chaine JSON
 *
 * En PowerShell tout est objet et la mise en forme n'a lieu qu'a la
 * fin ; un cmdlet qui rend une chaine casse `Where-Object`,
 * `Select-Object`, `Measure-Object`, `ConvertTo-Json`, `$r.Propriete`,
 * `ForEach-Object` — c'est-a-dire tout ce qu'un tutoriel fait apres la
 * premiere commande.
 *
 * **`-WhatIf` INSTALLAIT.** Mesure :
 * `Install-WindowsFeature -Name DHCP -WhatIf` suivi de
 * `Get-WindowsFeature -Name DHCP` rendait `[X] Installed`. Le parametre
 * existe precisement pour ne PAS faire la chose, et il la faisait — un
 * apprenant qui verifie avant d'agir installait le role en silence.
 *
 * La cause n'etait pas dans le cmdlet mais dans le RUNTIME :
 * `PSRuntime` retirait `whatif` et `confirm` de la table des parametres
 * avant de la passer au cmdlet (`delete cmdletNamed['whatif']`), donc
 * AUCUN cmdlet du simulateur ne pouvait honorer `-WhatIf`. La regle
 * posee est etroite : un parametre commun n'est retire que si le cmdlet
 * ne le DECLARE pas. Seul un cmdlet qui l'annonce le recoit, donc rien
 * d'autre ne change de comportement.
 *
 * ── Ce qui vient d'une source et non de la memoire ──────────────────
 *
 * La documentation de `Get-WindowsFeature` donne les parametres reels
 * (`-ComputerName`, `-Credential`, `-LogPath`, `-Name`, `-Vhd`) et
 * celle d'`Install-WindowsFeature` y ajoute `-IncludeAllSubFeature`,
 * `-IncludeManagementTools`, `-Restart`, `-Source`,
 * `-ConfigurationFilePath`, `-WhatIf`, `-Confirm`. Les trois colonnes
 * (`Display Name`, `Name`, `Install State`), la case `[X]` pour une
 * fonctionnalite installee, et les proprietes `Name`, `DisplayName`,
 * `InstallState` (`Installed`/`Available`) et `Installed` (booleen,
 * d'ou `Where-Object Installed`) sont attestees par des transcriptions
 * publiees. Le libelle exact du preambule `-WhatIf` n'est atteste nulle
 * part de joignable : il n'est donc PAS invente, et le cmdlet se
 * contente de ne rien installer tout en montrant ce qui le serait, ce
 * que la documentation decrit mot pour mot.
 *
 * `FeatureType` est ajoute au catalogue avec les valeurs reelles
 * (`Role`, `Role Service`, `Feature`) parce qu'un tutoriel filtre
 * dessus. Ce qui n'a AUCUNE assise dans ce simulateur n'est pas
 * fabrique : le catalogue est PLAT, donc `Depth`, `Parent`,
 * `SubFeatures` et `Path` ne sont pas exposes — les inventer decrirait
 * un arbre que l'image ne porte pas.
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * L'etat d'avant restaure, 7 des 11 cas tombent — les cinq cas
 * d'objet, plus « `-WhatIf` n'installe pas » et « le service ne demarre
 * pas non plus ». Les 4 autres sont nommes ici plutot que laisses a
 * decouvrir, chacun avec sa raison de passer des deux cotes :
 *
 *   les DEUX cas de RENDU        c'est leur role : ils gardent que la
 *                                conversion en objets n'a rien change a
 *                                ce que l'operateur VOIT, la vue etant
 *                                desormais produite par `formatDefault`
 *                                au lieu d'etre pre-calculee ;
 *   « montre ce qui SERAIT
 *     installe »                 avant le correctif la commande
 *                                installait ET montrait, donc elle
 *                                montrait deja — ce cas ne vaut qu'a
 *                                cote de son voisin, qui verifie
 *                                qu'elle n'installe plus ;
 *   le TEMOIN sans `-WhatIf`     la commande doit installer, et c'est
 *                                ce qui empeche le correctif d'avoir
 *                                simplement casse l'installation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function serveur() {
  const srv = new WindowsServer('SRV1');
  srv.powerOn();
  const ps = PowerShellSubShell.create(srv).subShell;
  return async (ligne: string): Promise<string> =>
    (await ps.processLine(ligne)).output.join('\n');
}

const TUTORIEL = 'Install-WindowsFeature -Name AD-Domain-Services, DNS '
  + '-IncludeManagementTools -Restart';

describe('la commande du tutoriel, et ce qu\'elle rend', () => {
  it('installe les trois fonctionnalites et rend le tableau d\'IOS de Windows', async () => {
    const run = serveur();
    const sortie = await run(TUTORIEL);
    expect(sortie).toContain('Success Restart Needed Exit Code      Feature Result');
    expect(sortie).toContain('Active Directory Domain Services');
    expect(sortie).toContain('Active Directory module for Windows PowerShell');
    expect(sortie).toContain('DNS Server');
  });

  it('et `Get-WindowsFeature` garde ses trois colonnes et sa case [X]', async () => {
    const run = serveur();
    await run(TUTORIEL);
    const sortie = await run('Get-WindowsFeature -Name AD-Domain-Services');
    expect(sortie).toContain('Display Name');
    expect(sortie).toContain('Install State');
    expect(sortie).toContain('[X] Active Directory Domain Services');
  });
});

describe('ce sont des OBJETS, donc les pipelines fonctionnent', () => {
  it('`Measure-Object` compte les fonctionnalites, pas une chaine', async () => {
    const run = serveur();
    expect((await run(
      'Get-WindowsFeature | Measure-Object | Select-Object -ExpandProperty Count')).trim())
      .toBe('13');
  });

  it('`Where-Object Installed` ne rend que ce qui est installe', async () => {
    const run = serveur();
    await run(TUTORIEL);
    const sortie = await run(
      'Get-WindowsFeature | Where-Object { $_.Installed } | Select-Object -ExpandProperty Name');
    const noms = sortie.trim().split('\n').map(l => l.trim()).filter(Boolean);
    expect(noms.sort()).toEqual(['AD-Domain-Services', 'DNS', 'RSAT-AD-PowerShell']);
  });

  it('l\'objet de retour porte `Success` et `FeatureResult`', async () => {
    const run = serveur();
    expect((await run('$r = Install-WindowsFeature -Name DHCP; $r.Success')).trim()).toBe('True');
    expect(await run('$r = Install-WindowsFeature -Name Web-Server; $r.FeatureResult'))
      .toContain('Web Server (IIS)');
  });

  it('`FeatureType` distingue un role d\'une fonctionnalite', async () => {
    const run = serveur();
    expect((await run(
      'Get-WindowsFeature -Name AD-Domain-Services | Select-Object -ExpandProperty FeatureType'))
      .trim()).toBe('Role');
    expect((await run(
      'Get-WindowsFeature -Name RSAT-AD-PowerShell | Select-Object -ExpandProperty FeatureType'))
      .trim()).toBe('Feature');
  });

  it('une propriete se lit une par une, comme sur un vrai objet', async () => {
    const run = serveur();
    await run('Install-WindowsFeature -Name DNS');
    expect((await run(
      'Get-WindowsFeature -Name DNS | Select-Object -ExpandProperty InstallState')).trim())
      .toBe('Installed');
  });
});

describe('`-WhatIf` montre sans faire', () => {
  it('n\'installe PAS la fonctionnalite', async () => {
    const run = serveur();
    await run('Install-WindowsFeature -Name DHCP -WhatIf');
    expect(await run('Get-WindowsFeature -Name DHCP')).toContain('[ ] DHCP Server');
  });

  it('mais montre ce qui SERAIT installe', async () => {
    const run = serveur();
    expect(await run('Install-WindowsFeature -Name DHCP -WhatIf')).toContain('DHCP Server');
  });

  it('TEMOIN : sans lui, la meme commande installe', async () => {
    const run = serveur();
    await run('Install-WindowsFeature -Name DHCP');
    expect(await run('Get-WindowsFeature -Name DHCP')).toContain('[X] DHCP Server');
  });

  it('et le service du role ne demarre pas non plus', async () => {
    const run = serveur();
    await run('Install-WindowsFeature -Name DNS -WhatIf');
    expect(await run('Get-Service | Select-Object -ExpandProperty Name')).not.toContain('DNS');
  });
});
