/**
 * Un routeur choisit sa sortie par sa TABLE DE ROUTAGE, et une adresse
 * posee sur un port y met une route connectee.
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * Syslog, NetFlow et SNMP portaient chacun leur propre `resolveEgress`,
 * TROIS copies du meme parcours -- « quel port est sur le meme
 * sous-reseau que la cible ? » -- ecrites a la main en
 * `split('.').map(Number)` alors qu'`IPAddress`/`SubnetMask` repondent
 * deja a la question. Elles ne repondaient PAS a la bonne : un routeur
 * ne cherche pas un port du meme sous-reseau, il consulte sa table.
 *
 * Le parcours retombait, quand aucun port n'est sur le sous-reseau de
 * la cible, sur LE PREMIER PORT qui porte une adresse et dont le lien
 * est up -- quel que soit l'endroit ou se trouve la cible. C'est ce
 * repli qu'il fallait mesurer plutot que supposer : sur un routeur a
 * une seule liaison montante il donne la bonne reponse par accident, si
 * bien qu'un laboratoire a un seul uplink ne distingue rien. Le cas
 * discriminant ci-dessous en donne DEUX : le collecteur est joignable
 * par une route statique sortant du SECOND, et le repli envoyait
 * l'export par le premier -- dans la mauvaise direction.
 *
 * ── Le defaut que la conversion a revele, et qui etait plus grave ───
 *
 * Une fois syslog passe par la table, ses laboratoires sont tombes :
 * `port.configureIP()` posait l'adresse SANS poser la route connectee,
 * seul `Router.configureInterface()` le faisait. Une machine avec une
 * adresse et aucune route n'existe pas -- configurer une adresse EST ce
 * qui cree la route connectee -- et le piege etait ouvert a tout
 * appelant : vingt-quatre cas de quatre fichiers etaient tombes dedans,
 * et le client DHCP du routeur n'y echappait qu'en appelant les DEUX.
 *
 * Le correctif est a la SOURCE plutot que dans les laboratoires :
 * `Port.setAddressListener` previent son proprietaire a chaque
 * changement d'adresse -- primaire, secondaire, effacement -- et
 * `Router.reconcileConnectedRoutes` est le SEUL ecrivain des routes
 * connectees, `configureInterface` et `unconfigureInterface` le lisant
 * desormais au lieu de porter chacun sa moitie de la regle. Le crochet
 * est pose depuis l'interieur et non par un abonnement au bus, pour la
 * raison qu'`attachSocketSink` ecrit deja dans `TcpStack` : le bus est
 * remis a zero avant chaque test, et un abonne mort ne se voit pas.
 *
 * ── Ce qui n'a PAS ete converti, et pourquoi ────────────────────────
 *
 * La REPONSE SNMP (`get-response`) repart par l'interface d'ARRIVEE et
 * non par la table : son adresse source doit etre celle que le
 * gestionnaire a composee, sans quoi il rejette la reponse. Ce n'est
 * pas une decision de routage, et la router serait un defaut.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * QUATRE cas sur sept tombent contre l'etat d'avant : les deux routes
 * connectees posees par `configureIP`/`clearIP`, et les deux exports
 * dont la route sort du SECOND uplink. Les trois autres passent des
 * deux cotes et le doivent -- les deux TEMOINS, sans lesquels un
 * laboratoire mal bati et un correctif reel seraient indiscernables, et
 * la reconfiguration par la CLI, qui posait deja la bonne route et dont
 * ce cas garde seulement qu'elle ne la pose pas deux fois.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { IPv4Packet, UDPPacket } from '@/network/core/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const MASK24 = new SubnetMask('255.255.255.0');

function connectedNetworks(router: CiscoRouter): string[] {
  return router.getRoutingTable()
    .filter((r) => r.type === 'connected')
    .map((r) => `${r.network}/${r.mask} ${r.iface}`)
    .sort();
}

function udpArrivals(target: CiscoRouter, port: number): UDPPacket[] {
  const seen: UDPPacket[] = [];
  for (const p of target.getPorts()) {
    p.attachTap(({ direction, frame }) => {
      if (direction !== 'in') return;
      const packet = frame.payload as IPv4Packet | undefined;
      if (packet?.type !== 'ipv4') return;
      const udp = packet.payload as UDPPacket | undefined;
      if (udp?.type === 'udp' && udp.destinationPort === port) seen.push(udp);
    });
  }
  return seen;
}

describe('une adresse posee sur un port pose sa route connectee', () => {
  it('configureIP suffit, sans passer par configureInterface', () => {
    const r = new CiscoRouter('R1');
    const port = r.getPort('GigabitEthernet0/0')!;
    port.setAdminShutdown(false);
    port.configureIP(new IPAddress('10.0.0.1'), MASK24);

    expect(connectedNetworks(r)).toEqual(['10.0.0.0/255.255.255.0 GigabitEthernet0/0']);
  });

  it('clearIP la retire, et une adresse secondaire ajoute la sienne', () => {
    const r = new CiscoRouter('R1');
    const port = r.getPort('GigabitEthernet0/0')!;
    port.setAdminShutdown(false);
    port.configureIP(new IPAddress('10.0.0.1'), MASK24);
    port.addSecondaryIP(new IPAddress('192.168.5.1'), MASK24);

    expect(connectedNetworks(r)).toEqual([
      '10.0.0.0/255.255.255.0 GigabitEthernet0/0',
      '192.168.5.0/255.255.255.0 GigabitEthernet0/0',
    ]);

    port.clearIP();
    expect(connectedNetworks(r)).toEqual([]);
  });

  it('la route n\'est pas posee deux fois quand la CLI reconfigure', async () => {
    const r = new CiscoRouter('R1');
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'ip address 10.0.0.1 255.255.255.0',
      'ip address 10.0.0.1 255.255.255.0', 'end']) await r.executeCommand(c);

    expect(connectedNetworks(r)).toEqual(['10.0.0.0/255.255.255.0 GigabitEthernet0/0']);
  });
});

async function twoUplinkLab() {
  const exporter = new CiscoRouter('EXP');
  const impasse = new CiscoRouter('DEAD');
  const middle = new CiscoRouter('MID');
  const collector = new CiscoRouter('COL');
  new Cable('c0').connect(
    exporter.getPort('GigabitEthernet0/0')!, impasse.getPort('GigabitEthernet0/0')!);
  new Cable('c1').connect(
    exporter.getPort('GigabitEthernet0/1')!, middle.getPort('GigabitEthernet0/0')!);
  new Cable('c2').connect(
    middle.getPort('GigabitEthernet0/1')!, collector.getPort('GigabitEthernet0/0')!);

  const monter = async (r: CiscoRouter, lignes: string[]) => {
    for (const c of ['enable', 'configure terminal', ...lignes, 'end']) await r.executeCommand(c);
  };
  await monter(exporter, [
    'interface GigabitEthernet0/0', 'no shutdown', 'ip address 172.16.9.1 255.255.255.0', 'exit',
    'interface GigabitEthernet0/1', 'no shutdown', 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'ip route 10.0.1.0 255.255.255.0 10.0.0.2',
  ]);
  await monter(impasse, [
    'interface GigabitEthernet0/0', 'no shutdown', 'ip address 172.16.9.2 255.255.255.0', 'exit',
  ]);
  await monter(middle, [
    'interface GigabitEthernet0/0', 'no shutdown', 'ip address 10.0.0.2 255.255.255.0', 'exit',
    'interface GigabitEthernet0/1', 'no shutdown', 'ip address 10.0.1.1 255.255.255.0', 'exit',
  ]);
  await monter(collector, [
    'interface GigabitEthernet0/0', 'no shutdown', 'ip address 10.0.1.2 255.255.255.0', 'exit',
    'ip route 10.0.0.0 255.255.255.0 10.0.1.1',
  ]);
  return { exporter, impasse, middle, collector };
}

describe('la sortie est celle que la table designe, pas la premiere venue', () => {
  it('NetFlow exporte vers un collecteur joignable par une route statique', async () => {
    const { exporter, collector } = await twoUplinkLab();
    const recus = udpArrivals(collector, 2055);

    exporter.getNetFlowAgent().setEnabled(true);
    exporter.getNetFlowAgent().addCollector('10.0.1.2');
    exporter.getNetFlowAgent().recordFlow({
      sourceIp: '192.168.1.10', destinationIp: '8.8.8.8',
      sourcePort: 5000, destinationPort: 53, protocol: 17, bytes: 100,
    });
    exporter.getNetFlowAgent().flushAllPending();

    expect(recus.length).toBeGreaterThan(0);
  });

  it('un trap SNMP atteint un NMS joignable par une route statique', async () => {
    const { exporter, collector } = await twoUplinkLab();
    const recus = udpArrivals(collector, 162);

    exporter.getSnmpAgent().addTrapHost('10.0.1.2', 'public');
    exporter.getSnmpAgent().sendTrap('1.3.6.1.6.3.1.1.5.3');

    expect(recus.length).toBeGreaterThan(0);
  });

  it('TEMOIN — les memes exports partent aussi vers un voisin direct', async () => {
    const { exporter, middle } = await twoUplinkLab();
    const flux = udpArrivals(middle, 2055);
    const traps = udpArrivals(middle, 162);

    exporter.getNetFlowAgent().setEnabled(true);
    exporter.getNetFlowAgent().addCollector('10.0.0.2');
    exporter.getNetFlowAgent().recordFlow({
      sourceIp: '192.168.1.10', destinationIp: '8.8.8.8',
      sourcePort: 5000, destinationPort: 53, protocol: 17, bytes: 100,
    });
    exporter.getNetFlowAgent().flushAllPending();
    exporter.getSnmpAgent().addTrapHost('10.0.0.2', 'public');
    exporter.getSnmpAgent().sendTrap('1.3.6.1.6.3.1.1.5.3');

    expect(flux.length).toBeGreaterThan(0);
    expect(traps.length).toBeGreaterThan(0);
  });

  it('TEMOIN — un collecteur qu\'aucune route ne designe ne recoit rien', async () => {
    const { exporter, collector } = await twoUplinkLab();
    const recus = udpArrivals(collector, 2055);

    exporter.getNetFlowAgent().setEnabled(true);
    exporter.getNetFlowAgent().addCollector('172.31.99.9');
    exporter.getNetFlowAgent().recordFlow({
      sourceIp: '192.168.1.10', destinationIp: '8.8.8.8',
      sourcePort: 5000, destinationPort: 53, protocol: 17, bytes: 100,
    });
    exporter.getNetFlowAgent().flushAllPending();

    expect(recus).toEqual([]);
  });
});
