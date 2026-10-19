/**
 * `ping -6 -M do` refuse A LA SOURCE une sonde plus grande que le MTU du chemin -- « ping: local error: message too long, mtu: 1500 »,
 * sans rien mettre sur le fil -- et tout datagramme de plus de 65535 octets de charge utile est refuse quel que soit le mode. Le MTU qui
 * decide est celui que le noyau connait : le MTU de l'interface, ou celui qu'un Packet Too Big a appris pour cette destination ; vers
 * soi-meme et vers ::1, c'est celui de lo (65536).
 *
 * Mesure de depart (a5d3df8d, deux LinuxPC sur un lien a 1500, et un LinuxPC derriere un routeur Cisco dont la jambe de B porte
 * `ipv6 mtu 1280`) :
 *     ping -6 -c 1 -s 1453 -M do B            ->  « 1461 bytes from ... time=... » : -M est lu et ignore, la sonde de 1501 octets part
 *     ping -6 -c 2 -s 2000 -M do B            ->  deux reponses : le mode « interdire la fragmentation » fragmente
 *     ping -6 -c 1 -s 65528 B                 ->  (rien) puis « 100% packet loss » : 65536 octets de charge ne sont pas un datagramme IPv6
 *     ping -6 -c 1 -s 65528 ::1               ->  « 65536 bytes from ::1 »
 *     ping -6 -c 1 -s 65500 -M do ::1         ->  une reponse, alors que 65548 octets ne tiennent pas dans lo (65536)
 *     ping -6 -c 3 -s 1400 -M do B (routeur)  ->  un Packet Too Big puis DEUX reponses : le MTU appris (1280) n'est pas applique par -M do
 *     sudo ping -f -c 3 -s 2000 -M do 10.0.0.2 -> « ... » : trois points, alors que l'erreur locale imprime « E » (IPv4 aussi)
 * Et IPv4 portait le meme refus sous forme d'une chaine « local error: message too long, mtu=1500 » relue par trois lecteurs (Ping.ts,
 * LinuxFormatHelpers, WinPing) ; une copie du type PingResult dans WinCommandExecutor.ts n'avait pas de champ pour la porter.
 *
 * Autorites : iputils 20221126 ping/ping6_common.c -- IPV6_MTU_DISCOVER recoit le mode de -M (do, want, dont) ; ping6_receive_error_msg
 * imprime « local error: message too long, mtu: %u » avec `ee_info` (IPv4 : « mtu=%u ») ; ping_common.c pinger fait de l'erreur locale
 * un « hard local error » : la sonde est comptee comme envoyee, aucune ligne « sendmsg », « E » en mode flood, « +N errors » au bilan.
 * Noyau Linux 6.1 net/ipv6/ip6_output.c __ip6_append_data : `maxnonfragsize` vaut sizeof(ipv6hdr) + IPV6_MAXPLEN quand
 * ip6_sk_ignore_df(sk) (pmtudisc < DO, ou OMIT), c'est-a-dire want et dont fragmentent a la source, et vaut le MTU pour DO ;
 * `cork->length + length > maxnonfragsize - headersize` -> ipv6_local_error(EMSGSIZE, pmtu) avec pmtu = mtu - headersize + 40 = mtu ;
 * ip6_setup_cork choisit `dst_mtu` (MTU de l'interface ou PMTU appris) tant que pmtudisc < PROBE. En-tete IPv6 40 + ICMPv6 8 = 48.
 *
 * Discrimination : 34 des 51 cas tombent contre a5d3df8d (EndHost, Ipv6Fragmentation, Ping, LinuxFormatHelpers, WinPing et
 * WinCommandExecutor remis a leur etat, la sonde conservee). Passent des deux cotes dix-sept TEMOINS, et pourquoi : « -s 1452 tient dans
 * 1500 », « want, dont et le defaut fragmentent » (trois cas), « -s 65527 est le plus grand datagramme », les quatre trajets par lo qui
 * tiennent (::1 en 65527, ::1 en -M do 65488, sa propre adresse en -M do 1453, ping sans -6 vers ::1), « en want le meme chemin se
 * joint en fragments », « une sonde qui tient dans la jambe etroite n'est jamais refusee », les deux TEMOINS IPv4 « mtu=1500 » et
 * « -s 1472 tient », les deux TEMOINS de flood (l'erreur d'un routeur est un E, une sonde sans reponse est un point) et les deux cas
 * Windows (l'ancienne chaine etait relue par WinPing : le message ne change pas, c'est la lecture qui change de forme) : ils prouvent que
 * le banc voit les reponses, que le refus ne mange pas ce qui tient et que ce qui n'a pas a bouger n'a pas bouge.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import type { EchoOptions, Echo6Options, PingResult } from '@/network/devices/EndHost';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, IPv6Address, MACAddress, SubnetMask, resetCounters } from '@/network/core/types';
import type { ICMPv6Packet, IPv6Packet } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { ipv6SendRefusal } from '@/network/layers/internet/Ipv6Fragmentation';
import { pingOnSimulatedClock } from '../../support/fastPing';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function pair() {
  const a = new LinuxPC('A', 0, 0);
  const b = new LinuxPC('B', 0, 0);
  new Cable('c').connect(a.getPort('eth0')!, b.getPort('eth0')!);
  a.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);
  b.configureIPv6Interface('eth0', new IPv6Address('2001:db8::2'), 64);
  a.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  b.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { a, b };
}

async function routed() {
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

interface RawEchoEngine {
  executePing6Sequence(target: IPv6Address, count: number, timeoutMs: number, options: Echo6Options): Promise<PingResult[]>;
  executePingSequence(
    target: IPAddress, count: number, timeoutMs: number, ttl: number | undefined, options: EchoOptions,
  ): Promise<PingResult[]>;
}

const rawEchoEngine = (host: LinuxPC): RawEchoEngine => host as unknown as RawEchoEngine;

function echoPacketsSentBy(host: LinuxPC): { count: () => number } {
  let sent = 0;
  host.attachCapture(({ direction, frame }) => {
    const packet = frame.payload as IPv6Packet | undefined;
    if (direction !== 'out' || packet?.type !== 'ipv6') return;
    const carriesEcho = packet.nextHeader === 58 && (packet.payload as ICMPv6Packet).icmpType === 'echo-request';
    if (carriesEcho || packet.nextHeader === 44) sent++;
  });
  return { count: () => sent };
}

describe('-M do refuses at the source a probe that does not fit the interface', () => {
  it.each([
    [1453, 1500],
    [1500, 1500],
    [2000, 1500],
    [9000, 1500],
    [65527, 1500],
  ])('-s %i : « ping: local error: message too long, mtu: %i », one error, nothing received', async (size, mtu) => {
    const { a } = pair();
    const out = await pingOnSimulatedClock(a, `ping -6 -c 1 -s ${size} -M do 2001:db8::2`);
    expect(out).toContain(`\nping: local error: message too long, mtu: ${mtu}\n`);
    expect(out).toContain('1 packets transmitted, 0 received, +1 errors, 100% packet loss');
    expect(out).not.toContain('bytes from');
  });

  it('TEMOIN : -s 1452 makes 1500 octets with the headers and goes through', async () => {
    const { a } = pair();
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 1 -s 1452 -M do 2001:db8::2');
    expect(out).toMatch(/\n1460 bytes from 2001:db8::2: icmp_seq=1 ttl=64 time=/);
    expect(out).not.toContain('local error');
    expect(out).not.toContain('errors');
  });

  it('every probe of a series is refused, each with its line, and all are counted', async () => {
    const { a } = pair();
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 3 -s 2000 -M do 2001:db8::2');
    expect(out.split('\n').filter((line) => line === 'ping: local error: message too long, mtu: 1500')).toHaveLength(3);
    expect(out).toContain('3 packets transmitted, 0 received, +3 errors, 100% packet loss');
  });

  it('the line carries the name the command was typed under', async () => {
    const { a } = pair();
    const out = await pingOnSimulatedClock(a, 'ping6 -c 1 -s 2000 -M do 2001:db8::2');
    expect(out).toContain('\nping6: local error: message too long, mtu: 1500\n');
  });

  it('-q hides the line and keeps the count', async () => {
    const { a } = pair();
    const out = await pingOnSimulatedClock(a, 'ping -6 -q -c 2 -s 2000 -M do 2001:db8::2');
    expect(out).not.toContain('local error');
    expect(out).toContain('2 packets transmitted, 0 received, +2 errors, 100% packet loss');
  });

  it('-f shows one E per refused probe and no dot', async () => {
    const { a } = pair();
    const out = await pingOnSimulatedClock(a, 'sudo ping -6 -f -c 3 -s 2000 -M do 2001:db8::2');
    expect(out.split('\n')).toContain('EEE');
    expect(out).toContain('3 packets transmitted, 0 received, +3 errors, 100% packet loss');
  });

  it('the refused probe leaves no echo request and no fragment on the wire, while the same size in want mode leaves several', async () => {
    const { a } = pair();
    const wire = echoPacketsSentBy(a);
    await pingOnSimulatedClock(a, 'ping -6 -c 1 -s 2000 -M do 2001:db8::2');
    expect(wire.count()).toBe(0);
    await pingOnSimulatedClock(a, 'ping -6 -c 1 -s 2000 -M want 2001:db8::2');
    expect(wire.count()).toBeGreaterThan(1);
  });
});

describe('flood prints one character per failed probe : E for an error, a dot for a loss', () => {
  it('TEMOIN : an error from a router is an E', async () => {
    const { a } = await routed();
    const out = await pingOnSimulatedClock(a, 'sudo ping -6 -f -c 2 -t 1 2001:db8:2::2');
    expect(out.split('\n')).toContain('EE');
  });

  it('TEMOIN : a probe nobody answers is a dot', async () => {
    const { a, b } = pair();
    await b.executeCommand('sudo ip6tables -A INPUT -p icmpv6 --icmpv6-type echo-request -j DROP');
    const out = await pingOnSimulatedClock(a, 'sudo ping -6 -f -c 2 -W 1 2001:db8::2');
    expect(out.split('\n')).toContain('..');
    expect(out).toContain('2 packets transmitted, 0 received, 100% packet loss');
  });
});

describe('want and dont, and the default, fragment at the source', () => {
  it.each([
    ['-M want'],
    ['-M dont'],
    [''],
  ])('TEMOIN : -s 2000 %s goes through, answered whole', async (mode) => {
    const { a } = pair();
    const out = await pingOnSimulatedClock(a, `ping -6 -c 1 -s 2000 ${mode} 2001:db8::2`);
    expect(out).toMatch(/\n2008 bytes from 2001:db8::2: icmp_seq=1 ttl=64 time=/);
    expect(out).not.toContain('local error');
  });
});

describe('no datagram carries more than 65535 octets of payload, whatever the mode', () => {
  it.each([
    [''],
    ['-M want'],
    ['-M dont'],
    ['-M do'],
  ])('-s 65528 %s is refused with the interface MTU, and is no longer a silent loss', async (mode) => {
    const { a } = pair();
    const out = await pingOnSimulatedClock(a, `ping -6 -c 1 -s 65528 ${mode} 2001:db8::2`);
    expect(out).toContain('\nping: local error: message too long, mtu: 1500\n');
    expect(out).toContain('+1 errors');
  });

  it('TEMOIN : -s 65527 is the largest datagram and is answered in fragments', async () => {
    const { a } = pair();
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 1 -s 65527 2001:db8::2');
    expect(out).toMatch(/\n65535 bytes from 2001:db8::2: icmp_seq=1 ttl=64 time=/);
    expect(out).not.toContain('local error');
  });
});

describe('the loopback and the addresses of the machine travel through lo, 65536 octets', () => {
  it.each([
    ['ping -6 -c 1 -s 65528 ::1', 'ping: local error: message too long, mtu: 65536'],
    ['ping -6 -c 1 -s 65528 -M do ::1', 'ping: local error: message too long, mtu: 65536'],
    ['ping -6 -c 1 -s 65500 -M do ::1', 'ping: local error: message too long, mtu: 65536'],
    ['ping -6 -c 1 -s 65528 2001:db8::1', 'ping: local error: message too long, mtu: 65536'],
  ])('%s -> « %s »', async (command, sentence) => {
    const { a } = pair();
    const out = await pingOnSimulatedClock(a, command);
    expect(out).toContain(`\n${sentence}\n`);
    expect(out).toContain('+1 errors');
  });

  it.each([
    ['ping -6 -c 1 -s 65527 ::1', '65535 bytes from ::1'],
    ['ping -6 -c 1 -s 65488 -M do ::1', '65496 bytes from ::1'],
    ['ping -6 -c 1 -s 1453 -M do 2001:db8::1', '1461 bytes from 2001:db8::1'],
    ['ping -c 1 -s 2000 -M do ::1', '2008 bytes from ::1'],
  ])('TEMOIN : %s still goes through', async (command, reply) => {
    const { a } = pair();
    const out = await pingOnSimulatedClock(a, command);
    expect(out).toContain(`\n${reply}: icmp_seq=1`);
    expect(out).not.toContain('local error');
  });
});

describe('the path MTU learned from a Packet Too Big decides the next -M do probe', () => {
  it('the first probe draws the Packet Too Big, the next ones are refused with the learned MTU', async () => {
    const { a } = await routed();
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 3 -s 1400 -M do 2001:db8:2::2');
    const lines = out.split('\n');
    expect(lines).toContain('From 2001:db8:1::1 icmp_seq=1 Packet too big: mtu=1280');
    expect(lines.filter((line) => line === 'ping: local error: message too long, mtu: 1280')).toHaveLength(2);
    expect(out).toContain('3 packets transmitted, 0 received, +3 errors, 100% packet loss');
  });

  it('the boundary is the learned MTU : 1280 octets go through, 1281 do not', async () => {
    const fits = await routed();
    const fitting = await pingOnSimulatedClock(fits.a, 'ping -6 -c 2 -s 1232 -M do 2001:db8:2::2');
    expect(fitting).toContain('1240 bytes from 2001:db8:2::2: icmp_seq=2');
    expect(fitting).not.toContain('errors');
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    const over = await routed();
    const overflowing = await pingOnSimulatedClock(over.a, 'ping -6 -c 2 -s 1233 -M do 2001:db8:2::2');
    expect(overflowing).toContain('From 2001:db8:1::1 icmp_seq=1 Packet too big: mtu=1280');
    expect(overflowing).toContain('ping: local error: message too long, mtu: 1280');
  });

  it('TEMOIN : in want mode the same destination is reached in fragments once the MTU is learned', async () => {
    const { a } = await routed();
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 3 -s 1400 2001:db8:2::2');
    expect(out).toContain('From 2001:db8:1::1 icmp_seq=1 Packet too big: mtu=1280');
    expect(out).toMatch(/\n1408 bytes from 2001:db8:2::2: icmp_seq=2 ttl=63/);
    expect(out).toMatch(/\n1408 bytes from 2001:db8:2::2: icmp_seq=3 ttl=63/);
    expect(out).not.toContain('local error');
  });

  it('TEMOIN : a probe that fits the far link is never refused', async () => {
    const { a } = await routed();
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 2 -s 1200 -M do 2001:db8:2::2');
    expect(out).toMatch(/\n1208 bytes from 2001:db8:2::2: icmp_seq=1 ttl=63/);
    expect(out).toMatch(/\n1208 bytes from 2001:db8:2::2: icmp_seq=2 ttl=63/);
    expect(out).not.toContain('errors');
  });
});

describe('IPv4 says the same thing in its own words, from the same typed error', () => {
  it('TEMOIN : « mtu=1500 » with an equal sign, counted as an error', async () => {
    const { a } = pair();
    const out = await pingOnSimulatedClock(a, 'ping -c 1 -s 1473 -M do 10.0.0.2');
    expect(out).toContain('\nping: local error: message too long, mtu=1500\n');
    expect(out).toContain('1 packets transmitted, 0 received, +1 errors, 100% packet loss');
  });

  it('TEMOIN : -s 1472 fits', async () => {
    const { a } = pair();
    const out = await pingOnSimulatedClock(a, 'ping -c 1 -s 1472 -M do 10.0.0.2');
    expect(out).toMatch(/\n1480 bytes from 10.0.0.2: icmp_seq=1 ttl=64/);
  });

  it('-f shows E here too, and not a dot', async () => {
    const { a } = pair();
    const out = await pingOnSimulatedClock(a, 'sudo ping -f -c 3 -s 2000 -M do 10.0.0.2');
    expect(out.split('\n')).toContain('EEE');
  });
});

describe('a refused probe comes back from the engine as a typed error, not as a sentence', () => {
  const refused = (seq: number, mtu: number) => ({
    success: false, rttMs: 0, ttl: 0, seq, bytes: 0, fromIP: '',
    error: 'Message too long', localError: { origin: 'local', errno: 'EMSGSIZE', mtu },
  });

  it('on the wire path : the interface MTU, one result per probe', async () => {
    const { a } = pair();
    const raw = await rawEchoEngine(a).executePing6Sequence(new IPv6Address('2001:db8::2'), 2, 500, { dataSize: 2000, neverFragment: true });
    expect(raw).toEqual([refused(1, 1500), refused(2, 1500)]);
  });

  it('on the loopback path : the MTU of lo', async () => {
    const { a } = pair();
    const raw = await rawEchoEngine(a).executePing6Sequence(new IPv6Address('::1'), 1, 500, { dataSize: 65528 });
    expect(raw).toEqual([refused(1, 65536)]);
  });

  it('IPv4 gives the same shape', async () => {
    const { a } = pair();
    const raw = await rawEchoEngine(a).executePingSequence(new IPAddress('10.0.0.2'), 1, 500, undefined, { dataSize: 1473, df: true });
    expect(raw).toEqual([refused(1, 1500)]);
  });
});

describe('Windows reads the same typed error', () => {
  function windowsPair() {
    const win = new WindowsPC('windows-pc', 'WIN');
    const b = new LinuxPC('B', 0, 0);
    new Cable('c').connect(win.getPort('eth0')!, b.getPort('eth0')!);
    win.configureInterface('eth0', new IPAddress('10.0.0.3'), new SubnetMask('255.255.255.0'));
    b.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    return win;
  }

  it('ping -f of a datagram that exceeds the interface says it must be fragmented', async () => {
    const out = await pingOnSimulatedClock(windowsPair(), 'ping -n 1 -f -l 1473 10.0.0.2');
    expect(out).toContain('Packet needs to be fragmented but DF set.');
    expect(out).toContain('Packets: Sent = 1, Received = 0, Lost = 1 (100% loss)');
  });

  it('TEMOIN : -l 1472 fits and is answered', async () => {
    const out = await pingOnSimulatedClock(windowsPair(), 'ping -n 1 -f -l 1472 10.0.0.2');
    expect(out).toContain('Reply from 10.0.0.2: bytes=1472');
    expect(out).not.toContain('fragmented');
  });
});

describe('the size rule on its own, in octets of IPv6 payload', () => {
  it.each([
    [65535, 1500, false, false],
    [65536, 1500, false, true],
    [65536, 65536, true, true],
    [1460, 1500, true, false],
    [1461, 1500, true, true],
    [1461, 1500, false, false],
    [1240, 1280, true, false],
    [1241, 1280, true, true],
    [65496, 65536, true, false],
    [65497, 65536, true, true],
  ])('payload %i, path MTU %i, never fragment %s -> refused %s', (payload, mtu, neverFragment, refused) => {
    const verdict = ipv6SendRefusal(payload, mtu, neverFragment);
    expect(verdict !== null).toBe(refused);
    if (verdict !== null) expect(verdict).toEqual({ origin: 'local', errno: 'EMSGSIZE', mtu });
  });
});
