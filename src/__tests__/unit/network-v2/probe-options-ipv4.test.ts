/**
 * La zone d'OPTIONS de l'en-tete IPv4 — RFC 791 §3.1.
 *
 * MESURE DE DEPART. `IPv4Packet` n'avait AUCUN champ d'options. Le seul
 * endroit du depot qui en portait une l'exprimait par sa TAILLE :
 * `igmpSendRequest` posait `headerBytes: IPV4_RA_HEADER_BYTES` — la
 * constante 24 — pour dire « il y a quatre octets d'option ici » sans
 * jamais dire LESQUELS. L'en-tete annonçait donc IHL 6 alors que rien,
 * ni la somme de controle, ni la capture `tcpdump`, ne couvrait ces
 * quatre octets : `computeIPv4Checksum` sommait dix mots fixes et
 * `synthIpv4Bytes` emettait vingt octets d'en-tete. Une capture d'un
 * paquet IGMP se CONTREDISAIT elle-meme.
 *
 * Et `no ip source-route` etait la violation du §6 dans sa forme la plus
 * nue : la CLI l'ecrivait (`CiscoShellBase`), la configuration le rendait
 * (`CiscoSecurityConfig`), et AUCUN plan de donnees ne le lisait. Une
 * commande de durcissement sans le moindre effet.
 *
 * AUTORITE. RFC 791 §3.1 pour les trois options de route et la regle de
 * recopie en fragmentation (« Must be copied on fragmentation » pour
 * LSRR/SSRR, « Not copied on fragmentation, goes in first fragment
 * only » pour Record Route) ; RFC 1812 §5.2.3 et §5.2.4.1 pour la
 * decision livraison-locale contre reacheminement (« If the packet
 * contains an unexpired source route option [...] the packet is
 * forwarded (and not delivered locally) regardless of the rules
 * below ») ; RFC 1812 §5.3.13.4 pour l'option de configuration qui jette
 * les paquets source-routes et qui « MUST NOT be enabled by default » —
 * ce que le defaut `ipSourceRoute = true` respecte deja ; RFC 1812
 * §5.2.7.2 pour l'interdiction du Redirect sur un paquet source-route
 * (« The packet does not contain an IP source route option ») ; RFC 2113
 * pour le Router Alert (type 148, longueur 4, valeur 0) ; RFC 792 pour
 * le code 5, « source route failed ».
 *
 * DISCRIMINATION (`git stash` du lot) : 13 des 15 cas tombent. Les DEUX
 * qui passent des deux cotes sont nommes, et ils le doivent :
 *
 *   - « the lab routes a plain datagram » est le TEMOIN de la maquette.
 *     Sans lui, une maquette ou RIEN n'arrive jamais rendrait tous les
 *     refus verts et ne prouverait rien du tout.
 *   - « IGMP keeps its 24-byte header » est le TEMOIN DE NON-REGRESSION
 *     de l'unique fait que l'ancien code disait deja : IHL 6. Il passe
 *     par `buildIpv4Packet`, la traduction de production, et NON par une
 *     lecture directe du champ neuf : avant, la requete portait
 *     `headerBytes: 24` ; apres, elle porte l'option, qui fait six mots.
 *     Une premiere ecriture de ce temoin lisait `request.ipOptions`,
 *     c'est-a-dire precisement ce que le lot ajoute — elle ne pouvait
 *     pas passer du cote parent, et ne temoignait donc de rien.
 *
 * Le montage du cas « route complete » est arbitraire et il le dit : une
 * source route epuisee ne peut pas naitre dans une maquette a un seul
 * saut, donc elle est ecrite a la main. Son saut enregistre nomme A,
 * l'emetteur, et non R1 : depuis que la reponse d'echo INVERSE la route
 * (`probe-reponse-echo-renvoie-la-route.test.ts`), une route nommant R1
 * ferait repartir la reponse vers R1 lui-meme, et le cas mesurerait le
 * routage de la reponse au lieu du durcissement, qui est son sujet.
 *
 * `no ip source-route` JETTE des l'entree et non au seul reacheminement,
 * parce que Cisco le decrit sur « any IP datagram containing a
 * source-route option » : une route COMPLETE visant le routeur lui-meme
 * tombe donc elle aussi, et c'est la moitie la plus sensible puisque
 * c'est celle qui atteint le plan de controle. Deux cas le mesurent, et
 * chacun compare les DEUX etats sur la meme maquette — sans la moitie
 * permissive, un laboratoire ou rien n'arrive jamais rendrait le refus
 * vert.
 *
 * L'ORDRE compte et un cas l'epingle. `dispatchControlPlaneIpv4` traite
 * IGMP SANS exiger une destination multicast : un datagramme IGMP
 * adresse a l'adresse unicast du routeur etait donc MANGE par le plan de
 * controle avant toute decision de routage. La RFC 1812 §5.2.3 tranche
 * dans l'autre sens — « the packet is forwarded (and not delivered
 * locally) regardless of the rules below » —, donc la lecture de la
 * source route passe AVANT le plan de controle. C'est le seul protocole
 * de ce crochet qu'une source route puisse atteindre : PIM et VRRP sont
 * multicast, et le plan de donnees GRE de Cisco est une limite connue.
 *
 * CE QUI N'EST PAS FAIT ICI. L'option Timestamp (type 68) n'est ni
 * construite ni horodatee : l'horloge de ce simulateur rend 0 ms en
 * temps virtuel, donc un horodatage serait une valeur decorative. Le
 * dialogue du `ping` etendu continue de COLLECTER `Loose, Strict,
 * Record, Timestamp, Verbose` sans les construire — le rendu IOS de
 * « Record route: » n'est pas attestable depuis ce reseau. Les deux sont
 * ecrits dans `TODO.md`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress, ETHERTYPE_IPV4,
  createIPv4Packet, encodeIPv4Options, decodeIPv4Options, ipv4HeaderBytesFor,
  routerAlertOption, verifyIPv4Checksum,
  IP_PROTO_ICMP, IP_OPTION_RECORD_ROUTE, IP_OPTION_ROUTER_ALERT,
  IP_OPTION_LOOSE_SOURCE_ROUTE, IP_OPTION_STRICT_SOURCE_ROUTE,
  type EthernetFrame, type ICMPPacket, type IPv4Option, type IPv4Packet,
} from '@/network/core/types';
import {
  buildRecordRouteOption, buildSourceRouteOption, routeAddressesOf,
} from '@/network/layers/internet/Ipv4Options';
import { buildIpv4Packet } from '@/network/layers/internet/Ipv4Egress';
import { fragmentIPv4 } from '@/network/core/Ipv4Fragmentation';
import { igmpQuery, igmpSendRequest } from '@/network/igmp/frames';
import { IP_PROTO_IGMP } from '@/network/igmp/types';
import { decodeEthernetFrame } from '@/network/devices/linux/network/tcpdump/CaptureFrame';
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
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const a = new LinuxPC('linux-pc', 'A', -200, 0);
  const b = new LinuxPC('linux-pc', 'B', 200, 0);

  new Cable('a-r1').connect(a.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('r1-r2').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('r2-b').connect(r2.getPort('GigabitEthernet0/1')!, b.getPort('eth0')!);

  await type(r1, ['enable', 'configure terminal', ...hardening,
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
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
  return { r1, r2, a, b };
}

const ECHO: ICMPPacket = {
  type: 'icmp', icmpType: 'echo-request', code: 0, id: 7, sequence: 1, dataSize: 8,
};

function inject(
  r1: CiscoRouter, a: LinuxPC, destination: string, ipOptions: IPv4Option[],
  carried: { protocol: number; payload: unknown; payloadBytes: number }
    = { protocol: IP_PROTO_ICMP, payload: ECHO, payloadBytes: 16 },
): void {
  const packet = createIPv4Packet(
    new IPAddress('10.0.0.10'), new IPAddress(destination),
    carried.protocol, 64, carried.payload, carried.payloadBytes, { ipOptions });
  r1.getPort('GigabitEthernet0/0')!.receiveFrame({
    srcMAC: a.getPort('eth0')!.getMAC(),
    dstMAC: r1.getPort('GigabitEthernet0/0')!.getMAC(),
    etherType: ETHERTYPE_IPV4,
    payload: packet,
  });
}

function optionOf(packet: IPv4Packet, optionType: number): IPv4Option | undefined {
  return packet.options?.find(o => o.type === optionType);
}

describe('the option area exists on the wire', () => {
  it('the lab routes a plain datagram — WITNESS', async () => {
    const { r1, a, b } = await lab();
    const atB = watchIpv4(b.getPort('eth0')!);
    inject(r1, a, '10.0.2.10', []);

    const arrived = atB();
    expect(arrived).toHaveLength(1);
    expect(arrived[0].ihl).toBe(5);
    expect(arrived[0].options).toBeUndefined();
    expect(verifyIPv4Checksum(arrived[0])).toBe(true);
  });

  it('encodes an option area padded to a 32-bit boundary and derives IHL', () => {
    const option = { type: IP_OPTION_RECORD_ROUTE, data: [4, 0, 0, 0, 0] };
    expect(encodeIPv4Options([option])).toEqual([7, 7, 4, 0, 0, 0, 0, 0]);
    expect(ipv4HeaderBytesFor([option])).toBe(28);
    expect(decodeIPv4Options(encodeIPv4Options([option]))).toEqual([option]);

    const packet = createIPv4Packet(
      new IPAddress('10.0.0.10'), new IPAddress('10.0.2.10'),
      IP_PROTO_ICMP, 64, ECHO, 16, { ipOptions: [option] });
    expect(packet.ihl).toBe(7);
    expect(packet.totalLength).toBe(28 + 16);
    expect(verifyIPv4Checksum(packet)).toBe(true);
  });

  it('the header checksum covers the option area', () => {
    const packet = createIPv4Packet(
      new IPAddress('10.0.0.10'), new IPAddress('10.0.2.10'),
      IP_PROTO_ICMP, 64, ECHO, 16, { ipOptions: [buildRecordRouteOption(2)] });
    expect(verifyIPv4Checksum(packet)).toBe(true);

    const tampered: IPv4Packet = {
      ...packet,
      options: [{ type: IP_OPTION_RECORD_ROUTE, data: [8, 10, 0, 1, 1, 0, 0, 0, 0] }],
    };
    expect(verifyIPv4Checksum(tampered)).toBe(false);
  });

  it('a capture emits exactly the option octets the header announces', () => {
    const packet = createIPv4Packet(
      new IPAddress('10.0.0.10'), new IPAddress('224.0.0.1'),
      2, 1, { type: 'igmp' }, 8, { ipOptions: [routerAlertOption()] });
    const frame: EthernetFrame = {
      srcMAC: new MACAddress('00:11:22:33:44:55'),
      dstMAC: new MACAddress('01:00:5e:00:00:01'),
      etherType: ETHERTYPE_IPV4,
      payload: packet,
    };
    const capture = decodeEthernetFrame(frame, 'eth0', 'out', new Date(0));
    const ip = capture.raw.slice(capture.rawLinkOffset);

    expect(ip[0]).toBe(0x46);
    expect(ip.slice(20, 24)).toEqual([0x94, 0x04, 0x00, 0x00]);
    expect(decodeIPv4Options(ip.slice(20, packet.ihl * 4)))
      .toEqual([{ type: IP_OPTION_ROUTER_ALERT, data: [0, 0] }]);
  });
});

function generalQueryRequest() {
  return igmpSendRequest(
    'GigabitEthernet0/0', new IPAddress('10.0.0.1'), new IPAddress('224.0.0.1'),
    igmpQuery('0.0.0.0', 100));
}

describe('IGMP carries the option itself, not a count of its octets', () => {
  it('IGMP keeps its 24-byte header — NON-REGRESSION WITNESS', () => {
    const request = generalQueryRequest();
    const packet = buildIpv4Packet(new IPAddress('10.0.0.1'), request);
    expect(packet.ihl).toBe(6);
    expect(packet.totalLength).toBe(24 + 8);
  });

  it('the option is Router Alert, type 148 length 4 value 0', () => {
    const request = generalQueryRequest();
    expect(request.ipOptions).toEqual([{ type: IP_OPTION_ROUTER_ALERT, data: [0, 0] }]);
    expect(encodeIPv4Options(request.ipOptions)).toEqual([0x94, 0x04, 0x00, 0x00]);
  });
});

describe('Record Route is filled by every hop that forwards', () => {
  it('each router inserts the address of the interface it sends on', async () => {
    const { r1, a, b } = await lab();
    const atB = watchIpv4(b.getPort('eth0')!);
    inject(r1, a, '10.0.2.10', [buildRecordRouteOption(4)]);

    const arrived = atB();
    expect(arrived).toHaveLength(1);
    const option = optionOf(arrived[0], IP_OPTION_RECORD_ROUTE)!;
    expect(routeAddressesOf(option).map(ip => ip.toString()))
      .toEqual(['10.0.1.1', '10.0.2.1']);
    expect(verifyIPv4Checksum(arrived[0])).toBe(true);
  });

  it('a full route data area is forwarded without inserting', async () => {
    const { r1, a, b } = await lab();
    const atB = watchIpv4(b.getPort('eth0')!);
    inject(r1, a, '10.0.2.10', [buildRecordRouteOption(1)]);

    const arrived = atB();
    expect(arrived).toHaveLength(1);
    const option = optionOf(arrived[0], IP_OPTION_RECORD_ROUTE)!;
    expect(routeAddressesOf(option).map(ip => ip.toString())).toEqual(['10.0.1.1']);
  });
});

describe('a source route decides where the datagram goes', () => {
  it('a loose source route addressed to the router is forwarded, not delivered', async () => {
    const { r1, a, b } = await lab();
    const atB = watchIpv4(b.getPort('eth0')!);
    inject(r1, a, '10.0.0.1',
      [buildSourceRouteOption([new IPAddress('10.0.2.10')], false)]);

    const arrived = atB();
    expect(arrived).toHaveLength(1);
    expect(arrived[0].destinationIP.toString()).toBe('10.0.2.10');
    const option = optionOf(arrived[0], IP_OPTION_LOOSE_SOURCE_ROUTE)!;
    expect(option.data).toEqual([8, 10, 0, 1, 1]);
    expect(verifyIPv4Checksum(arrived[0])).toBe(true);
  });

  it('a strict source route walks hop by hop through connected networks', async () => {
    const { r1, a, b } = await lab();
    const atB = watchIpv4(b.getPort('eth0')!);
    inject(r1, a, '10.0.0.1', [buildSourceRouteOption(
      [new IPAddress('10.0.1.2'), new IPAddress('10.0.2.10')], true)]);

    const arrived = atB();
    expect(arrived).toHaveLength(1);
    expect(arrived[0].destinationIP.toString()).toBe('10.0.2.10');
    const option = optionOf(arrived[0], IP_OPTION_STRICT_SOURCE_ROUTE)!;
    expect(option.data).toEqual([12, 10, 0, 1, 1, 10, 0, 2, 1]);
  });

  it('an unexpired source route outranks the control plane that would eat it', async () => {
    const { r1, a, b } = await lab();
    const atB = watchIpv4(b.getPort('eth0')!);
    inject(r1, a, '10.0.0.1',
      [buildSourceRouteOption([new IPAddress('10.0.2.10')], false)],
      { protocol: IP_PROTO_IGMP, payload: igmpQuery('0.0.0.0', 100), payloadBytes: 8 });

    const arrived = atB();
    expect(arrived).toHaveLength(1);
    expect(arrived[0].protocol).toBe(IP_PROTO_IGMP);
    expect(arrived[0].destinationIP.toString()).toBe('10.0.2.10');
  });

  it('a strict hop that is not directly connected fails with unreachable code 5', async () => {
    const { r1, a, b } = await lab();
    const atB = watchIpv4(b.getPort('eth0')!);
    const atA = watchIpv4(a.getPort('eth0')!);
    inject(r1, a, '10.0.0.1',
      [buildSourceRouteOption([new IPAddress('10.0.2.10')], true)]);

    expect(atB()).toHaveLength(0);
    const errors = atA()
      .map(p => p.payload as ICMPPacket)
      .filter(i => i?.icmpType === 'destination-unreachable');
    expect(errors.map(i => i.code)).toContain(5);
  });
});

describe('`no ip source-route` decides, instead of only being rendered', () => {
  it('accepted by default and dropped once the hardening is typed', async () => {
    const permissive = await lab();
    const atPermissiveB = watchIpv4(permissive.b.getPort('eth0')!);
    inject(permissive.r1, permissive.a, '10.0.0.1',
      [buildSourceRouteOption([new IPAddress('10.0.2.10')], false)]);
    expect(atPermissiveB()).toHaveLength(1);

    const hardened = await lab(['no ip source-route']);
    const atHardenedB = watchIpv4(hardened.b.getPort('eth0')!);
    inject(hardened.r1, hardened.a, '10.0.0.1',
      [buildSourceRouteOption([new IPAddress('10.0.2.10')], false)]);
    expect(atHardenedB()).toHaveLength(0);

    expect(await hardened.r1.executeCommand('show running-config'))
      .toContain('no ip source-route');
  });

  it('a completed route aimed at the router itself is dropped too, not delivered', async () => {
    const exhausted: IPv4Option = { type: IP_OPTION_LOOSE_SOURCE_ROUTE, data: [8, 10, 0, 0, 10] };

    const permissive = await lab();
    const toPermissiveA = watchIpv4(permissive.a.getPort('eth0')!);
    const beforePermissive = toPermissiveA().length;
    inject(permissive.r1, permissive.a, '10.0.0.1', [exhausted]);
    expect(toPermissiveA().length).toBeGreaterThan(beforePermissive);

    const hardened = await lab(['no ip source-route']);
    const toHardenedA = watchIpv4(hardened.a.getPort('eth0')!);
    const beforeHardened = toHardenedA().length;
    inject(hardened.r1, hardened.a, '10.0.0.1', [exhausted]);
    expect(toHardenedA().length).toBe(beforeHardened);
  });
});

describe('fragmentation copies the options the copied flag marks', () => {
  it('Record Route goes in the first fragment only, a source route in all', () => {
    const options = [
      buildSourceRouteOption([new IPAddress('10.0.2.10')], false),
      buildRecordRouteOption(2),
    ];
    const packet = createIPv4Packet(
      new IPAddress('10.0.0.10'), new IPAddress('10.0.2.10'),
      IP_PROTO_ICMP, 64, ECHO, 600, { ipOptions: options });

    const fragments = fragmentIPv4(packet, 400);
    expect(fragments.length).toBeGreaterThan(1);

    expect(fragments[0].options?.map(o => o.type))
      .toEqual([IP_OPTION_LOOSE_SOURCE_ROUTE, IP_OPTION_RECORD_ROUTE]);
    for (const frag of fragments.slice(1)) {
      expect(frag.options?.map(o => o.type)).toEqual([IP_OPTION_LOOSE_SOURCE_ROUTE]);
      expect(frag.ihl * 4).toBe(ipv4HeaderBytesFor(frag.options));
      expect(verifyIPv4Checksum(frag)).toBe(true);
    }
  });
});
