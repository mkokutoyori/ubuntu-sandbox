/**
 * Le commutateur de niveau 3 ignorait la zone d'options que le routeur
 * honore — meme regle, deux plans de donnees, une seule qui l'applique.
 *
 * MESURE DE DEPART, et elle porte son propre temoin. Un paquet ICMP muni
 * d'un Record Route a quatre cases traverse UN commutateur Catalyst puis
 * UN routeur, dans cet ordre. A l'arrivee :
 *
 *   route notee : [ '10.0.2.1' ]                 <- le ROUTEUR seul
 *   attendu     : [ '10.0.1.1', '10.0.2.1' ]
 *
 * L'entree de R2 n'est pas un detail : c'est ce qui prouve que la
 * maquette achemine et que l'option survit au trajet. Le commutateur,
 * lui, relaie le paquet sans y toucher. Et une source route lache visant
 * l'adresse SVI du commutateur faisait arriver ZERO paquet chez B — il
 * livrait localement au lieu de reacheminer.
 *
 * Le §6 par-dessus : `no ip source-route` se TAPE sur un Catalyst
 * (`IOS_HARDENING` vit dans `CiscoShellBase`, partage par les deux
 * interpreteurs) et se REND dans sa configuration, sans qu'aucun de ses
 * chemins de decision ne le lise. C'est le meme defaut que le lot
 * precedent a ferme sur `Router`, au deuxieme equipement.
 *
 * AUTORITE. Identique au lot du routeur, et c'est le propos : RFC 791
 * §3.1 pour les options de route, RFC 1812 §5.2.3 et §5.2.4.1 pour la
 * decision livraison-locale contre reacheminement, §5.3.13.4 pour
 * l'option de configuration qui jette, §5.3.13.5 pour le Record Route
 * (« Routers MUST support the Record Route option in forwarded
 * packets »), RFC 792 pour le code 5.
 *
 * REUTILISATION plutot que seconde ecriture. `SwitchSvi` appelle
 * `layers/internet/Ipv4Options.ts`, l'offre que le lot precedent a
 * posee ; rien de la semantique n'est recopie ici. Le seul ajout est un
 * PORT ETROIT sur `SviHost` — `acceptsSourceRouting?()` — parce que la
 * configuration de securite est attachee a l'EQUIPEMENT et que la SVI ne
 * le voit pas. C'est exactement la forme de `icmpUnreachablesEnabled`,
 * ajoutee au meme endroit pour la meme raison.
 *
 * DISCRIMINATION (`git stash push -- src/network`) : 5 des 6 cas
 * tombent. Le sixieme est le TEMOIN de la maquette et il DOIT passer des
 * deux cotes — sans lui, un laboratoire ou rien n'arrive jamais rendrait
 * les cinq autres verts sans rien demontrer.
 *
 * CE QUI N'EST PAS FAIT ICI. Le pare-feu reste en dehors, et pas par
 * oubli : `Firewall` a son propre pipeline, et lui faire honorer une
 * source route SANS donner a l'operateur de quoi la refuser le rendrait
 * PLUS permissif qu'aujourd'hui — c'est le contournement de filtre que
 * la RFC 1812 §5.3.13.4 decrit en toutes lettres. Le bouton FortiOS
 * correspondant n'est pas attestable depuis ce reseau, donc on ne
 * l'invente pas. Ecrit dans `TODO.md`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress, ETHERTYPE_IPV4, createIPv4Packet,
  verifyIPv4Checksum, IP_PROTO_ICMP,
  IP_OPTION_RECORD_ROUTE, IP_OPTION_LOOSE_SOURCE_ROUTE, IP_OPTION_STRICT_SOURCE_ROUTE,
  type EthernetFrame, type ICMPPacket, type IPv4Option, type IPv4Packet,
} from '@/network/core/types';
import {
  buildRecordRouteOption, buildSourceRouteOption, routeAddressesOf,
} from '@/network/layers/internet/Ipv4Options';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function type(d: Cmd, cmds: readonly string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

function watchIpv4(port: { receiveFrame(f: EthernetFrame): unknown }): () => IPv4Packet[] {
  const seen: IPv4Packet[] = [];
  const original = port.receiveFrame.bind(port);
  (port as unknown as { receiveFrame: unknown }).receiveFrame = (f: EthernetFrame) => {
    if (f.etherType === ETHERTYPE_IPV4) seen.push(f.payload as IPv4Packet);
    return original(f);
  };
  return () => seen;
}

async function lab(hardening: readonly string[] = []) {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
  const r2 = new CiscoRouter('R2');
  const a = new LinuxPC('linux-pc', 'A', -200, 0);
  const b = new LinuxPC('linux-pc', 'B', 200, 0);

  new Cable('a-sw').connect(a.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('sw-r2').connect(sw.getPort('FastEthernet0/2')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('r2-b').connect(r2.getPort('GigabitEthernet0/1')!, b.getPort('eth0')!);

  await type(sw, ['enable', 'configure terminal', 'ip routing', ...hardening,
    'vlan 10', 'exit', 'vlan 20', 'exit',
    'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 10', 'exit',
    'interface FastEthernet0/2', 'switchport mode access', 'switchport access vlan 20', 'exit',
    'interface Vlan10', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'interface Vlan20', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 10.0.2.0 255.255.255.0 10.0.1.2', 'end']);
  await type(r2, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.1.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 10.0.0.0 255.255.255.0 10.0.1.1', 'end']);
  await type(a, ['ip link set eth0 up', 'ip addr add 10.0.0.10/24 dev eth0',
    'ip route add default via 10.0.0.1']);
  await type(b, ['ip link set eth0 up', 'ip addr add 10.0.2.10/24 dev eth0',
    'ip route add default via 10.0.2.1']);

  await a.executeCommand('ping -c 1 10.0.2.10');
  return { sw, r2, a, b };
}

const ECHO: ICMPPacket = {
  type: 'icmp', icmpType: 'echo-request', code: 0, id: 7, sequence: 1, dataSize: 8,
};

function inject(sw: CiscoSwitch, a: LinuxPC, destination: string, ipOptions: IPv4Option[]): void {
  const packet = createIPv4Packet(
    new IPAddress('10.0.0.10'), new IPAddress(destination),
    IP_PROTO_ICMP, 64, ECHO, 16, { ipOptions });
  sw.getPort('FastEthernet0/1')!.receiveFrame({
    srcMAC: a.getPort('eth0')!.getMAC(),
    dstMAC: sw.getPort('FastEthernet0/1')!.getMAC(),
    etherType: ETHERTYPE_IPV4,
    payload: packet,
  });
}

function optionOf(packet: IPv4Packet, optionType: number): IPv4Option | undefined {
  return packet.options?.find(o => o.type === optionType);
}

describe('a Catalyst records the route like the router beside it', () => {
  it('the lab routes a plain datagram across both hops — WITNESS', async () => {
    const { sw, a, b } = await lab();
    const atB = watchIpv4(b.getPort('eth0')!);
    inject(sw, a, '10.0.2.10', []);

    const arrived = atB();
    expect(arrived).toHaveLength(1);
    expect(arrived[0].ihl).toBe(5);
    expect(verifyIPv4Checksum(arrived[0])).toBe(true);
  });

  it('both hops insert their egress address, switch first', async () => {
    const { sw, a, b } = await lab();
    const atB = watchIpv4(b.getPort('eth0')!);
    inject(sw, a, '10.0.2.10', [buildRecordRouteOption(4)]);

    const arrived = atB();
    expect(arrived).toHaveLength(1);
    const option = optionOf(arrived[0], IP_OPTION_RECORD_ROUTE)!;
    expect(routeAddressesOf(option).map(ip => ip.toString()))
      .toEqual(['10.0.1.1', '10.0.2.1']);
    expect(verifyIPv4Checksum(arrived[0])).toBe(true);
  });
});

describe('a source route decides where the Catalyst sends the datagram', () => {
  it('a loose route aimed at an SVI address is forwarded, not delivered', async () => {
    const { sw, a, b } = await lab();
    const atB = watchIpv4(b.getPort('eth0')!);
    inject(sw, a, '10.0.0.1',
      [buildSourceRouteOption([new IPAddress('10.0.2.10')], false)]);

    const arrived = atB();
    expect(arrived).toHaveLength(1);
    expect(arrived[0].destinationIP.toString()).toBe('10.0.2.10');
    const option = optionOf(arrived[0], IP_OPTION_LOOSE_SOURCE_ROUTE)!;
    expect(option.data).toEqual([8, 10, 0, 1, 1]);
  });

  it('a strict route walks the connected hop, then the router walks the next', async () => {
    const { sw, a, b } = await lab();
    const atB = watchIpv4(b.getPort('eth0')!);
    inject(sw, a, '10.0.0.1', [buildSourceRouteOption(
      [new IPAddress('10.0.1.2'), new IPAddress('10.0.2.10')], true)]);

    const arrived = atB();
    expect(arrived).toHaveLength(1);
    expect(arrived[0].destinationIP.toString()).toBe('10.0.2.10');
    const option = optionOf(arrived[0], IP_OPTION_STRICT_SOURCE_ROUTE)!;
    expect(option.data).toEqual([12, 10, 0, 1, 1, 10, 0, 2, 1]);
  });

  it('a strict hop that is not directly connected fails with unreachable code 5', async () => {
    const { sw, a, b } = await lab();
    const atB = watchIpv4(b.getPort('eth0')!);
    const atA = watchIpv4(a.getPort('eth0')!);
    inject(sw, a, '10.0.0.1',
      [buildSourceRouteOption([new IPAddress('10.0.2.10')], true)]);

    expect(atB()).toHaveLength(0);
    const errors = atA()
      .map(p => p.payload as ICMPPacket)
      .filter(i => i?.icmpType === 'destination-unreachable');
    expect(errors.map(i => i.code)).toContain(5);
  });
});

describe('`no ip source-route` decides on the Catalyst too', () => {
  it('accepted by default and dropped once the hardening is typed', async () => {
    const permissive = await lab();
    const atPermissiveB = watchIpv4(permissive.b.getPort('eth0')!);
    inject(permissive.sw, permissive.a, '10.0.0.1',
      [buildSourceRouteOption([new IPAddress('10.0.2.10')], false)]);
    expect(atPermissiveB()).toHaveLength(1);

    const hardened = await lab(['no ip source-route']);
    const atHardenedB = watchIpv4(hardened.b.getPort('eth0')!);
    inject(hardened.sw, hardened.a, '10.0.0.1',
      [buildSourceRouteOption([new IPAddress('10.0.2.10')], false)]);
    expect(atHardenedB()).toHaveLength(0);

    expect(await hardened.sw.executeCommand('show running-config'))
      .toContain('no ip source-route');
  });
});
