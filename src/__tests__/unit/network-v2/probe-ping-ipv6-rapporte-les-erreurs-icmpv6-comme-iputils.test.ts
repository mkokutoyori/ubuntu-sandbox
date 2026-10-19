/**
 * `ping -6` rapporte les erreurs ICMPv6 qu'il recoit, et sa phrase est celle d'iputils -- « From <routeur> icmp_seq=N Time exceeded:
 * Hop limit », « Packet too big: mtu=1280 », « Destination unreachable: No route » -- au lieu de les perdre ou de les dire en IPv4.
 *
 * Mesure de depart (a2b56649, un LinuxPC derriere un routeur Cisco dont la jambe de B porte `ipv6 mtu 1280`) :
 *     ping -6 -c 1 -t 1 2001:db8:2::2    ->  (rien) puis « 1 packets transmitted, 0 received, 100% packet loss » : l'erreur n'existe pas
 *     ping -6 -c 2 -s 1400 2001:db8:2::2 ->  la premiere sonde disparait sans un mot, la seconde repond : « 2 packets transmitted, 1 received »
 *     ping -6 -c 1 2001:db8:3::9         ->  « From 2001 icmp_seq=1 Destination Host Unreachable » (la phrase de l'IPv4, et l'adresse
 *                                            coupee a « 2001 » par une expression reguliere ecrite pour les adresses IPv4)
 *     ping -6 -c 1 -W 1 2001:db8:1::99   ->  (rien) : le voisin n'existe pas, le noyau dirait « Address unreachable »
 * Et, sur le fil, un Packet Too Big emis par le routeur portait l'adresse de la jambe de SORTIE (2001:db8:2::1) au lieu de celle
 * de la jambe qui fait face a l'emetteur (2001:db8:1::1) : IPv6DataPlane.forwardPacket passait route.iface a sendICMPv6Error.
 *
 * Autorites : iputils 20221126, ping/ping6_common.c `print_icmp` pour toutes les phrases (Destination unreachable: No route /
 * Administratively prohibited / Beyond scope of source address / Address unreachable / Port unreachable / Unknown code %d ; Packet
 * too big: mtu=%u[, code=%d] ; Time exceeded: Hop limit / Defragmentation failure / code %d ; Parameter problem: Wrong header field /
 * Unknown header / Unknown option / code %d at %u) et `ping6_receive_error_msg` pour « From %s icmp_seq=%u » + phrase ; les erreurs
 * recues comptent dans « +N errors ». RFC 4443 §2.2 : la source d'une erreur est une adresse de l'interface par laquelle elle
 * repart vers l'emetteur.
 *
 * Non modelise ici : « Administratively prohibited » depuis un filtre de routeur (aucun ICMPv6 de ce code n'est emis par les ACL
 * IPv6 du depot ; la phrase est couverte au niveau de la fonction de rendu).
 *
 * Discrimination : 25 des 28 cas tombent contre a2b56649 (les cinq fichiers de la machine remis a leur etat, la sonde conservee).
 * Passent des deux cotes les trois TEMOINS : une reponse qui traverse le routeur reste une reponse (limite decrementee), une sonde
 * a laquelle personne ne repond est une perte et non une erreur, un voisin qui repond n'est pas une erreur. Mutation (14 mutants
 * sur les lignes ajoutees) : 12 tombent d'emblee ; les deux survivants (une disjonction qui compterait les delais comme des erreurs,
 * un pointeur de Parameter Problem perdu) ont recu leur cas, et tombent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPv6Address, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { icmp6ErrorText } from '@/network/devices/linux/LinuxFormatHelpers';
import { icmp6ReportOf } from '@/network/core/IcmpErrors';
import type { ICMPv6Packet } from '@/network/core/types';
import { pingOnSimulatedClock } from '../../support/fastPing';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function routedLab() {
  const a = new LinuxPC('A', 0, 0);
  const b = new LinuxPC('B', 0, 0);
  const r = new CiscoRouter('R1');
  r.powerOn();
  new Cable('c1').connect(a.getPort('eth0')!, r.getPort('GigabitEthernet0/0')!);
  new Cable('c2').connect(b.getPort('eth0')!, r.getPort('GigabitEthernet0/1')!);
  for (const line of [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:1::1/64', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ipv6 address 2001:db8:2::1/64', 'ipv6 mtu 1280', 'no shutdown', 'end',
  ]) await r.executeCommand(line);
  a.configureIPv6Interface('eth0', new IPv6Address('2001:db8:1::2'), 64);
  b.configureIPv6Interface('eth0', new IPv6Address('2001:db8:2::2'), 64);
  await a.executeCommand('sudo ip -6 route add default via 2001:db8:1::1');
  await b.executeCommand('sudo ip -6 route add default via 2001:db8:2::1');
  return { a, b, r };
}

function pair() {
  const a = new LinuxPC('A', 0, 0);
  const b = new LinuxPC('B', 0, 0);
  new Cable('c').connect(a.getPort('eth0')!, b.getPort('eth0')!);
  a.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);
  b.configureIPv6Interface('eth0', new IPv6Address('2001:db8::2'), 64);
  return { a, b };
}

describe('the errors a router sends back reach the screen in the words of iputils', () => {
  it('a hop limit of 1 expires at the router: « Time exceeded: Hop limit », counted as an error', async () => {
    const { a } = await routedLab();
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 1 -t 1 2001:db8:2::2');
    expect(out).toContain('From 2001:db8:1::1 icmp_seq=1 Time exceeded: Hop limit');
    expect(out).toContain('1 packets transmitted, 0 received, +1 errors, 100% packet loss');
  });

  it('a packet too big for the far link is reported, then the next probe goes through in fragments', async () => {
    const { a } = await routedLab();
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 2 -s 1400 2001:db8:2::2');
    const lines = out.split('\n');
    expect(lines).toContain('From 2001:db8:1::1 icmp_seq=1 Packet too big: mtu=1280');
    expect(lines.some((line) => line.startsWith('1408 bytes from 2001:db8:2::2: icmp_seq=2 '))).toBe(true);
    expect(out).toContain('2 packets transmitted, 1 received, +1 errors, 50% packet loss');
  });

  it('a destination without a route comes back as « Destination unreachable: No route », from the router, not as an IPv4 sentence', async () => {
    const { a } = await routedLab();
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 1 2001:db8:3::9');
    expect(out).toContain('From 2001:db8:1::1 icmp_seq=1 Destination unreachable: No route');
    expect(out).not.toContain('Destination Host Unreachable');
    expect(out).not.toContain('From 2001 ');
    expect(out).toContain('+1 errors');
  });

  it('-D stamps the error line like it stamps a reply', async () => {
    const { a } = await routedLab();
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 1 -t 1 -D 2001:db8:2::2');
    expect(out).toMatch(/\n\[\d+\.\d{6}\] From 2001:db8:1::1 icmp_seq=1 Time exceeded: Hop limit\n/);
  });

  it('TEMOIN : a reply that crosses the router is still a reply, with the hop limit decremented', async () => {
    const { a } = await routedLab();
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 1 2001:db8:2::2');
    expect(out).toMatch(/64 bytes from 2001:db8:2::2: icmp_seq=1 ttl=63 time=/);
    expect(out).not.toContain('errors');
  });
});

describe('the Packet Too Big of a router names the interface that faces the sender', () => {
  it('on the wire, the source of the Packet Too Big is the address of the router on the link of the sender', async () => {
    const { a } = await routedLab();
    const seen: Array<{ source: string; mtu: number | undefined }> = [];
    a.attachCapture(({ frame }) => {
      const packet = frame.payload as { type?: string; sourceIP?: IPv6Address; payload?: { type?: string; icmpType?: string; mtu?: number } };
      if (packet?.type !== 'ipv6' || packet.payload?.type !== 'icmpv6' || packet.payload.icmpType !== 'packet-too-big') return;
      seen.push({ source: String(packet.sourceIP), mtu: packet.payload.mtu });
    });
    await pingOnSimulatedClock(a, 'ping -6 -c 1 -s 1400 2001:db8:2::2');
    expect(seen).toEqual([{ source: '2001:db8:1::1', mtu: 1280 }]);
  });
});

describe('an on-link neighbour that never answers is « Address unreachable », from our own address', () => {
  it('every probe reports it and is counted', async () => {
    const { a } = pair();
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 2 -W 1 2001:db8::99');
    expect(out).toContain('From 2001:db8::1 icmp_seq=1 Destination unreachable: Address unreachable');
    expect(out).toContain('From 2001:db8::1 icmp_seq=2 Destination unreachable: Address unreachable');
    expect(out).toContain('2 packets transmitted, 0 received, +2 errors, 100% packet loss');
  });

  it('TEMOIN : a probe nobody answers is a loss and not an error', async () => {
    const { a, b } = pair();
    await b.executeCommand('sudo ip6tables -A INPUT -p icmpv6 --icmpv6-type echo-request -j DROP');
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 1 -W 1 2001:db8::2');
    expect(out).toContain('1 packets transmitted, 0 received, 100% packet loss');
    expect(out).not.toContain('errors');
    expect(out).not.toContain('From ');
  });

  it('TEMOIN : a neighbour that answers is not an error', async () => {
    const { a } = pair();
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 1 2001:db8::2');
    expect(out).toContain('1 packets transmitted, 1 received, 0% packet loss');
    expect(out).not.toContain('Destination unreachable');
  });
});

describe('every sentence of print_icmp', () => {
  it.each([
    [{ from: 'x', type: 'destination-unreachable', code: 0 }, 'Destination unreachable: No route'],
    [{ from: 'x', type: 'destination-unreachable', code: 1 }, 'Destination unreachable: Administratively prohibited'],
    [{ from: 'x', type: 'destination-unreachable', code: 2 }, 'Destination unreachable: Beyond scope of source address'],
    [{ from: 'x', type: 'destination-unreachable', code: 3 }, 'Destination unreachable: Address unreachable'],
    [{ from: 'x', type: 'destination-unreachable', code: 4 }, 'Destination unreachable: Port unreachable'],
    [{ from: 'x', type: 'destination-unreachable', code: 5 }, 'Destination unreachable: Unknown code 5'],
    [{ from: 'x', type: 'packet-too-big', code: 0, mtu: 1280 }, 'Packet too big: mtu=1280'],
    [{ from: 'x', type: 'packet-too-big', code: 3, mtu: 1280 }, 'Packet too big: mtu=1280, code=3'],
    [{ from: 'x', type: 'time-exceeded', code: 0 }, 'Time exceeded: Hop limit'],
    [{ from: 'x', type: 'time-exceeded', code: 1 }, 'Time exceeded: Defragmentation failure'],
    [{ from: 'x', type: 'time-exceeded', code: 7 }, 'Time exceeded: code 7'],
    [{ from: 'x', type: 'parameter-problem', code: 0, pointer: 40 }, 'Parameter problem: Wrong header field at 40'],
    [{ from: 'x', type: 'parameter-problem', code: 1, pointer: 6 }, 'Parameter problem: Unknown header at 6'],
    [{ from: 'x', type: 'parameter-problem', code: 2, pointer: 42 }, 'Parameter problem: Unknown option at 42'],
    [{ from: 'x', type: 'parameter-problem', code: 9, pointer: 1 }, 'Parameter problem: code 9 at 1'],
  ] as const)('%j reads « %s »', (report, sentence) => {
    expect(icmp6ErrorText(report)).toBe(sentence);
  });
});

describe('the report that an ICMPv6 error carries', () => {
  const error = (fields: Partial<ICMPv6Packet>): ICMPv6Packet =>
    ({ type: 'icmpv6', icmpType: 'destination-unreachable', code: 0, ...fields }) as ICMPv6Packet;

  it('keeps the type, the code and the sender, and nothing it was not given', () => {
    expect(icmp6ReportOf(error({ code: 3 }), '2001:db8::1'))
      .toStrictEqual({ from: '2001:db8::1', type: 'destination-unreachable', code: 3 });
  });

  it('keeps the MTU of a Packet Too Big', () => {
    expect(icmp6ReportOf(error({ icmpType: 'packet-too-big', mtu: 1280 }), 'r'))
      .toStrictEqual({ from: 'r', type: 'packet-too-big', code: 0, mtu: 1280 });
  });

  it('keeps the pointer of a Parameter Problem', () => {
    expect(icmp6ReportOf(error({ icmpType: 'parameter-problem', code: 1, pointer: 40 }), 'r'))
      .toStrictEqual({ from: 'r', type: 'parameter-problem', code: 1, pointer: 40 });
  });

  it('is not a report when the message is not an error', () => {
    expect(icmp6ReportOf(error({ icmpType: 'echo-reply' }), 'r')).toBeNull();
    expect(icmp6ReportOf(error({ icmpType: 'neighbor-advertisement' }), 'r')).toBeNull();
  });
});
