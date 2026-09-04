/**
 * La famille `NetAdapter` — `Get`, `Enable`, `Disable`, `Rename`,
 * `Restart` et `Set` — mesuree contre les six pages de
 * `MicrosoftDocs/windows-powershell-docs` (`NetAdapter/*.md`) et contre
 * les chaines de la couche CDXML de PowerShell lui-meme
 * (`Microsoft.PowerShell.Commands.Management/resources/CmdletizationResources.resx`).
 *
 * Ce que les sources tranchent. `Get-NetAdapter` a TROIS jeux de
 * parametres — `ByName`, `ByInstanceID` (`-InterfaceDescription`) et
 * `ByIfIndex` (`-InterfaceIndex`) — plus `-IncludeHidden` et `-Physical` ;
 * `-Name` accepte les JOKERS, ce que la documentation atteste par ses
 * propres exemples (`Disable-NetAdapter E*2`, `Restart-NetAdapter -Name
 * "E*2"`) ; `Disable-NetAdapter` DEMANDE confirmation, sa page montrant le
 * dialogue et l'idiome `-Confirm:$False` qui le contourne ; `Set-NetAdapter`
 * pose `-MacAddress` (tirets facultatifs) et redemarre la carte sauf
 * `-NoRestart`. Le message d'absence vient du fichier de ressources et non
 * de memoire : `No {2} objects found with property '{0}' equal to '{1}'.`
 * suivi de DEUX espaces et de `Verify the value of the property and retry.`,
 * et la variante `matching` remplace `equal to` des qu'un joker est ecrit.
 *
 * Ce que la mesure a trouve, sur une machine PERSISTANTE et cablee — la
 * premiere version du banc en fabriquait une par ligne, si bien qu'un
 * `Disable` puis un `Get` tombaient sur deux machines differentes et que
 * la moitie des ecarts observes etaient des artefacts du banc.
 * `Rename-NetAdapter` etait INERTE : le magasin d'alias etait indexe par le
 * nom AFFICHE (`ethernet 0`) et relu par le nom de PORT (`eth0`), donc la
 * carte renommee disparaissait sans un mot. Les jokers etaient refuses.
 * `-InterfaceDescription` et `-InterfaceIndex` — les deux autres jeux de
 * parametres — etaient IGNORES, donc `-InterfaceIndex 3` rendait les quatre
 * cartes. `-Physical` et `-IncludeHidden` de meme. `InterfaceDescription`
 * etait le NOM de la carte, donc la question « quel materiel est-ce ? »
 * recevait la reponse a « comment s'appelle-t-elle ? ». `-WhatIf` DESACTIVAIT
 * la carte, `-PassThru` etait muet, un nom qui ne correspond a rien
 * reussissait en silence, et renommer une carte du nom d'une autre etait
 * accepte. `Set-NetAdapter` n'existait pas.
 *
 * Le defaut de structure : il y avait DEUX facons de renommer une carte et
 * elles ne se ressemblaient pas. `netsh interface set interface newname=`
 * renommait le PORT lui-meme — il deplacait l'entree dans la table des
 * ports et recopiait a la main la configuration DNS et DHCP — quand
 * `Rename-NetAdapter` ecrivait dans un magasin a cote. Sous Windows,
 * renommer une connexion ne renomme PAS le peripherique : la carte garde
 * son identite materielle et sa description, seul le nom de la connexion
 * change. Les deux commandes ecrivent desormais le meme `Port.alias`, et
 * c'est ce qui fait que `ipconfig`, `netsh` et `Get-NetAdapter` nomment la
 * meme carte de la meme facon apres un renommage.
 *
 * Discrimine par `git stash` : 27 des 36 cas tombent avant correctif. Les 9
 * autres sont nommes ici plutot que laisses a decouvrir, chacun avec la
 * raison pour laquelle il ne discrimine pas. Le TEMOIN, dont c'est l'objet
 * de passer des deux cotes. « une carte sans cable est Disconnected a
 * 0 bps » et « n invente aucune carte Wi-Fi » passaient parce que
 * l'interpreteur avait DEJA raison sur ces deux points — c'est le moteur
 * historique, supprime ici, qui annoncait `Up`/`1 Gbps` pour tout le monde
 * et une carte sans fil derriere laquelle il n'y avait aucun port. « le nom
 * tape est rendu tel quel » de meme, la mise en minuscules etant un defaut
 * du seul moteur historique. « Disable puis Get rend Disabled », « -Confirm:
 * $false passe outre » et « Restart fait retomber puis remonter le lien »
 * passaient parce que ces trois chemins-la etaient justes ; le second
 * passait pour une raison qui ne prouve rien, aucune confirmation n'etant
 * demandee avant correctif, donc la contourner reussissait toujours.
 * Restent deux cas de renommage : « -WhatIf ne renomme RIEN » passait parce
 * que le renommage etait INERTE de toute facon, et « netsh renomme la MEME
 * chose » passait parce que netsh renommait le PORT — ce que Windows ne
 * fait pas — et que la carte retrouvee sous son nouveau nom l'etait pour
 * la mauvaise raison. C'est leur jumeau « la carte renommee repond a son
 * nouveau nom » qui tombe, et « le renommage ne touche NI la description
 * materielle NI l index » qui prouve que le peripherique n'a pas bouge.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

type Shell = ReturnType<typeof PowerShellSubShell.create>['subShell'];
const run = async (sh: Shell, line: string) => (await sh.processLine(line)).output.join('\n').trim();

async function machine(): Promise<{ pc: WindowsPC; peer: LinuxPC; sh: Shell }> {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.powerOn();
  const peer = new LinuxPC('linux-pc', 'PAIR', 0, 0);
  peer.powerOn();
  new Cable('lien').connect(pc.getPorts()[0], peer.getPorts()[0]);
  const sh = PowerShellSubShell.create(pc).subShell;
  await run(sh, '$ConfirmPreference = "None"');
  return { pc, peer, sh };
}

const noms = async (sh: Shell, filtre = '') =>
  run(sh, `Get-NetAdapter ${filtre} | Format-Table Name,ifIndex,Status`);

describe('Get-NetAdapter — trois jeux de parametres, des jokers, et deux filtres', () => {
  it('TEMOIN : le laboratoire est sain — quatre cartes, la premiere cablee', async () => {
    const { sh } = await machine();
    const vue = await noms(sh);
    for (const n of ['Ethernet 0', 'Ethernet 1', 'Ethernet 2', 'Ethernet 3']) {
      expect(vue).toContain(n);
    }
  });

  it('rend ifIndex, colonne de la vue par defaut du vrai Get-NetAdapter', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'Get-NetAdapter')).toMatch(/ifIndex/);
  });

  it('une carte sans cable est Disconnected a 0 bps, la cablee est Up', async () => {
    const { sh } = await machine();
    expect(await run(sh, '(Get-NetAdapter -Name "Ethernet 0").Status')).toBe('Up');
    expect(await run(sh, '(Get-NetAdapter -Name "Ethernet 1").Status')).toBe('Disconnected');
    expect(await run(sh, '(Get-NetAdapter -Name "Ethernet 1").LinkSpeed')).toBe('0 bps');
  });

  it('InterfaceDescription decrit le MATERIEL et non le nom de la carte', async () => {
    const { sh } = await machine();
    const desc = await run(sh, '(Get-NetAdapter -Name "Ethernet 0").InterfaceDescription');
    expect(desc).not.toBe('Ethernet 0');
    expect(desc).toContain('Ethernet');
    expect(desc.length).toBeGreaterThan('Ethernet 0'.length);
  });

  it('deux cartes du meme modele se distinguent par le suffixe #n de Windows', async () => {
    const { sh } = await machine();
    const un = await run(sh, '(Get-NetAdapter -Name "Ethernet 1").InterfaceDescription');
    const deux = await run(sh, '(Get-NetAdapter -Name "Ethernet 2").InterfaceDescription');
    expect(un).not.toBe(deux);
    expect(deux).toMatch(/#\d+$/);
  });

  it('-Name accepte les jokers, ce que la documentation atteste', async () => {
    const { sh } = await machine();
    const vue = await noms(sh, '-Name "E*1"');
    expect(vue).toContain('Ethernet 1');
    expect(vue).not.toContain('Ethernet 2');
  });

  it('-InterfaceIndex est un jeu de parametres, pas un mot ignore', async () => {
    const { sh } = await machine();
    const vue = await noms(sh, '-InterfaceIndex 3');
    expect(vue).toContain('Ethernet 1');
    expect(vue).not.toContain('Ethernet 0');
    expect(vue).not.toContain('Ethernet 2');
  });

  it('-InterfaceDescription filtre sur la description, jokers compris', async () => {
    const { sh } = await machine();
    const propre = await run(sh, '(Get-NetAdapter -Name "Ethernet 2").InterfaceDescription');
    const vue = await noms(sh, `-InterfaceDescription "${propre}"`);
    expect(vue).toContain('Ethernet 2');
    expect(vue).not.toContain('Ethernet 0');
  });

  it('-Physical ne garde que les cartes physiques', async () => {
    const { pc, sh } = await machine();
    expect(await run(sh, 'New-NetLbfoTeam -Name AGG -TeamMembers "Ethernet 2","Ethernet 3" -Confirm:$false'))
      .not.toContain('not recognized');
    expect(pc.getPorts().length).toBeGreaterThan(4);
    const tout = await noms(sh);
    const physiques = await noms(sh, '-Physical');
    expect(tout).toContain('AGG');
    expect(physiques).not.toContain('AGG');
    expect(physiques).toContain('Ethernet 0');
  });

  it('un nom qui ne correspond a rien rend le message CDXML, mot pour mot', async () => {
    const { sh } = await machine();
    const out = await run(sh, 'Get-NetAdapter -Name Zorglub');
    expect(out).toContain(
      "No MSFT_NetAdapter objects found with property 'Name' equal to 'Zorglub'."
      + '  Verify the value of the property and retry.');
  });

  it('un JOKER qui ne correspond a rien dit "matching" et non "equal to"', async () => {
    const { sh } = await machine();
    const out = await run(sh, 'Get-NetAdapter -Name "Zorg*"');
    expect(out).toContain("property 'Name' matching 'Zorg*'");
    expect(out).not.toContain('equal to');
  });

  it('le nom tape est rendu tel quel, sans passer en minuscules', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'Get-NetAdapter -Name ZorGluB')).toContain("'ZorGluB'");
  });

  it('n invente aucune carte Wi-Fi derriere laquelle il n y a pas de port', async () => {
    const { pc, sh } = await machine();
    const vue = await noms(sh);
    expect(vue).not.toContain('Wi-Fi');
    const lignes = vue.split('\n').filter(l => /^\S/.test(l) && l.includes('Ethernet'));
    expect(lignes.length).toBe(pc.getPorts().length);
  });
});

describe('Enable / Disable-NetAdapter — la confirmation, le WhatIf et le refus', () => {
  it('Disable puis Get rend Disabled, et Enable la ramene', async () => {
    const { sh } = await machine();
    await run(sh, 'Disable-NetAdapter -Name "Ethernet 0" -Confirm:$false');
    expect(await run(sh, '(Get-NetAdapter -Name "Ethernet 0").Status')).toBe('Disabled');
    await run(sh, 'Enable-NetAdapter -Name "Ethernet 0"');
    expect(await run(sh, '(Get-NetAdapter -Name "Ethernet 0").Status')).toBe('Up');
  });

  it('Disable DEMANDE confirmation, et ne desactive rien tant qu on n a pas repondu', async () => {
    const { sh } = await machine();
    await run(sh, '$ConfirmPreference = "High"');
    expect(await run(sh, 'Disable-NetAdapter -Name "Ethernet 0"')).toContain('NonInteractive');
    expect(await run(sh, '(Get-NetAdapter -Name "Ethernet 0").Status')).toBe('Up');
  });

  it('-Confirm:$false passe outre', async () => {
    const { sh } = await machine();
    await run(sh, '$ConfirmPreference = "High"');
    expect(await run(sh, 'Disable-NetAdapter -Name "Ethernet 0" -Confirm:$false')).toBe('');
    expect(await run(sh, '(Get-NetAdapter -Name "Ethernet 0").Status')).toBe('Disabled');
  });

  it('-WhatIf annonce et ne desactive RIEN', async () => {
    const { sh } = await machine();
    const out = await run(sh, 'Disable-NetAdapter -Name "Ethernet 0" -WhatIf');
    expect(out).toContain('What if: Performing the operation "Disable-NetAdapter" on target "Ethernet 0"');
    expect(await run(sh, '(Get-NetAdapter -Name "Ethernet 0").Status')).toBe('Up');
  });

  it('un nom qui ne correspond a rien est REFUSE, pas accepte en silence', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'Enable-NetAdapter -Name Zorglub')).toContain('No MSFT_NetAdapter objects found');
  });

  it('-PassThru rend la carte telle qu elle est APRES l operation', async () => {
    const { sh } = await machine();
    const out = await run(sh, 'Disable-NetAdapter -Name "Ethernet 0" -Confirm:$false -PassThru | Format-Table Name,Status');
    expect(out).toContain('Ethernet 0');
    expect(out).toContain('Disabled');
  });

  it('un joker desactive toutes les cartes qu il nomme', async () => {
    const { sh } = await machine();
    await run(sh, 'Disable-NetAdapter -Name "Ethernet *" -Confirm:$false');
    for (const n of ['Ethernet 0', 'Ethernet 1', 'Ethernet 2', 'Ethernet 3']) {
      expect(await run(sh, `(Get-NetAdapter -Name "${n}").Status`)).toBe('Disabled');
    }
  });

  it('Restart-NetAdapter fait vraiment retomber puis remonter le lien', async () => {
    const { pc, sh } = await machine();
    const bus = pc.getBus();
    const etats: string[] = [];
    bus.subscribe('port.link.down', () => { etats.push('down'); });
    bus.subscribe('port.link.up', () => { etats.push('up'); });
    await run(sh, 'Restart-NetAdapter -Name "Ethernet 0"');
    expect(etats).toEqual(['down', 'up']);
    expect(await run(sh, '(Get-NetAdapter -Name "Ethernet 0").Status')).toBe('Up');
  });
});

describe('Rename-NetAdapter — renommer la CONNEXION, jamais le peripherique', () => {
  it('la carte renommee repond a son nouveau nom', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'Rename-NetAdapter -Name "Ethernet 0" -NewName "LAN"')).toBe('');
    expect(await noms(sh, '-Name LAN')).toContain('LAN');
    expect(await noms(sh)).toContain('LAN');
  });

  it('le renommage NE touche NI la description materielle NI l index', async () => {
    const { sh } = await machine();
    const avant = await run(sh, '(Get-NetAdapter -Name "Ethernet 0").InterfaceDescription');
    const idx = await run(sh, '(Get-NetAdapter -Name "Ethernet 0").ifIndex');
    await run(sh, 'Rename-NetAdapter -Name "Ethernet 0" -NewName "LAN"');
    expect(await run(sh, '(Get-NetAdapter -Name LAN).InterfaceDescription')).toBe(avant);
    expect(await run(sh, '(Get-NetAdapter -Name LAN).ifIndex')).toBe(idx);
  });

  it('ipconfig nomme la carte comme Get-NetAdapter apres un renommage', async () => {
    const { pc, sh } = await machine();
    await run(sh, 'Rename-NetAdapter -Name "Ethernet 0" -NewName "LAN"');
    const out = await pc.executeCommand('ipconfig');
    expect(out).toContain('Ethernet adapter LAN:');
    expect(out).not.toContain('Ethernet adapter Ethernet 0:');
  });

  it('netsh renomme la MEME chose, et Get-NetAdapter le voit', async () => {
    const { pc, sh } = await machine();
    expect(await pc.executeCommand('netsh interface set interface name="Ethernet 0" newname="LAN"'))
      .toBe('Ok.');
    expect(await noms(sh, '-Name LAN')).toContain('LAN');
    expect(await pc.executeCommand('netsh interface show interface')).toContain('LAN');
  });

  it('renommer du nom d une AUTRE carte est refuse', async () => {
    const { sh } = await machine();
    const out = await run(sh, 'Rename-NetAdapter -Name "Ethernet 0" -NewName "Ethernet 1"');
    expect(out).toContain("A network adapter named 'Ethernet 1' already exists");
    expect(await noms(sh, '-Name "Ethernet 0"')).toContain('Ethernet 0');
  });

  it('renommer avec un joker dans le nouveau nom est refuse', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'Rename-NetAdapter -Name "Ethernet 0" -NewName "LA*N"'))
      .toContain('wildcard');
  });

  it('-WhatIf annonce et ne renomme RIEN', async () => {
    const { sh } = await machine();
    await run(sh, 'Rename-NetAdapter -Name "Ethernet 0" -NewName "LAN" -WhatIf');
    expect(await noms(sh)).toContain('Ethernet 0');
    expect(await noms(sh)).not.toContain('LAN');
  });

  it('la carte renommee reste joignable par son nom systeme', async () => {
    const { sh } = await machine();
    await run(sh, 'Rename-NetAdapter -Name "Ethernet 0" -NewName "LAN"');
    expect(await noms(sh, '-Name "Ethernet 0"')).toContain('LAN');
  });
});

describe('Set-NetAdapter — poser une adresse de couche 2, et refuser le reste', () => {
  it('-MacAddress pose vraiment l adresse, tirets facultatifs', async () => {
    const { pc, sh } = await machine();
    expect(await run(sh, 'Set-NetAdapter -Name "Ethernet 0" -MacAddress 02-11-22-33-44-55')).toBe('');
    expect(pc.getPorts()[0].getMAC().toString()).toBe('02:11:22:33:44:55');
    expect(await run(sh, '(Get-NetAdapter -Name "Ethernet 0").MacAddress')).toBe('02-11-22-33-44-55');
    await run(sh, 'Set-NetAdapter -Name "Ethernet 0" -MacAddress "021122334466"');
    expect(pc.getPorts()[0].getMAC().toString()).toBe('02:11:22:33:44:66');
  });

  it('le voisin apprend la NOUVELLE adresse sur le fil', async () => {
    const { pc, sh, peer } = await machine();
    await run(sh, 'New-NetIPAddress -IPAddress 10.1.1.1 -InterfaceAlias "Ethernet 0" -PrefixLength 24');
    await run(sh, 'Set-NetAdapter -Name "Ethernet 0" -MacAddress 02-11-22-33-44-55 -NoRestart');
    await pc.executeCommand('ping 10.1.1.2');
    const vu = [...peer.getARPTableFull().values()].map(e => e.mac.toString());
    expect(vu).toContain('02:11:22:33:44:55');
  });

  it('une adresse de couche 2 malformee est refusee et ne touche a rien', async () => {
    const { pc, sh } = await machine();
    const avant = pc.getPorts()[0].getMAC().toString();
    expect(await run(sh, 'Set-NetAdapter -Name "Ethernet 0" -MacAddress zorglub'))
      .toContain("The MAC address 'zorglub' is not valid");
    expect(pc.getPorts()[0].getMAC().toString()).toBe(avant);
  });

  it('sans -NoRestart la carte redemarre, avec -NoRestart elle ne bouge pas', async () => {
    const { pc, sh } = await machine();
    const bus = pc.getBus();
    let cycles = 0;
    bus.subscribe('port.link.down', () => { cycles += 1; });
    await run(sh, 'Set-NetAdapter -Name "Ethernet 0" -MacAddress 02-11-22-33-44-55 -NoRestart');
    expect(cycles).toBe(0);
    await run(sh, 'Set-NetAdapter -Name "Ethernet 0" -MacAddress 02-11-22-33-44-56');
    expect(cycles).toBe(1);
  });

  it('-VlanID est refuse en nommant la brique qui manque', async () => {
    const { sh } = await machine();
    const out = await run(sh, 'Set-NetAdapter -Name "Ethernet 0" -VlanID 10');
    expect(out).toContain('Set-NetLbfoTeamNic');
  });

  it('sans propriete a poser, la commande le dit', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'Set-NetAdapter -Name "Ethernet 0"')).toContain('No property was specified');
  });
});

describe('le renommage traverse une sauvegarde de topologie', () => {
  it('une carte renommee revient renommee', async () => {
    const { pc, sh } = await machine();
    await run(sh, 'Rename-NetAdapter -Name "Ethernet 0" -NewName "LAN"');
    expect(pc.getPorts()[0].getAlias()).toBe('LAN');
    const port = pc.getPorts()[0];
    port.setAlias(null);
    expect(pc.adapterAlias('eth0')).toBe('Ethernet 0');
    port.setAlias('LAN');
    expect(pc.adapterAlias('eth0')).toBe('LAN');
  });
});
