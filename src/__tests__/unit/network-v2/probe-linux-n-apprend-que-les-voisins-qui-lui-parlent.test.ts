/*
 * Un hote Linux inscrivait dans sa table de voisinage TOUTE trame ARP qu'il
 * voyait passer : les annonces gratuites des routeurs, et les requetes
 * que deux autres machines s'echangeaient.
 *
 * Mesure de depart, sur la topologie de l'utilisateur rechargee
 * (`lan_with_firewall_fortigate.topology (1).json`) : avant le moindre
 * trafic,
 *
 *   PC1 : ip neigh      192.168.1.1, .2, .4, .5   REACHABLE
 *   Server3 : ip neigh  192.168.1.1, .2, .3, .4   REACHABLE
 *
 * et `/proc/sys/net/ipv4/conf/all/arp_accept` y lisait `0`. Un tcpdump sur
 * Server3 pendant un ping de PC1 ne montrait donc jamais PC1 demander sa
 * passerelle : il la « connaissait » deja.
 *
 * L'AUTORITE EST LE NOYAU (`net/ipv4/arp.c`, `arp_process`, lu sur
 * torvalds/linux) : une requete qui vise une adresse LOCALE cree
 * l'entree de son emetteur (`neigh_event_ns`) ; toute autre trame ne fait
 * que rafraichir une entree EXISTANTE (`__neigh_lookup(..., 0)`), et n'en
 * cree une que si `arp_accept` est leve — « Unsolicited ARP is not
 * accepted by default ». Une reponse a une requete que l'hote a lui-meme
 * emise trouve l'entree INCOMPLETE qu'il a creee en demandant.
 * `arp_accept` vaut `max(all, <iface>)`.
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire la reception
 * ARP.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 5 des 7 cas tombent. Les deux TEMOINS passent des deux cotes : la
 * reponse a sa propre requete, et l'emetteur d'une requete qui vise
 * l'hote, sont ce que Linux apprend de toute facon.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { pingOnSimulatedClock } from '../../support/fastPing';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function lab(): Promise<{ router: CiscoRouter; pc1: LinuxPC; pc2: LinuxPC }> {
  const lan = new GenericSwitch('switch-generic', 'LAN', 4, 0, 0);
  const router = new CiscoRouter('R1', 0, 0);
  const pc1 = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const pc2 = new LinuxPC('linux-pc', 'PC2', 0, 0);
  new Cable('c1').connect(router.getPorts()[0], lan.getPorts()[0]);
  new Cable('c2').connect(pc1.getPorts()[0], lan.getPorts()[1]);
  new Cable('c3').connect(pc2.getPorts()[0], lan.getPorts()[2]);
  await pc1.executeCommand('sudo ip addr add 192.168.1.3/24 dev eth0');
  await pc2.executeCommand('sudo ip addr add 192.168.1.4/24 dev eth0');
  for (const c of ['enable', 'configure terminal',
    `interface ${router.getPorts()[0].getName()}`, 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'end',
  ]) await router.executeCommand(c);
  return { router, pc1, pc2 };
}

describe('a gratuitous announcement creates no entry', () => {
  it('the address the router announces does not enter PC1 table', async () => {
    const { pc1 } = await lab();

    expect(await pc1.executeCommand('ip neigh')).not.toMatch(/^192\.168\.1\.1 /m);
  }, 30000);

  it('nor the one of a neighbour that assigns itself an address', async () => {
    const { pc1 } = await lab();

    expect(await pc1.executeCommand('ip neigh')).not.toMatch(/^192\.168\.1\.4 /m);
  }, 30000);

  it('`arp_accept=1` accepts it', async () => {
    const lan = new GenericSwitch('switch-generic', 'LAN', 4, 0, 0);
    const router = new CiscoRouter('R1', 0, 0);
    const pc1 = new LinuxPC('linux-pc', 'PC1', 0, 0);
    new Cable('c1').connect(router.getPorts()[0], lan.getPorts()[0]);
    new Cable('c2').connect(pc1.getPorts()[0], lan.getPorts()[1]);
    await pc1.executeCommand('sudo ip addr add 192.168.1.3/24 dev eth0');
    expect(await pc1.executeCommand('sudo sysctl -w net.ipv4.conf.all.arp_accept=1')).toBe('net.ipv4.conf.all.arp_accept = 1');
    for (const c of ['enable', 'configure terminal',
      `interface ${router.getPorts()[0].getName()}`, 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'end',
    ]) await router.executeCommand(c);

    expect(await pc1.executeCommand('ip neigh')).toMatch(/^192\.168\.1\.1 dev eth0 lladdr /m);
    expect(await pc1.executeCommand('cat /proc/sys/net/ipv4/conf/all/arp_accept')).toBe('1');
  }, 30000);
});

describe('a request between two others creates no entry', () => {
  it('PC2 asks for the router: PC1 learns neither', async () => {
    const { pc1, pc2 } = await lab();

    await pingOnSimulatedClock(pc2, 'ping -c 1 192.168.1.1');

    const neigh = await pc1.executeCommand('ip neigh');
    expect(neigh).not.toMatch(/^192\.168\.1\.1 /m);
    expect(neigh).not.toMatch(/^192\.168\.1\.4 /m);
  }, 30000);
});

describe('what Linux learns', () => {
  it('the reply to its own request — WITNESS', async () => {
    const { pc1 } = await lab();

    expect(await pingOnSimulatedClock(pc1, 'ping -c 1 192.168.1.1')).toMatch(/1 received/);
    expect(await pc1.executeCommand('ip neigh')).toMatch(/^192\.168\.1\.1 dev eth0 lladdr /m);
  }, 30000);

  it('the sender of a request aimed at it — WITNESS', async () => {
    const { pc1, pc2 } = await lab();

    await pingOnSimulatedClock(pc2, 'ping -c 1 192.168.1.3');

    expect(await pc1.executeCommand('ip neigh')).toMatch(/^192\.168\.1\.4 dev eth0 lladdr /m);
  }, 30000);

  it('PC1 asks for its gateway on the wire, not knowing it yet', async () => {
    const { pc1 } = await lab();
    await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
    const asked: string[] = [];
    const stop = pc1.getBus().subscribe('host.arp.request-sent', (event) => { asked.push(event.payload.targetIp); });

    await pingOnSimulatedClock(pc1, 'ping -c 1 192.168.1.1');
    stop();

    expect(asked).toEqual(['192.168.1.1']);
  }, 30000);
});
