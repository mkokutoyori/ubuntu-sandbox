/**
 * Une carte reseau Windows porte UNE identite, que cinq vues repetent.
 *
 * Ecrit A L'AVEUGLE. Mesure de depart : un poste Windows cable a un
 * poste Linux par un commutateur, `10.0.0.1/24` pose par `netsh`, trois
 * `ping`, puis la MEME question a chaque vue.
 *
 * ```
 * ipconfig /all        Description . . . : Intel(R) Ethernet Connection
 * route print          2...02 00 00 00 00 01 ......Intel(R) Ethernet Connection #1
 * getmac               02-00-00-00-00-01 \Device\Tcpip_Ethernet_0
 * systeminfo           [01]: Intel(R) Ethernet Connection
 * Get-NetAdapter       Intel(R) 82540EM Gigabit Ethernet Controller   ifIndex 2
 * arp -a               Interface: 10.0.0.1 --- 0x1
 * Get-NetNeighbor      ifIndex <colonne vide>  Ethernet 0  10.0.0.2
 * ```
 *
 * Quatre ecritures d'une meme carte, et aucune ne dit ce que dit la
 * cinquieme. `Get-NetAdapter` est pourtant la seule a LIRE le materiel
 * (`hardware.adapters[].model`, un 82540EM comme en pose QEMU) ; les
 * quatre autres portent une constante ecrite a la main dans leur propre
 * fichier. Le numero d'interface se contredit de la meme facon :
 * `route print` et `Get-NetAdapter` disent 2, `arp -a` dit 0x1, et
 * `Get-NetNeighbor` annonce une colonne `ifIndex` qu'il ne remplit pas.
 *
 * ── L'autorite ─────────────────────────────────────────────────────
 *
 * Sur une vraie machine, `ipconfig /all` « Description », la ligne
 * d'`Interface List` de `route print`, la colonne « Network Adapter »
 * de `getmac /v` et l'entree `Network Card(s)` de `systeminfo` rendent
 * TOUTES la description d'interface, celle que `Get-NetAdapter` publie
 * sous `InterfaceDescription`.
 *
 * `arp -a` prefixe chaque table par `Interface: <ip> --- 0x<n>`, ou `n`
 * est l'index d'interface EN HEXADECIMAL — le meme entier que
 * `route print` et `Get-NetAdapter`.
 *
 * `getmac` rend un « Transport Name » de la forme `\Device\Tcpip_{GUID}`,
 * ou le GUID est le `NetCfgInstanceId` de la carte, celui que
 * `Get-NetAdapter` publie sous `InterfaceGuid`.
 *
 * `Get-NetNeighbor` (MSFT_NetNeighbor) rend par defaut CINQ colonnes —
 * ifIndex, IPAddress, LinkLayerAddress, State, PolicyStore — sans
 * `InterfaceAlias` ; la documentation NetTCPIP donne `ifIndex` comme
 * l'alias de `InterfaceIndex`.
 *
 * ── Discrimination (`git stash push -- src/network src/powershell`) ─
 *
 * Mesuree : 12 cas sur 17 tombent contre l'etat d'avant. Les CINQ
 * autres passent des deux cotes, et chacun a sa raison :
 *  - TEMOINS — « route print numerote comme Get-NetAdapter » et
 *    « netstat -e compte comme Get-NetAdapterStatistics » : deux vues
 *    deja d'accord, qui prouvent que le laboratoire mesure bien une
 *    carte vivante et que les cinq autres avaient de quoi s'aligner ;
 *  - NON-REGRESSION — « une carte debranchee reste Media disconnected
 *    dans getmac » : la colonne Transport ne devient un GUID que pour
 *    une carte qui porte reellement le protocole ;
 *  - STRUCTUREL — « l index reste lisible par InterfaceIndex » :
 *    l'objet PORTAIT deja le bon entier ; c'est la VUE par defaut qui
 *    le perdait en nommant une colonne `ifIndex` absente de l'objet.
 *    Ce cas isole le defaut dans le rendu, pas dans la donnee ;
 *  - NON-REGRESSION — « Get-NetIPAddress filtre sans renumeroter la
 *    carte » : le provider calculait bien un second index, faux des
 *    qu'un alias filtrait la liste (`adapterIfIndex` sur la position
 *    DANS LE FILTRE), mais aucun lecteur ne rendait ce champ, donc
 *    rien ne le montrait. La deuxieme ecriture est supprimee ici avec
 *    les autres ; le cas garde la vue honnete si un lecteur apparait.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

interface Poste {
  executeCommand(cmd: string): Promise<string>;
  getPort(name: string): never;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function ps(w: Poste, line: string): Promise<string> {
  const sh = PowerShellSubShell.create(w as unknown as WindowsPC).subShell;
  return (await sh.processLine(line)).output.join('\n');
}

async function labo(): Promise<Poste> {
  const w = createDevice('windows-pc', 0, 0) as unknown as Poste;
  const l = createDevice('linux-pc', 200, 0) as unknown as Poste;
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 50, 50);
  new Cable('c1').connect(w.getPort('eth0'), sw.getPort('eth0')!);
  new Cable('c2').connect(l.getPort('eth0'), sw.getPort('eth1')!);
  await w.executeCommand('netsh interface ip set address "Ethernet 0" static 10.0.0.1 255.255.255.0');
  await l.executeCommand('sudo ip addr add 10.0.0.2/24 dev eth0');
  await l.executeCommand('sudo ip link set eth0 up');
  await w.executeCommand('ping -n 3 10.0.0.2');
  return w;
}

async function description(w: Poste, alias: string): Promise<string> {
  return (await ps(w, `(Get-NetAdapter -Name "${alias}").InterfaceDescription`)).trim();
}

async function ifIndex(w: Poste, alias: string): Promise<string> {
  return (await ps(w, `(Get-NetAdapter -Name "${alias}").ifIndex`)).trim();
}

async function guid(w: Poste, alias: string): Promise<string> {
  return (await ps(w, `(Get-NetAdapter -Name "${alias}").InterfaceGuid`)).trim();
}

describe('la description de la carte est ecrite une seule fois', () => {
  it('ipconfig /all rend celle de Get-NetAdapter', async () => {
    const w = await labo();
    const attendue = await description(w, 'Ethernet 0');

    const bloc = (await w.executeCommand('ipconfig /all')).split('Ethernet adapter Ethernet 1:')[0];
    const vue = /Description[ .]*: (.+)/.exec(bloc)?.[1].trim() ?? '<absent>';

    expect(attendue).toContain('82540EM');
    expect(vue).toBe(attendue);
  });

  it('la deuxieme carte porte le meme suffixe partout', async () => {
    const w = await labo();
    const attendue = await description(w, 'Ethernet 1');

    expect(attendue).toMatch(/#2$/);
    const bloc = (await w.executeCommand('ipconfig /all'))
      .split('Ethernet adapter Ethernet 1:')[1].split('Ethernet adapter Ethernet 2:')[0];
    expect(/Description[ .]*: (.+)/.exec(bloc)?.[1].trim()).toBe(attendue);
  });

  it('route print nomme la carte comme Get-NetAdapter', async () => {
    const w = await labo();
    const attendue = await description(w, 'Ethernet 0');

    const ligne = (await w.executeCommand('route print')).split('\n')
      .find((l) => l.includes('02 00 00 00 00 01')) ?? '<absente>';

    expect(ligne).toContain(attendue);
  });

  it('getmac /v nomme la carte comme Get-NetAdapter', async () => {
    const w = await labo();
    const attendue = await description(w, 'Ethernet 0');

    const ligne = (await w.executeCommand('getmac /v')).split('\n')
      .find((l) => l.includes('02-00-00-00-00-01')) ?? '<absente>';

    expect(ligne).toContain(attendue);
  });

  it('systeminfo nomme la carte comme Get-NetAdapter', async () => {
    const w = await labo();
    const attendue = await description(w, 'Ethernet 0');

    const sortie = await w.executeCommand('systeminfo');

    expect(sortie).toContain(`[01]: ${attendue}`);
  });
});

describe('le numero d interface est le meme dans toutes les vues', () => {
  it('arp -a prefixe avec l index en hexadecimal', async () => {
    const w = await labo();
    const attendu = Number(await ifIndex(w, 'Ethernet 0'));

    const entete = /Interface: 10\.0\.0\.1 --- 0x([0-9a-f]+)/
      .exec(await w.executeCommand('arp -a'))?.[1] ?? '<absent>';

    expect(attendu).toBeGreaterThan(1);
    expect(entete).toBe(attendu.toString(16));
  });

  it('Get-NetNeighbor remplit la colonne ifIndex qu il annonce', async () => {
    const w = await labo();
    const attendu = await ifIndex(w, 'Ethernet 0');

    const ligne = (await ps(w, 'Get-NetNeighbor')).split('\n')
      .find((l) => l.includes('10.0.0.2')) ?? '<absente>';

    expect(ligne.trim().split(/\s+/)[0]).toBe(attendu);
  });

  it('Get-NetNeighbor rend les cinq colonnes du vrai, sans InterfaceAlias', async () => {
    const w = await labo();

    const entete = (await ps(w, 'Get-NetNeighbor')).split('\n')
      .find((l) => l.includes('ifIndex')) ?? '<absente>';

    expect(entete.trim().split(/\s+/))
      .toEqual(['ifIndex', 'IPAddress', 'LinkLayerAddress', 'State', 'PolicyStore']);
  });

  it('Get-NetIPAddress filtre sans renumeroter la carte', async () => {
    const w = await labo();
    await w.executeCommand('netsh interface ip set address "Ethernet 1" static 172.16.0.1 255.255.0.0');
    const attendu = await ifIndex(w, 'Ethernet 1');

    const vue = await ps(w, '(Get-NetIPAddress -InterfaceAlias "Ethernet 1").InterfaceIndex');

    expect(attendu).toBe('3');
    expect(vue.trim()).toBe(attendu);
  });

  it('l index reste lisible par InterfaceIndex, alias documente', async () => {
    const w = await labo();
    const attendu = await ifIndex(w, 'Ethernet 0');

    const vue = await ps(w, '(Get-NetNeighbor -IPAddress 10.0.0.2).InterfaceIndex');

    expect(vue.trim()).toBe(attendu);
  });
});

describe('le GUID de la carte est celui que getmac transporte', () => {
  it('getmac rend \\Device\\Tcpip_{GUID}', async () => {
    const w = await labo();

    const ligne = (await w.executeCommand('getmac')).split('\n')
      .find((l) => l.includes('02-00-00-00-00-01')) ?? '<absente>';

    expect(ligne).toMatch(/\\Device\\Tcpip_\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}/);
  });

  it('ce GUID est celui que Get-NetAdapter publie', async () => {
    const w = await labo();
    const publie = await guid(w, 'Ethernet 0');

    const transporte = /\\Device\\Tcpip_(\{[0-9A-F-]+\})/
      .exec(await w.executeCommand('getmac'))?.[1] ?? '<absent>';

    expect(publie).toMatch(/^\{[0-9A-F-]+\}$/);
    expect(transporte).toBe(publie);
  });

  it('deux cartes de la meme machine ne partagent pas leur GUID', async () => {
    const w = await labo();

    const une = await guid(w, 'Ethernet 0');
    const deux = await guid(w, 'Ethernet 1');

    expect(une).not.toBe(deux);
  });

  it('deux machines differentes ne partagent pas le leur', async () => {
    const w = await labo();
    const autre = createDevice('windows-pc', 400, 0) as unknown as Poste;

    const ici = await guid(w, 'Ethernet 0');
    const la = await guid(autre, 'Ethernet 0');

    expect(la).toMatch(/^\{[0-9A-F-]+\}$/);
    expect(la).not.toBe(ici);
  });
});

describe('TEMOINS et NON-REGRESSION', () => {
  it('route print numerote comme Get-NetAdapter', async () => {
    const w = await labo();
    const attendu = await ifIndex(w, 'Ethernet 0');

    const ligne = (await w.executeCommand('route print')).split('\n')
      .find((l) => l.includes('02 00 00 00 00 01')) ?? '<absente>';

    expect(ligne.trim().split('.')[0]).toBe(attendu);
  });

  it('netstat -e compte comme Get-NetAdapterStatistics', async () => {
    const w = await labo();

    const octets = /Bytes\s+(\d+)\s+(\d+)/.exec(await w.executeCommand('netstat -e'));
    const stats = await ps(w, 'Get-NetAdapterStatistics');
    const recus = /ReceivedBytes\s+:\s+(\d+)/.exec(stats)?.[1] ?? '<absent>';

    expect(Number(octets?.[1])).toBeGreaterThan(0);
    expect(octets?.[1]).toBe(recus);
  });

  it('une carte debranchee reste Media disconnected dans getmac', async () => {
    const w = await labo();

    const ligne = (await w.executeCommand('getmac')).split('\n')
      .find((l) => l.includes('02-00-00-00-00-02')) ?? '<absente>';

    expect(ligne).toContain('Media disconnected');
  });
});
