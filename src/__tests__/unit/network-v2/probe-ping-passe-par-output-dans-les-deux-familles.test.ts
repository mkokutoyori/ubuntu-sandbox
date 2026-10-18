/**
 * Un echo que ping emet est un paquet LOCAL : il traverse la chaine OUTPUT avant de partir, en IPv6 comme en IPv4, et la reponse qu'un hote
 * renvoie la traverse aussi. DROP refuse l'envoi (sendmsg rend EPERM) : ping n'ecrit rien, la sonde est comptee comme envoyee. REJECT genere
 * l'erreur ICMP que choisit `--reject-with`, de l'adresse de l'emetteur vers lui-meme : ping l'imprime « From <adresse> icmp_seq=N ... »
 * puis « ping: sendmsg: Operation not permitted », la sonde est comptee dans « +N errors ». Une regle qui attrape AUSSI l'erreur generee
 * (`-p icmp -j REJECT` sans autre critere) la rejette a son tour : le noyau ne repond jamais a une erreur ICMP, donc rien n'est imprime.
 *
 * Mesure de depart (2da9bf8d, deux LinuxPC sur un lien, v4 et v6) :
 *     ip6tables -A OUTPUT -d B -p icmpv6 -j DROP       ->  ping -6 B repond : la chaine OUTPUT d'IPv6 n'est jamais consultee par un echo
 *     ip6tables -P OUTPUT DROP                         ->  ping -6 B, ping -6 ::1 et ping -6 sa propre adresse repondent
 *     ip6tables -A OUTPUT -d B -p icmpv6 -j REJECT     ->  idem (la requete part, aucune erreur)
 *     ip6tables (sur B) -A OUTPUT --icmpv6-type echo-reply -j DROP  ->  ping -6 B repond : la reponse d'IPv6 ne passe pas par OUTPUT,
 *                                                         alors que celle d'IPv4 y passe (le meme DROP rend 100% de perte en IPv4)
 *     iptables -A OUTPUT -d B -p icmp -j REJECT        ->  ping B : silence, 100% de perte : l'erreur de REJECT n'est jamais renvoyee a ping
 *     iptables -A OUTPUT -d B -p icmp -j DROP          ->  silence (conforme : la ligne « sendmsg » n'est pas ecrite pour un DROP, voir ci-dessous)
 *
 * Autorites : le noyau Linux 6.1 -- net/netfilter/core.c nf_hook_slow (NF_DROP rend -EPERM a l'appelant, donc sendmsg), net/ipv4/
 * netfilter/nf_reject_ipv4.c nf_send_unreach et net/ipv6/netfilter/nf_reject_ipv6.c nf_send_unreach6 (qui traite NF_INET_LOCAL_OUT :
 * le paquet local recoit le peripherique de bouclage), net/ipv6/icmp.c icmp6_send (la source de l'erreur est l'adresse de destination du
 * paquet fautif quand elle est locale, sinon la source choisie par la route vers l'emetteur, c'est-a-dire l'emetteur lui-meme),
 * is_ineligible (net/ipv6/icmp.c) et __icmp_send (net/ipv4/icmp.c, « Assume any unknown ICMP type is an error ») qui ne repondent pas a
 * une erreur ICMP -- et iputils 20221126 ping_common.c pinger : apres un sendmsg refuse, receive_error_msg rend un nombre POSITIF quand
 * une erreur ICMP attend (« An ICMP error arrived ... treat this as a hard local error » : i = 0, donc la ligne « sendmsg » est ecrite),
 * et ZERO-OU-MOINS quand la file d'erreurs est vide (EAGAIN compte comme une erreur locale : i < 0, donc aucune ligne). Un DROP
 * n'ecrit donc rien dans cette version ; c'est ce qu'IPv4 faisait deja et ce que IPv6 fait maintenant.
 *
 * Discrimination : 19 des 27 cas tombent contre 2da9bf8d additionne de l'etape precedente (les types ICMP des regles), EndHost, Errno et
 * Ping remis a leur etat, la sonde conservee. Huit passent des deux cotes : deux cas IPv4 deja conformes (DROP par regle et par politique)
 * et six TEMOINS -- une regle pour une autre destination ne change rien, la regle retiree rend les reponses, la reponse IPv4 traversait
 * deja OUTPUT, une regle sur un autre type laisse passer la reponse, et l'erreur d'une AUTRE machine (REJECT en INPUT de B, en v4 et en v6)
 * n'est pas un refus d'envoi.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import type { EchoOptions, Echo6Options, PingResult } from '@/network/devices/EndHost';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, IPv6Address, MACAddress, SubnetMask, resetCounters } from '@/network/core/types';
import type { ICMPPacket, ICMPv6Packet, IPv4Packet, IPv6Packet } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { errnoNumber, strerror } from '@/network/core/Errno';
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

function echoRequestsSentBy(host: LinuxPC): { count: () => number } {
  let sent = 0;
  host.attachCapture(({ direction, frame }) => {
    if (direction !== 'out') return;
    const v6 = frame.payload as IPv6Packet | undefined;
    if (v6?.type === 'ipv6' && v6.nextHeader === 58 && (v6.payload as ICMPv6Packet).icmpType === 'echo-request') sent++;
    const v4 = frame.payload as IPv4Packet | undefined;
    if (v4?.type === 'ipv4' && v4.protocol === 1 && (v4.payload as ICMPPacket).icmpType === 'echo-request') sent++;
  });
  return { count: () => sent };
}

interface RawEchoEngine {
  executePing6Sequence(target: IPv6Address, count: number, timeoutMs: number, options: Echo6Options): Promise<PingResult[]>;
  executePingSequence(
    target: IPAddress, count: number, timeoutMs: number, ttl: number | undefined, options: EchoOptions,
  ): Promise<PingResult[]>;
}

const rawEchoEngine = (host: LinuxPC): RawEchoEngine => host as unknown as RawEchoEngine;

const SENDMSG = 'ping: sendmsg: Operation not permitted';

describe('a DROP in OUTPUT refuses the send : nothing on the wire, nothing printed, the probe counted as sent', () => {
  it.each([
    ['IPv6', 'ip6tables -A OUTPUT -d 2001:db8::2 -p icmpv6 -j DROP', 'ping -6 -c 2 -W 1 2001:db8::2'],
    ['IPv4', 'iptables -A OUTPUT -d 10.0.0.2 -p icmp -j DROP', 'ping -c 2 -W 1 10.0.0.2'],
    ['IPv6 policy', 'ip6tables -P OUTPUT DROP', 'ping -6 -c 2 -W 1 2001:db8::2'],
    ['IPv4 policy', 'iptables -P OUTPUT DROP', 'ping -c 2 -W 1 10.0.0.2'],
  ])('%s : %s', async (_family, rule, command) => {
    const { a } = pair();
    const wire = echoRequestsSentBy(a);
    await a.executeCommand(`sudo ${rule}`);
    const out = await pingOnSimulatedClock(a, command);
    expect(out).not.toContain('bytes from');
    expect(out).not.toContain('sendmsg');
    expect(out).toContain('2 packets transmitted, 0 received, 100% packet loss');
    expect(out).not.toContain('errors');
    expect(wire.count()).toBe(0);
  });

  it('TEMOIN : a rule for another destination changes nothing, in both families', async () => {
    const { a } = pair();
    await a.executeCommand('sudo ip6tables -A OUTPUT -d 2001:db8::99 -p icmpv6 -j DROP');
    await a.executeCommand('sudo iptables -A OUTPUT -d 10.0.0.99 -p icmp -j DROP');
    expect(await pingOnSimulatedClock(a, 'ping -6 -c 1 2001:db8::2')).toContain('64 bytes from 2001:db8::2: icmp_seq=1');
    expect(await pingOnSimulatedClock(a, 'ping -c 1 10.0.0.2')).toContain('64 bytes from 10.0.0.2: icmp_seq=1');
  });

  it('TEMOIN : with the rule removed the same probes are answered, so the loss above is the rule\'s', async () => {
    const { a } = pair();
    await a.executeCommand('sudo ip6tables -A OUTPUT -d 2001:db8::2 -p icmpv6 -j DROP');
    await a.executeCommand('sudo ip6tables -F OUTPUT');
    expect(await pingOnSimulatedClock(a, 'ping -6 -c 1 2001:db8::2')).toContain('64 bytes from 2001:db8::2: icmp_seq=1');
  });

  it('the raw result of a refused send names the errno and nothing else', async () => {
    const { a } = pair();
    await a.executeCommand('sudo ip6tables -A OUTPUT -d 2001:db8::2 -p icmpv6 -j DROP');
    const raw = await rawEchoEngine(a).executePing6Sequence(new IPv6Address('2001:db8::2'), 1, 500, {});
    expect(raw).toEqual([{
      success: false, rttMs: 0, ttl: 0, seq: 1, bytes: 0, fromIP: '', error: 'Operation not permitted', sendError: 'EPERM',
    }]);
  });
});

describe('the errno table numbers a refused send as Linux does', () => {
  it('EPERM is errno 1, "Operation not permitted"', () => {
    expect(errnoNumber('EPERM')).toBe(1);
    expect(strerror('EPERM')).toBe('Operation not permitted');
  });
});

describe('a REJECT in OUTPUT hands the socket the error it chose, then the send fails', () => {
  it.each([
    ['IPv6', 'ip6tables -A OUTPUT -d 2001:db8::2 -p icmpv6 -j REJECT', 'ping -6 -c 2 -W 1 2001:db8::2', 'From 2001:db8::1', 'Destination unreachable: Port unreachable'],
    ['IPv6 adm-prohibited', 'ip6tables -A OUTPUT -d 2001:db8::2 -p icmpv6 -j REJECT --reject-with icmp6-adm-prohibited', 'ping -6 -c 2 -W 1 2001:db8::2', 'From 2001:db8::1', 'Destination unreachable: Administratively prohibited'],
    ['IPv6 no-route', 'ip6tables -A OUTPUT -d 2001:db8::2 -p icmpv6 -j REJECT --reject-with icmp6-no-route', 'ping -6 -c 2 -W 1 2001:db8::2', 'From 2001:db8::1', 'Destination unreachable: No route'],
    ['IPv6 addr-unreach', 'ip6tables -A OUTPUT -d 2001:db8::2 -p icmpv6 -j REJECT --reject-with addr-unreach', 'ping -6 -c 2 -W 1 2001:db8::2', 'From 2001:db8::1', 'Destination unreachable: Address unreachable'],
    ['IPv4', 'iptables -A OUTPUT -d 10.0.0.2 -p icmp -j REJECT', 'ping -c 2 -W 1 10.0.0.2', 'From 10.0.0.1', 'Destination Port Unreachable'],
    ['IPv4 host-prohibited', 'iptables -A OUTPUT -d 10.0.0.2 -p icmp -j REJECT --reject-with icmp-host-prohibited', 'ping -c 2 -W 1 10.0.0.2', 'From 10.0.0.1', 'Destination Host Prohibited'],
    ['IPv4 net-unreach', 'iptables -A OUTPUT -d 10.0.0.2 -p icmp -j REJECT --reject-with net-unreach', 'ping -c 2 -W 1 10.0.0.2', 'From 10.0.0.1', 'Destination Net Unreachable'],
  ])('%s : « %s » -> « %s ... %s »', async (_family, rule, command, from, sentence) => {
    const { a } = pair();
    const wire = echoRequestsSentBy(a);
    await a.executeCommand(`sudo ${rule}`);
    const out = await pingOnSimulatedClock(a, command);
    const lines = out.split('\n');
    expect(lines).toContain(`${from} icmp_seq=1 ${sentence}`);
    expect(lines).toContain(`${from} icmp_seq=2 ${sentence}`);
    expect(lines.filter((line) => line === SENDMSG)).toHaveLength(2);
    expect(lines.indexOf(SENDMSG)).toBe(lines.indexOf(`${from} icmp_seq=1 ${sentence}`) + 1);
    expect(out).toContain('2 packets transmitted, 0 received, +2 errors, 100% packet loss');
    expect(wire.count()).toBe(0);
  });

  it('-q keeps the count and prints no line', async () => {
    const { a } = pair();
    await a.executeCommand('sudo ip6tables -A OUTPUT -d 2001:db8::2 -p icmpv6 -j REJECT');
    const out = await pingOnSimulatedClock(a, 'ping -6 -q -c 2 -W 1 2001:db8::2');
    expect(out).not.toContain('sendmsg');
    expect(out).not.toContain('Destination unreachable');
    expect(out).toContain('+2 errors');
  });

  it('-D stamps the error line and not the sendmsg line', async () => {
    const { a } = pair();
    await a.executeCommand('sudo iptables -A OUTPUT -d 10.0.0.2 -p icmp -j REJECT');
    const out = await pingOnSimulatedClock(a, 'ping -D -c 1 -W 1 10.0.0.2');
    expect(out).toMatch(/\n\[\d+\.\d{6}\] From 10\.0\.0\.1 icmp_seq=1 Destination Port Unreachable\nping: sendmsg: Operation not permitted\n/);
  });

  it('the raw result carries the report of the error and the errno of the send', async () => {
    const { a } = pair();
    await a.executeCommand('sudo ip6tables -A OUTPUT -d 2001:db8::2 -p icmpv6 -j REJECT --reject-with icmp6-adm-prohibited');
    const [raw] = await rawEchoEngine(a).executePing6Sequence(new IPv6Address('2001:db8::2'), 1, 500, {});
    expect(raw.sendError).toBe('EPERM');
    expect(raw.icmp6).toEqual({ from: '2001:db8::1', type: 'destination-unreachable', code: 1 });
    expect(raw.fromIP).toBe('2001:db8::1');
  });

  it('a rule that also catches the error it generates rejects it in turn, and the kernel answers no ICMP error with an ICMP error : silence', async () => {
    const { a } = pair();
    await a.executeCommand('sudo iptables -A OUTPUT -p icmp -j REJECT');
    await a.executeCommand('sudo ip6tables -A OUTPUT -p icmpv6 -j REJECT');
    for (const command of ['ping -c 1 -W 1 10.0.0.2', 'ping -6 -c 1 -W 1 2001:db8::2']) {
      const out = await pingOnSimulatedClock(a, command);
      expect(out).not.toContain('From ');
      expect(out).not.toContain('sendmsg');
      expect(out).toContain('1 packets transmitted, 0 received, 100% packet loss');
    }
  });
});

describe('the reply of an IPv6 host crosses its OUTPUT chain like the reply of an IPv4 host', () => {
  it.each([
    ['DROP', 'ip6tables -A OUTPUT -p icmpv6 --icmpv6-type echo-reply -j DROP'],
    ['REJECT', 'ip6tables -A OUTPUT -p icmpv6 --icmpv6-type echo-reply -j REJECT'],
    ['policy DROP', 'ip6tables -P OUTPUT DROP'],
  ])('IPv6 : %s on the reply, the pinger sees a loss and no error', async (_verdict, rule) => {
    const { a, b } = pair();
    await b.executeCommand(`sudo ${rule}`);
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 1 -W 1 2001:db8::2');
    expect(out).not.toContain('bytes from');
    expect(out).not.toContain('From ');
    expect(out).toContain('1 packets transmitted, 0 received, 100% packet loss');
  });

  it('TEMOIN : IPv4 already did', async () => {
    const { a, b } = pair();
    await b.executeCommand('sudo iptables -A OUTPUT -p icmp --icmp-type echo-reply -j DROP');
    const out = await pingOnSimulatedClock(a, 'ping -c 1 -W 1 10.0.0.2');
    expect(out).toContain('1 packets transmitted, 0 received, 100% packet loss');
  });

  it('TEMOIN : a rule on another type lets the reply through', async () => {
    const { a, b } = pair();
    await b.executeCommand('sudo ip6tables -A OUTPUT -p icmpv6 --icmpv6-type echo-request -j DROP');
    expect(await pingOnSimulatedClock(a, 'ping -6 -c 1 2001:db8::2')).toContain('64 bytes from 2001:db8::2: icmp_seq=1');
  });
});

describe('an error that comes from the other machine is not a refusal of the send', () => {
  it.each([
    ['ip6tables -A INPUT -p icmpv6 -j REJECT', 'ping -6 -c 1 -W 1 2001:db8::2', 'From 2001:db8::2 icmp_seq=1 Destination unreachable: Port unreachable'],
    ['iptables -A INPUT -p icmp -j REJECT', 'ping -c 1 -W 1 10.0.0.2', 'From 10.0.0.2 icmp_seq=1 Destination Port Unreachable'],
  ])('TEMOIN : %s on B -> « %s », and no sendmsg line', async (rule, command, line) => {
    const { a, b } = pair();
    await b.executeCommand(`sudo ${rule}`);
    const out = await pingOnSimulatedClock(a, command);
    expect(out.split('\n')).toContain(line);
    expect(out).not.toContain('sendmsg');
  });
});

describe('-f prints one character per refused probe', () => {
  it('TEMOIN : a DROP prints a dot, a REJECT prints an E', async () => {
    const dropped = pair();
    await dropped.a.executeCommand('sudo ip6tables -A OUTPUT -d 2001:db8::2 -p icmpv6 -j DROP');
    expect((await pingOnSimulatedClock(dropped.a, 'sudo ping -6 -f -c 2 -W 1 2001:db8::2')).split('\n')).toContain('..');
    const rejected = pair();
    await rejected.a.executeCommand('sudo ip6tables -A OUTPUT -d 2001:db8::2 -p icmpv6 -j REJECT');
    expect((await pingOnSimulatedClock(rejected.a, 'sudo ping -6 -f -c 2 -W 1 2001:db8::2')).split('\n')).toContain('EE');
  });
});
