/**
 * Un WAN d'entreprise a trois sites, et ce que `tracert` en dit.
 *
 * Trois routeurs, trois commutateurs et DEUX pare-feux FortiGate en
 * serie. Le chemin d'un bout a l'autre traverse six equipements de
 * niveau 3, et c'est precisement ce qu'une trace doit rendre visible :
 * chaque machine qui DECREMENTE le TTL apparait comme un saut, pare-feux
 * compris. Un pare-feu qui route sans se montrer serait un pare-feu
 * invisible a l'operateur qui diagnostique.
 *
 *   SITE A 10.1.0.0/24        SITE B 10.2.0.0/24        SITE C 10.3.0.0/24
 *     PC-A .10                  PC-B .10                  PC-C .10
 *       |                         |                         |
 *     SW-A                      SW-B                      SW-C
 *       |                         |                         |
 *   R-A Gi0/0 .1              R-B Gi0/0 .1              R-C Gi0/0 .1
 *   R-A Gi0/1 172.16.0.1      R-B Gi0/1 172.16.1.2      R-C Gi0/1 172.16.3.2
 *       |                     R-B Gi0/2 172.16.2.1          |
 *   FGT-1 port1 172.16.0.2        |                         |
 *   FGT-1 port2 172.16.1.1 ───────┘                         |
 *                             FGT-2 port1 172.16.2.2        |
 *                             FGT-2 port2 172.16.3.1 ───────┘
 *
 * La trace attendue de PC-A vers PC-C, six sauts :
 *
 *   1  10.1.0.1     R-A
 *   2  172.16.0.2   FGT-1
 *   3  172.16.1.2   R-B
 *   4  172.16.2.2   FGT-2
 *   5  172.16.3.2   R-C
 *   6  10.3.0.10    PC-C
 *
 * Les attentes sont ecrites A L'AVEUGLE d'apres ce que fait une vraie
 * infrastructure : `tracert` sous Windows sonde en ICMP Echo a TTL
 * croissant et lit les « Time Exceeded » que chaque routeur renvoie ;
 * `traceroute` sous Linux fait de meme. Un saut qui ne repond pas
 * s'affiche en etoiles, et une politique qui refuse le trafic coupe la
 * trace a l'equipement qui refuse.
 *
 * Le depot documente que la remise des trames est SYNCHRONE, donc le
 * temps d'aller-retour vaut zero en temps virtuel : aucun cas n'epingle
 * de duree, seulement l'ordre et l'identite des sauts.
 *
 * UNE PREMISSE FAUSSE, CORRIGEE AVANT D'ETRE EPINGLEE. Trois cas de la
 * premiere ecriture exigeaient que « Trace complete. » n'apparaisse PAS
 * quand la trace n'atteint jamais sa cible — limite de sauts atteinte,
 * pare-feu qui refuse, destination inconnue. C'est faux : `tracert`
 * imprime cette ligne a la fin de sa boucle, qu'il soit arrive ou qu'il
 * ait epuise ses sauts. L'exemple de la documentation de l'editeur ne
 * montre que le cas ou la cible repond, mais rien n'y conditionne la
 * ligne, et c'est bien ce que fait la commande. Le simulateur avait
 * raison et la sonde avait tort : ce sont les CAS qui ont ete corriges,
 * pas le moteur. Ce qui distingue une trace arrivee d'une trace perdue,
 * c'est le dernier saut — la cible, ou des etoiles.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask, MACAddress } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
});

const M24 = new SubnetMask('255.255.255.0');
const M30 = new SubnetMask('255.255.255.252');

interface Wan {
  pcA: WindowsPC;
  pcC: WindowsPC;
  lxA: LinuxPC;
  fgt1: FortiGate;
  fgt2: FortiGate;
}

function fortigate(fgt: FortiGate, port1: string, port2: string, routes: Array<[string, string, string]>): void {
  const sh = fgt.getShell();
  for (const line of [
    'config system interface',
    'edit "port1"', 'set mode static', `set ip ${port1} 255.255.255.252`, 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static', `set ip ${port2} 255.255.255.252`, 'set allowaccess ping', 'next',
    'end',
  ]) sh.execute(line);
  sh.execute('config router static');
  routes.forEach(([dst, mask, gw], i) => {
    for (const line of [`edit ${i + 1}`, `set dst ${dst} ${mask}`, `set gateway ${gw}`, 'next']) sh.execute(line);
  });
  sh.execute('end');
  for (const line of [
    'config firewall policy',
    'edit 1', 'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept', 'next',
    'edit 2', 'set srcintf "port2"', 'set dstintf "port1"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept', 'next',
    'end',
  ]) sh.execute(line);
}

async function wan(): Promise<Wan> {
  const pcA = new WindowsPC('windows-pc', 'PC-A');
  const pcC = new WindowsPC('windows-pc', 'PC-C');
  const lxA = new LinuxPC('linux-pc', 'LX-A');
  const swA = new GenericSwitch('switch-generic', 'SW-A', 8, 0, 0);
  const swB = new GenericSwitch('switch-generic', 'SW-B', 8, 0, 0);
  const swC = new GenericSwitch('switch-generic', 'SW-C', 8, 0, 0);
  const rA = new CiscoRouter('R-A', 0, 0);
  const rB = new CiscoRouter('R-B', 0, 0);
  const rC = new CiscoRouter('R-C', 0, 0);
  const fgt1 = new FortiGate('firewall-fortinet', 'FGT-1', 0, 0);
  const fgt2 = new FortiGate('firewall-fortinet', 'FGT-2', 0, 0);
  for (const d of [pcA, pcC, lxA, swA, swB, swC, rA, rB, rC, fgt1, fgt2]) d.powerOn();

  new Cable('a-pc').connect(pcA.getPorts()[0], swA.getPorts()[0]);
  new Cable('a-lx').connect(lxA.getPorts()[0], swA.getPorts()[1]);
  new Cable('a-gw').connect(rA.getPort('GigabitEthernet0/0')!, swA.getPorts()[7]);
  new Cable('a-fw').connect(rA.getPort('GigabitEthernet0/1')!, fgt1.getPort('port1')!);
  new Cable('fw-b').connect(fgt1.getPort('port2')!, rB.getPort('GigabitEthernet0/1')!);
  new Cable('b-gw').connect(rB.getPort('GigabitEthernet0/0')!, swB.getPorts()[7]);
  new Cable('b-fw').connect(rB.getPort('GigabitEthernet0/2')!, fgt2.getPort('port1')!);
  new Cable('fw-c').connect(fgt2.getPort('port2')!, rC.getPort('GigabitEthernet0/1')!);
  new Cable('c-gw').connect(rC.getPort('GigabitEthernet0/0')!, swC.getPorts()[7]);
  new Cable('c-pc').connect(pcC.getPorts()[0], swC.getPorts()[0]);

  pcA.getPorts()[0].configureIP(new IPAddress('10.1.0.10'), M24);
  lxA.getPorts()[0].configureIP(new IPAddress('10.1.0.20'), M24);
  pcC.getPorts()[0].configureIP(new IPAddress('10.3.0.10'), M24);
  pcA.setDefaultGateway(new IPAddress('10.1.0.1'));
  lxA.setDefaultGateway(new IPAddress('10.1.0.1'));
  pcC.setDefaultGateway(new IPAddress('10.3.0.1'));

  for (const c of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.1.0.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 172.16.0.1 255.255.255.252', 'no shutdown', 'exit',
    'ip route 0.0.0.0 0.0.0.0 172.16.0.2', 'end',
  ]) await rA.executeCommand(c);
  for (const c of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.2.0.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 172.16.1.2 255.255.255.252', 'no shutdown', 'exit',
    'interface GigabitEthernet0/2', 'ip address 172.16.2.1 255.255.255.252', 'no shutdown', 'exit',
    'ip route 10.1.0.0 255.255.255.0 172.16.1.1',
    'ip route 10.3.0.0 255.255.255.0 172.16.2.2',
    'ip route 172.16.3.0 255.255.255.252 172.16.2.2', 'end',
  ]) await rB.executeCommand(c);
  for (const c of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.3.0.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 172.16.3.2 255.255.255.252', 'no shutdown', 'exit',
    'ip route 0.0.0.0 0.0.0.0 172.16.3.1', 'end',
  ]) await rC.executeCommand(c);

  fortigate(fgt1, '172.16.0.2', '172.16.1.1', [
    ['10.1.0.0', '255.255.255.0', '172.16.0.1'],
    ['10.2.0.0', '255.255.255.0', '172.16.1.2'],
    ['10.3.0.0', '255.255.255.0', '172.16.1.2'],
  ]);
  fortigate(fgt2, '172.16.2.2', '172.16.3.1', [
    ['10.3.0.0', '255.255.255.0', '172.16.3.2'],
    ['10.1.0.0', '255.255.255.0', '172.16.2.1'],
    ['10.2.0.0', '255.255.255.0', '172.16.2.1'],
  ]);

  return { pcA, pcC, lxA, fgt1, fgt2 };
}

const hopOrder = (out: string, addresses: string[]): number[] =>
  addresses.map(a => out.indexOf(a));

describe('Scenario WAN — tracert a travers trois routeurs et deux pare-feux', () => {
  describe('le chemin de bout en bout', () => {
    it('joint le site C depuis le site A', async () => {
      const { pcA } = await wan();
      expect(await pcA.executeCommand('ping -n 1 10.3.0.10')).toMatch(/Received = 1/);
    }, 120_000);

    it('tracert nomme les six sauts, dans l ordre', async () => {
      const { pcA } = await wan();
      const out = await pcA.executeCommand('tracert -d 10.3.0.10');
      for (const hop of ['10.1.0.1', '172.16.0.2', '172.16.1.2', '172.16.2.2', '172.16.3.2', '10.3.0.10']) {
        expect(out).toContain(hop);
      }
      // L'en-tete « Tracing route to 10.3.0.10 » nomme deja la cible :
      // l'ordre se lit sur le corps de la trace, pas sur l'en-tete.
      const corps = out.slice(out.indexOf('over a maximum'));
      const positions = hopOrder(corps, ['10.1.0.1', '172.16.0.2', '172.16.1.2', '172.16.2.2', '172.16.3.2', '10.3.0.10']);
      expect(positions.every(p => p >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((x, y) => x - y));
    }, 120_000);

    it('montre les DEUX pare-feux comme des sauts a part entiere', async () => {
      const { pcA } = await wan();
      const out = await pcA.executeCommand('tracert -d 10.3.0.10');
      expect(out).toContain('172.16.0.2');
      expect(out).toContain('172.16.2.2');
    }, 120_000);

    it('annonce la fin de la trace', async () => {
      const { pcA } = await wan();
      expect(await pcA.executeCommand('tracert -d 10.3.0.10')).toMatch(/Trace complete/i);
    }, 120_000);
  });

  describe('traceroute depuis Linux, meme chemin', () => {
    it('rend les memes sauts dans le meme ordre', async () => {
      const { lxA } = await wan();
      const out = await lxA.executeCommand('traceroute -n 10.3.0.10');
      for (const hop of ['10.1.0.1', '172.16.0.2', '172.16.1.2', '172.16.2.2', '172.16.3.2', '10.3.0.10']) {
        expect(out).toContain(hop);
      }
    }, 120_000);
  });

  describe('le nombre de sauts se borne', () => {
    it('s arrete a la limite demandee', async () => {
      const { pcA } = await wan();
      const out = await pcA.executeCommand('tracert -d -h 2 10.3.0.10');
      expect(out).toMatch(/over a maximum of 2 hops/);
      expect(out).toContain('10.1.0.1');
      expect(out).toContain('172.16.0.2');
      expect(out).not.toContain('172.16.1.2');
      expect(out).not.toContain('172.16.3.2');
      expect(out).not.toContain('10.3.0.10\n');
    }, 120_000);
  });

  describe('un pare-feu qui refuse coupe la trace ou il refuse', () => {
    it('les sauts au-dela du refus ne repondent plus', async () => {
      const { pcA, fgt2 } = await wan();
      for (const line of ['config firewall policy', 'edit 1', 'set action deny', 'next', 'end']) {
        fgt2.getShell().execute(line);
      }
      const out = await pcA.executeCommand('tracert -d 10.3.0.10');
      // Le pare-feu qui refuse repond tout de meme au TTL expire chez lui :
      // l'expiration se juge a l'arrivee, la politique au reacheminement.
      expect(out).toContain('172.16.2.2');
      expect(out).not.toContain('172.16.3.2');
      const corps = out.slice(out.indexOf('172.16.2.2'));
      expect(corps).toMatch(/Request timed out/);
    }, 120_000);

    it('le site B reste joignable quand seul le lien vers C est refuse', async () => {
      const { pcA, fgt2 } = await wan();
      for (const line of ['config firewall policy', 'edit 1', 'set action deny', 'next', 'end']) {
        fgt2.getShell().execute(line);
      }
      expect(await pcA.executeCommand('ping -n 1 10.2.0.1')).toMatch(/Received = 1/);
    }, 120_000);
  });

  describe('une destination qui n existe pas', () => {
    it('ne rend aucun saut au-dela du dernier routeur qui sait', async () => {
      const { pcA } = await wan();
      const out = await pcA.executeCommand('tracert -d -h 4 10.9.9.9');
      expect(out).toContain('10.1.0.1');
      expect(out).toMatch(/Request timed out/);
      expect(out).not.toContain('172.16.0.2');
    }, 120_000);
  });
});
