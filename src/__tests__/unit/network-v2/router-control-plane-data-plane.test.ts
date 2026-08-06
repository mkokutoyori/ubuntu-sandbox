/**
 * Séparation plan de contrôle / plan de données sur un routeur.
 *
 * Sur du vrai matériel, la carte de commutation lit une FIB que le plan
 * de contrôle lui a téléchargée. Commuter un paquet n'exécute pas de
 * code protocolaire : ni DUAL, ni composition de session BGP, ni Hello.
 * Ce que le routeur commute est ce que la RIB contenait à l'instant où
 * le plan de contrôle l'a écrite.
 *
 * `Router.lookupRoute()` faisait reconverger les moteurs avant
 * chaque décision de commutation. Une convergence émet des paquets, et
 * un paquet redéclenchait une convergence — c'est ce qui permettait à
 * un voisin BGP injoignable de faire exploser le routeur (voir
 * bgp-unreachable-neighbor-storm.test.ts).
 *
 * La RIB reste à jour parce que le plan de contrôle réagit aux
 * évènements qui changent réellement le routage : la configuration, un
 * lien qui monte ou tombe, et un paquet protocolaire qui arrive.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function addrs(r: CiscoRouter, lan: string, wan: string): Promise<void> {
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand(`ip address ${lan} 255.255.255.0`);
  await r.executeCommand('no shutdown');
  await r.executeCommand('exit');
  await r.executeCommand('interface GigabitEthernet0/1');
  await r.executeCommand(`ip address ${wan} 255.255.255.252`);
  await r.executeCommand('no shutdown');
  await r.executeCommand('end');
}

async function eigrp(r: CiscoRouter): Promise<void> {
  await r.executeCommand('configure terminal');
  await r.executeCommand('router eigrp 100');
  await r.executeCommand('network 192.168.0.0 0.0.255.255');
  await r.executeCommand('network 10.0.0.0 0.0.0.3');
  await r.executeCommand('end');
}

describe('le plan de données ne fait pas converger le routage', () => {
  it("commuter un paquet n'appelle aucune convergence", async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    await addrs(r1, '192.168.1.1', '10.0.0.1');
    await addrs(r2, '192.168.2.1', '10.0.0.2');
    new Cable('wan').connect(
      r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
    await eigrp(r1);
    await eigrp(r2);

    const dyn = (r1 as unknown as {
      dynamicRouting: { converge(): void; eigrpRibUpdate(): void };
    }).dynamicRouting;

    let converges = 0;
    let ribUpdates = 0;
    const realConverge = dyn.converge.bind(dyn);
    const realRibUpdate = dyn.eigrpRibUpdate.bind(dyn);
    dyn.converge = () => { converges++; realConverge(); };
    dyn.eigrpRibUpdate = () => { ribUpdates++; realRibUpdate(); };

    // Une rafale de trafic à travers le routeur.
    for (let i = 0; i < 25; i++) await r1.executeCommand('ping 10.0.0.2');

    // Aucune convergence déclenchée par le trafic lui-même, et aucune
    // mise à jour de RIB : un ping ne fait pas tourner DUAL. Ce qui
    // déclenche l'une ou l'autre, c'est la configuration, un évènement
    // de lien, ou un paquet protocolaire — jamais une commutation.
    expect(converges).toBe(0);
    expect(ribUpdates).toBe(0);
  }, 60_000);
});

describe('le plan de contrôle tient la RIB à jour sur évènement', () => {
  it('un Update EIGRP reçu installe la route sans show ni trafic', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    await addrs(r1, '192.168.1.1', '10.0.0.1');
    await addrs(r2, '192.168.2.1', '10.0.0.2');
    new Cable('wan').connect(
      r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
    await eigrp(r1);
    await eigrp(r2);

    // Lecture directe de la RIB : ni `show`, ni ping, donc rien qui
    // puisse déclencher une convergence de rattrapage.
    const rib = (r1 as unknown as {
      getRoutingTable(): Array<{ network: { toString(): string }; type: string }>;
    }).getRoutingTable();
    const learned = rib.filter((e) => e.type === 'eigrp')
      .map((e) => e.network.toString());
    expect(learned).toContain('192.168.2.0');
  }, 60_000);

  it('un lien qui tombe retire la route apprise, sans trafic', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    await addrs(r1, '192.168.1.1', '10.0.0.1');
    await addrs(r2, '192.168.2.1', '10.0.0.2');
    const cable = new Cable('wan');
    cable.connect(
      r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
    await eigrp(r1);
    await eigrp(r2);
    expect(await r1.executeCommand('show ip route')).toMatch(/D\s+192\.168\.2\.0/);

    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/1');
    await r1.executeCommand('shutdown');
    await r1.executeCommand('end');

    expect(await r1.executeCommand('show ip route')).not.toMatch(/D\s+192\.168\.2\.0/);
  }, 60_000);

  it('la route apprise reste commutable après la configuration', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    await addrs(r1, '192.168.1.1', '10.0.0.1');
    await addrs(r2, '192.168.2.1', '10.0.0.2');
    new Cable('wan').connect(
      r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
    await eigrp(r1);
    await eigrp(r2);

    // Le chemin de données trouve la route sans avoir à la recalculer.
    const out = await r1.executeCommand('ping 192.168.2.1');
    expect(out).not.toMatch(/Success rate is 0 percent/);
  }, 60_000);
});
