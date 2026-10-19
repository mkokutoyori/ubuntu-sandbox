/**
 * `ping -6` envoie ce qu'on lui demande -- la taille (-s), la limite de sauts (-t), la classe de trafic (-Q) et l'etiquette de flux
 * (-F) arrivent dans l'en-tete qui part sur le fil, et la reponse de Linux reflete la classe de trafic comme le noyau le fait.
 *
 * Mesure de depart (de65db38, deux LinuxPC sur un lien) :
 *     ping -6 -c 1 -s 1400 2001:db8::2   ->  « 1408 bytes from ... », mais la requete part avec 56 octets de donnees
 *     ping -6 -c 1 -s 0    2001:db8::2   ->  « 8 bytes from ... », la requete ET la reponse portent 56 octets (`|| 56`)
 *     ping -6 -c 1 -t 5    2001:db8::2   ->  la requete part avec une limite de 64
 *     ping -6 -c 1 -Q 0x28 2001:db8::2   ->  « ping: option -Q: this simulator cannot build a TOS byte on ICMP echo »
 *     ping -6 -c 1 -F 12345 2001:db8::2  ->  « ping: option -F: this simulator cannot build an IPv6 flow label »
 *     ping -6 -c 3 ...                   ->  trois identifiants differents (un compteur par sonde)
 *     ping -c 1 -Q 0x10 10.0.0.2         ->  meme refus qu'en IPv6, alors que l'octet TOS existe dans l'en-tete IPv4
 * Le defaut est de la pire espece : l'option est ACCEPTEE (-s, -t) et l'affichage la rend, mais le paquet ne la porte pas. Un
 * apprenant qui capture avec tcpdump voit un paquet de 64 octets sous un `ping -s 1400`.
 *
 * Autorites : le code de iputils 20221126 (ping/ping.c, ping/ping6_common.c ; identique a 20211215 sur ces points, differences
 * verifiees par diff : seuls -e, -C et les messages de creation de socket changent). `parsetos` : decimal ou 0x..., « bad TOS
 * value: %s », « the decimal value of TOS bits must be in range 0-255: %d » ; `parseflow` : « bad value for flowinfo: %s », « flow
 * value is greater than 20 bits: %s » ; l'en-tete `PING %s(%s) ` suivi de `, flow 0x%05x, ` quand une etiquette est donnee ; `-Q`
 * vaut IP_TOS en IPv4 et IPV6_TCLASS en IPv6 ; `-t` vaut IPV6_UNICAST_HOPS ; l'identifiant est celui du socket, constant pour la
 * duree du processus. Le noyau Linux (net/ipv4/icmp.c `icmp_reply` : `inet->tos = ip_hdr(skb)->tos` ; net/ipv6/icmp.c
 * `icmpv6_echo_reply` : `tclass = ipv6_get_dsfield(ipv6_hdr(skb))`) reflete l'octet TOS / la classe de trafic dans la reponse
 * d'echo ; l'etiquette de flux n'est reflechie que si le sysctl flowlabel_reflect le demande (defaut : non). Ce que Windows
 * reflete n'est pas atteste : la reflexion est un point d'extension (echoReplyTrafficClass, echoReplyTos) que seul Linux surcharge.
 *
 * Non fait ici, dit comme tel : les etiquettes de flux AUTOMATIQUES du noyau (sysctl auto_flowlabels, active par defaut) -- aucune
 * machine de ce depot n'en genere pour ses paquets ; `-F 0` (le noyau tire une etiquette au hasard) n'est pas modelise.
 *
 * Discrimination : 16 des 18 cas tombent contre de65db38 (les huit fichiers de la machine remis a leur etat, la sonde conservee).
 * Passent des deux cotes les deux TEMOINS : « un ping IPv6 sans option part comme avant » (56 octets, limite 64, classe et etiquette
 * a 0 : non-regression) et « un ping IPv4 sans -Q part avec un octet TOS a 0 » (non-regression du chemin que -Q vient d'ouvrir).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, IPv6Address, MACAddress, SubnetMask, resetCounters } from '@/network/core/types';
import type { ICMPPacket, ICMPv6Packet, IPv4Packet, IPv6Packet } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../support/fastPing';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Seen6 { readonly packet: IPv6Packet; readonly icmp: ICMPv6Packet }
interface Seen4 { readonly packet: IPv4Packet; readonly icmp: ICMPPacket }

function lab() {
  const a = new LinuxPC('A', 0, 0);
  const b = new LinuxPC('B', 0, 0);
  new Cable('c').connect(a.getPort('eth0')!, b.getPort('eth0')!);
  a.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);
  b.configureIPv6Interface('eth0', new IPv6Address('2001:db8::2'), 64);
  a.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  b.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  const requests6: Seen6[] = [];
  const replies6: Seen6[] = [];
  const requests4: Seen4[] = [];
  const replies4: Seen4[] = [];
  a.attachCapture(({ frame }) => {
    const packet = frame.payload as IPv6Packet | IPv4Packet | undefined;
    if (packet?.type === 'ipv6') {
      const icmp = packet.payload as ICMPv6Packet | undefined;
      if (icmp?.type !== 'icmpv6') return;
      if (icmp.icmpType === 'echo-request') requests6.push({ packet, icmp });
      if (icmp.icmpType === 'echo-reply') replies6.push({ packet, icmp });
    } else if (packet?.type === 'ipv4') {
      const icmp = packet.payload as ICMPPacket | undefined;
      if (icmp?.type !== 'icmp') return;
      if (icmp.icmpType === 'echo-request') requests4.push({ packet, icmp });
      if (icmp.icmpType === 'echo-reply') replies4.push({ packet, icmp });
    }
  });
  return { a, b, requests6, replies6, requests4, replies4 };
}

describe('the request that leaves carries the size, the hop limit, the class and the label that were asked', () => {
  it('-s 1400 puts 1400 data bytes in the request and in the reply, as the header of the packet says', async () => {
    const { a, requests6, replies6 } = lab();
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 1 -s 1400 2001:db8::2');
    expect(out).toContain('1408 bytes from 2001:db8::2');
    expect(requests6).toHaveLength(1);
    expect(requests6[0].icmp.dataSize).toBe(1400);
    expect(requests6[0].packet.payloadLength).toBe(1408);
    expect(replies6[0].icmp.dataSize).toBe(1400);
    expect(replies6[0].packet.payloadLength).toBe(1408);
  });

  it('-s 0 sends an empty echo and gets an empty echo back', async () => {
    const { a, requests6, replies6 } = lab();
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 1 -s 0 2001:db8::2');
    expect(out).toContain('8 bytes from 2001:db8::2');
    expect(requests6[0].icmp.dataSize).toBe(0);
    expect(requests6[0].packet.payloadLength).toBe(8);
    expect(replies6[0].icmp.dataSize).toBe(0);
    expect(replies6[0].packet.payloadLength).toBe(8);
  });

  it('-t 5 sets the hop limit of the request', async () => {
    const { a, requests6 } = lab();
    await pingOnSimulatedClock(a, 'ping -6 -c 1 -t 5 2001:db8::2');
    expect(requests6[0].packet.hopLimit).toBe(5);
  });

  it('-Q sets the traffic class, in hexadecimal or decimal, and the reply of a Linux host carries it back', async () => {
    const { a, requests6, replies6 } = lab();
    expect(await pingOnSimulatedClock(a, 'ping -6 -c 1 -Q 0x28 2001:db8::2')).toContain('1 received');
    expect(await pingOnSimulatedClock(a, 'ping -6 -c 1 -Q 40 2001:db8::2')).toContain('1 received');
    expect(requests6.map((r) => r.packet.trafficClass)).toEqual([0x28, 0x28]);
    expect(replies6.map((r) => r.packet.trafficClass)).toEqual([0x28, 0x28]);
  });

  it('-F sets the flow label of the request, writes it in the header line, and the reply does not reflect it', async () => {
    const { a, requests6, replies6 } = lab();
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 1 -F 12345 2001:db8::2');
    expect(out).toContain('PING 2001:db8::2(2001:db8::2) , flow 0x03039, 56 data bytes');
    expect(requests6[0].packet.flowLabel).toBe(12345);
    expect(replies6[0].packet.flowLabel).toBe(0);
  });

  it('-F also takes the 0x form', async () => {
    const { a, requests6 } = lab();
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 1 -F 0xfffff 2001:db8::2');
    expect(out).toContain(', flow 0xfffff, ');
    expect(requests6[0].packet.flowLabel).toBe(0xfffff);
  });

  it('one run uses one identifier: three probes, one id, three sequence numbers', async () => {
    const { a, requests6 } = lab();
    await pingOnSimulatedClock(a, 'ping -6 -c 3 -i 0.2 2001:db8::2');
    expect(new Set(requests6.map((r) => r.icmp.id)).size).toBe(1);
    expect(requests6.map((r) => r.icmp.sequence)).toEqual([1, 2, 3]);
  });

  it('TEMOIN : a ping with no option leaves as before, 56 data bytes at the default hop limit', async () => {
    const { a, requests6 } = lab();
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 1 2001:db8::2');
    expect(out).toContain('64 bytes from 2001:db8::2');
    expect(requests6[0].icmp.dataSize).toBe(56);
    expect(requests6[0].packet.hopLimit).toBe(64);
    expect(requests6[0].packet.trafficClass).toBe(0);
    expect(requests6[0].packet.flowLabel).toBe(0);
  });
});

describe('-Q and -F are read the way iputils reads them', () => {
  it.each([
    ['-Q abc', 'ping: bad TOS value: abc'],
    ['-Q 0xzz', 'ping: bad TOS value: 0xzz'],
    ['-Q 256', 'ping: the decimal value of TOS bits must be in range 0-255: 256'],
    ['-Q 0x1ff', 'ping: the decimal value of TOS bits must be in range 0-255: 511'],
    ['-F zz', 'ping: bad value for flowinfo: zz'],
    ['-F 0x100000', 'ping: flow value is greater than 20 bits: 0x100000'],
    ['-F -1', 'ping: flow value is greater than 20 bits: -1'],
  ])('%s is refused with the sentence of iputils', async (option, sentence) => {
    const { a, requests6 } = lab();
    expect(await pingOnSimulatedClock(a, `ping -6 -c 1 ${option} 2001:db8::2`)).toBe(sentence);
    expect(requests6).toHaveLength(0);
  });
});

describe('the same options on IPv4', () => {
  it('-Q 0x10 sets the TOS byte of the request, and the reply of a Linux host carries it back', async () => {
    const { a, requests4, replies4 } = lab();
    const out = await pingOnSimulatedClock(a, 'ping -c 1 -Q 0x10 10.0.0.2');
    expect(out).toContain('1 received');
    expect(requests4.map((r) => r.packet.tos)).toEqual([0x10]);
    expect(replies4.map((r) => r.packet.tos)).toEqual([0x10]);
  });

  it('TEMOIN : a ping with no -Q leaves with a TOS byte of 0', async () => {
    const { a, requests4 } = lab();
    expect(await pingOnSimulatedClock(a, 'ping -c 1 10.0.0.2')).toContain('1 received');
    expect(requests4.map((r) => r.packet.tos)).toEqual([0]);
  });

  it('TEMOIN : -F is an IPv6 option, an IPv4 ping accepts it and ignores it', async () => {
    const { a } = lab();
    const out = await pingOnSimulatedClock(a, 'ping -4 -c 1 -F 12345 127.0.0.1');
    expect(out).toContain('1 received');
  });
});
