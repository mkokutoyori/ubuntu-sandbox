/**
 * Une FortiGate tient ses routes RIP prefixe par prefixe : une mise a
 * jour remplace la route qu'elle rafraichit, une route empoisonnee quitte
 * le service, le ramassage n'emporte que la sienne, ses mises a jour
 * periodiques portent sa table, un seul moteur parle a la fois, et
 * `passive-interface` / `default-information-originate` decident.
 *
 * Mesure de depart (dcc63255), FortiGate FGT (port2) — Cisco R1, qui
 * annonce 172.16.1.0/24 et 192.168.50.0/24, sous horloge virtuelle :
 * - dix rafraichissements plus tard, `get router info routing-table
 *   database` listait 172.16.1.0/24 douze fois : chaque mise a jour
 *   ajoutait un enregistrement au lieu de remplacer le sien ;
 * - R1 eteint Loopback2 et empoisonne 192.168.50.0/24 : la route restait
 *   `[120/1]` dans la table, la copie a la metrique 16 rangee derriere ;
 * - au ramassage de la route empoisonnee, TOUTES les routes RIP
 *   quittaient la table, 172.16.1.0/24 absente 25 s jusqu'a la mise a
 *   jour suivante de R1 ;
 * - la table que le moteur annonce n'etait faite que des reseaux
 *   connectes : aucune mise a jour periodique ne portait une route
 *   apprise, et un routeur R3 derriere port3 perdait au bout de 180 s la
 *   route que la mise a jour declenchee lui avait donnee ;
 * - chaque validation de `config router rip` construisait un moteur neuf
 *   sans arreter l'ancien ; supprimer le dernier reseau laissait
 *   l'ancien moteur en vie ;
 * - `passive-interface` et `default-information-originate` etaient
 *   acceptes, rendus par `show`, et jamais passes au moteur ;
 * - une route apprise d'un reseau branche sur R1 s'affichait `[120/1]`.
 *
 * Autorites : RFC 2453 §3.8 (une route a la metrique 16 quitte le
 * service ; le ramassage supprime CETTE route) et §3.9.2 (une reponse du
 * meme voisin adopte la nouvelle metrique : la route est remplacee, pas
 * doublee ; la metrique recue augmente du cout du reseau d'arrivee) ;
 * sortie capturee d'une FortiGate 7.2-7.6 (infosecmonkey, « Configuring
 * RIP on FortiGate ») : `R       10.0.2.0/24 [120/2] via 198.18.1.2,
 * port2, 00:04:12` pour le reseau branche sur le voisin — la ou IOS
 * ecrit `[120/1]` ; reference CLI FortiOS, `config router rip` :
 * passive-interface « Passive interface configuration »,
 * default-information-originate « Enable/disable generation of default
 * route ».
 *
 * Discrimination, mesuree sur le commit de base (dcc63255) avec ce
 * fichier copie : 9 des 10 cas tombent. Passe des deux cotes le TEMOIN :
 * la FortiGate apprend les deux boucles locales de R1.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<void> {
  for (const command of commands) await device.executeCommand(command);
}

const RIP_PORT = 520;
const RIP_RESPONSE = 2;

function ripUpdatesSentBy(fw: FortiGate): () => number {
  let count = 0;
  fw.getBus().subscribe('port.frame.tx-requested', (event) => {
    const frame = (event as { payload: { frame?: { payload?: {
      protocol?: number; payload?: { destinationPort?: number; payload?: { type?: string; command?: number } };
    } } } }).payload.frame;
    const datagram = frame?.payload?.payload;
    if (frame?.payload?.protocol === 17 && datagram?.destinationPort === RIP_PORT
      && datagram.payload?.type === 'rip' && datagram.payload.command === RIP_RESPONSE) count++;
  });
  return () => count;
}

async function lab(firewallRip: readonly string[] = []) {
  const clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const r1 = new CiscoRouter('R1', 200, 0);
  new Cable('fgt-r1').connect(fw.getPort('port2')!, r1.getPort('GigabitEthernet0/0')!);
  await type(fw, ['config system interface',
    'edit port2', 'set ip 10.0.0.1 255.255.255.0', 'set allowaccess ping', 'next', 'end']);
  await type(r1, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
    'interface Loopback1', 'ip address 172.16.1.1 255.255.255.0', 'exit',
    'interface Loopback2', 'ip address 192.168.50.1 255.255.255.0', 'exit',
    'router rip', 'version 2', 'no auto-summary',
    'network 10.0.0.0', 'network 172.16.0.0', 'network 192.168.50.0', 'end']);
  await type(fw, ['config router rip', 'set version 2', ...firewallRip,
    'config network', 'edit 1', 'set prefix 10.0.0.0 255.255.255.0', 'next', 'end', 'end']);
  clock.advance(35_000);
  return { clock, fw, r1 };
}

const table = (fw: FortiGate) => fw.executeCommand('get router info routing-table all');

async function transitLab() {
  const { clock, fw, r1 } = await lab();
  const r3 = new CiscoRouter('R3', 400, 0);
  new Cable('fgt-r3').connect(fw.getPort('port3')!, r3.getPort('GigabitEthernet0/0')!);
  await type(fw, ['config system interface',
    'edit port3', 'set ip 10.0.1.1 255.255.255.0', 'next', 'end',
    'config router rip', 'config network', 'edit 2', 'set prefix 10.0.1.0 255.255.255.0', 'next', 'end', 'end']);
  await type(r3, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.1.2 255.255.255.0', 'no shutdown', 'exit',
    'router rip', 'version 2', 'no auto-summary', 'network 10.0.0.0', 'end']);
  clock.advance(35_000);
  return { clock, fw, r1, r3 };
}

describe('FortiGate RIP routes, prefix by prefix', () => {
  it('WITNESS: the firewall learns both loopbacks R1 advertises', async () => {
    const { fw } = await lab();
    const routes = await table(fw);
    expect(routes).toMatch(/^R\s+172\.16\.1\.0\/24 \[120\/\d+\] via 10\.0\.0\.2, port2/m);
    expect(routes).toMatch(/^R\s+192\.168\.50\.0\/24 \[120\/\d+\] via 10\.0\.0\.2, port2/m);
  });

  it('the metric counts the hop the update arrived on: a network on R1 is [120/2]', async () => {
    const { fw } = await lab();
    expect(await table(fw)).toMatch(/^R\s+172\.16\.1\.0\/24 \[120\/2\] via 10\.0\.0\.2, port2/m);
  });

  it('ten refreshes later, the routing database holds each RIP route once', async () => {
    const { clock, fw } = await lab();
    clock.advance(300_000);
    const database = await fw.executeCommand('get router info routing-table database');
    expect(database.match(/172\.16\.1\.0\/24/g)).toHaveLength(1);
  });

  it('a poisoned route leaves service at once, and only that one', async () => {
    const { clock, fw, r1 } = await lab();
    await type(r1, ['configure terminal', 'interface Loopback2', 'shutdown', 'end']);
    clock.advance(6_000);
    const routes = await table(fw);
    expect(routes).not.toContain('192.168.50.0/24');
    expect(routes).toMatch(/^R\s+172\.16\.1\.0\/24/m);
  });

  it('collecting the poisoned route never takes another route with it', async () => {
    const { clock, fw, r1 } = await lab();
    await type(r1, ['configure terminal', 'interface Loopback2', 'shutdown', 'end']);
    const absences: number[] = [];
    for (let second = 0; second < 150; second++) {
      clock.advance(1_000);
      if (!fw.getRouteTable().selected().some((route) => route.network === '172.16.1.0')) absences.push(second);
    }
    expect(absences).toEqual([]);
  });

  it('a route learned from one neighbour stays advertised to another past the timeout', async () => {
    const { clock, r3 } = await transitLab();
    clock.advance(200_000);
    expect(await r3.executeCommand('show ip route')).toMatch(/^R\s+172\.16\.1\.0 \[120\/2\] via 10\.0\.1\.1,/m);
  });

  it('committing the RIP configuration again leaves one engine speaking', async () => {
    const { clock, fw } = await lab();
    await type(fw, ['config router rip', 'set version 2', 'end']);
    const sent = ripUpdatesSentBy(fw);
    clock.advance(60_000);
    expect(sent()).toBe(2);
  });

  it('deleting the last network silences RIP', async () => {
    const { clock, fw } = await lab();
    const sent = ripUpdatesSentBy(fw);
    clock.advance(60_000);
    const speaking = sent();
    await type(fw, ['config router rip', 'config network', 'delete 1', 'end', 'end']);
    clock.advance(60_000);
    expect([speaking, sent() - speaking]).toEqual([2, 0]);
  });

  it('a passive interface sends no update and still learns', async () => {
    const { clock, fw } = await lab();
    const sent = ripUpdatesSentBy(fw);
    clock.advance(60_000);
    const speaking = sent();
    await type(fw, ['config router rip', 'set passive-interface "port2"', 'end']);
    clock.advance(200_000);
    expect([speaking, sent() - speaking]).toEqual([2, 0]);
    expect(await table(fw)).toMatch(/^R\s+172\.16\.1\.0\/24/m);
  });

  it('default-information-originate gives R1 a default route through the firewall', async () => {
    const { clock, r1 } = await lab(['set default-information-originate enable']);
    clock.advance(35_000);
    expect(await r1.executeCommand('show ip route')).toMatch(/^R\*\s+0\.0\.0\.0\/0 \[120\/1\] via 10\.0\.0\.1,/m);
  });
});
