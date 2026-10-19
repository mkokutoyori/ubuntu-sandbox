/**
 * La decouverte de voisins d'IPv6 traverse ip6tables comme n'importe quel autre message ICMPv6 : sollicitation et annonce de voisin,
 * sollicitation et annonce de routeur sont des paquets, ils sortent par la chaine OUTPUT de l'emetteur et entrent par la chaine INPUT du
 * destinataire, et `ip6tables -P INPUT DROP` sans une regle ICMPv6 coupe donc IPv6 sur le lien -- c'est la derniere regle que tout
 * pare-feu IPv6 apprend a ecrire. L'hote exemptait les quatre types dans les deux sens (« les bloquer casserait la resolution
 * d'adresse elle-meme »), si bien qu'aucune regle ne les voyait ni ne les comptait, et qu'une politique stricte laissait IPv6 marcher
 * la ou le noyau le coupe. Les messages de decouverte de voisins ne sont pas suivis par conntrack (UNTRACKED, ni NEW ni INVALID).
 *
 * Mesure de depart (55dd58e7 ; deux LinuxPC sur un lien, 2001:db8::1 et 2001:db8::2) :
 *     B : ip6tables -P INPUT DROP, -A INPUT -p icmpv6 --icmpv6-type echo-request -j ACCEPT   ->  ping -6 B repond : la sollicitation de A entre quand meme
 *     B : ip6tables -A INPUT -p icmpv6 --icmpv6-type neighbor-solicitation -j ACCEPT, apres un ping -6 de A  ->  la regle compte 0
 *     A : ip6tables -A OUTPUT -p icmpv6 --icmpv6-type neighbor-solicitation -j DROP     ->  ping -6 B repond, la regle compte 0
 *     A : ip6tables -A OUTPUT -p icmpv6 --icmpv6-type router-solicitation -j DROP, puis sendRouterSolicitation  ->  la regle compte 0
 *     B : ufw enable (politique INPUT deny), puis ping -6 de A  ->  l'entree de B est dans le cache de A (la decouverte passe, le ping est refuse)
 *
 * Autorites : noyau Linux 6.1 -- net/ipv6/ndisc.c (ndisc_send_skb : NF_HOOK(NFPROTO_IPV6, NF_INET_LOCAL_OUT, ..., dst_output) ; la reception
 * passe par ip6_input puis NF_INET_LOCAL_IN avant icmpv6_rcv), net/netfilter/nf_conntrack_proto_icmpv6.c (types 133 a 136 : UNTRACKED) ;
 * ufw 0.36 etc/ufw/before6.rules (les sollicitations et annonces de voisin et de routeur sont acceptees par type).
 *
 * Non fait ici, dit comme tel : les accepts de voisinage du fichier d'ufw n'ont pas le `-m hl --hl-eq 255` de l'original -- le module hl
 * n'existe pas encore, et l'ecrire serait stocker un critere que personne n'evalue.
 *
 * Discrimination : contre l'arbre sans le lot (sources remises a leur etat, sonde conservee), 18 des 28 cas tombent et 10 passent des deux
 * cotes : cinq TEMOINS (sans regle ; ufw avec l'emetteur autorise ; la sortie interdite sans regle pour la destination, ou l'echo est
 * refuse de toute facon ; le laboratoire du routeur sans ufw ; la regle qui accepte l'annonce et rend l'autoconfiguration), le cas qui
 * rend le lien (ACCEPT par type dans les deux chaines), qui prouve que le laboratoire marche et non que la regle decide, l'annonce de
 * routeur non sollicitee sous un ufw par defaut deny (la decouverte n'etait pas filtree avant : l'annonce entrait, et elle entre
 * maintenant parce que la regle de ufw l'accepte) et deux cas de l'ordre que l'ancien code tenait par construction, puisqu'il ne comptait
 * pas la decouverte : un DROP de politique ou un REJECT refuse l'echo avant toute sollicitation, et une adresse que personne ne porte fait dire « Address
 * unreachable » a chaque sonde. Ils gardent l'ordre du lot : le crochet d'abord, le voisin ensuite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, IPv6Address, MACAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../support/fastPing';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { NDP_DELAY_FIRST_PROBE_MS, NDP_REACHABLE_TIME_MS, type NeighborCache } from '@/network/devices/host/NeighborCache';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function wire() {
  const a = new LinuxPC('A', 0, 0);
  const b = new LinuxPC('B', 0, 0);
  new Cable('c').connect(a.getPort('eth0')!, b.getPort('eth0')!);
  a.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  b.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  a.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);
  b.configureIPv6Interface('eth0', new IPv6Address('2001:db8::2'), 64);
  return { a, b };
}

const sudo = (host: LinuxPC, command: string): Promise<string> => host.executeCommand(`sudo ${command}`);
const PING_B = 'ping -6 -c 1 -W 1 2001:db8::2';

const typeRow = (listing: string, icmpType: number): string =>
  listing.split('\n').find((line) => new RegExp(`ipv6-icmptype ${icmpType}(\\s|$)`).test(line)) ?? '';

const rowCount = (listing: string, icmpType: number): number => Number(typeRow(listing, icmpType).trim().split(/\s+/)[0]);

const sentMessages = (host: LinuxPC, event: string): number =>
  Logger.getLogsBySource(host.getId()).filter((log) => log.event === event).length;

const countOf = (listing: string, target: string): number => {
  const row = listing.split('\n').find((line) => new RegExp(`^\\s*\\d+\\s+\\d+\\s+${target}\\s`).test(line)) ?? '';
  return Number(row.trim().split(/\s+/)[0]);
};

describe('the INPUT chain of the destination sees the messages of neighbour discovery', () => {
  it('TEMOIN : with no rule the address is resolved and the ping answered', async () => {
    const { a } = wire();
    expect(await pingOnSimulatedClock(a, PING_B)).toContain('1 received');
  });

  it('a policy DROP that lets the echo in but not the solicitation cuts the link : the advertisement never comes', async () => {
    const { a, b } = wire();
    await sudo(b, 'ip6tables -P INPUT DROP');
    await sudo(b, 'ip6tables -A INPUT -p icmpv6 --icmpv6-type echo-request -j ACCEPT');
    expect(await pingOnSimulatedClock(a, PING_B)).toContain('100% packet loss');
  });

  it('ACCEPT of the two neighbour types in INPUT and OUTPUT gives the link back', async () => {
    const { a, b } = wire();
    await sudo(b, 'ip6tables -P INPUT DROP');
    await sudo(b, 'ip6tables -P OUTPUT DROP');
    await sudo(b, 'ip6tables -A INPUT -p icmpv6 --icmpv6-type neighbor-solicitation -j ACCEPT');
    await sudo(b, 'ip6tables -A OUTPUT -p icmpv6 --icmpv6-type neighbor-advertisement -j ACCEPT');
    await sudo(b, 'ip6tables -A INPUT -p icmpv6 --icmpv6-type echo-request -j ACCEPT');
    await sudo(b, 'ip6tables -A OUTPUT -p icmpv6 --icmpv6-type echo-reply -j ACCEPT');
    await sudo(b, 'ip6tables -A OUTPUT -p icmpv6 --icmpv6-type neighbor-solicitation -j ACCEPT');
    await sudo(b, 'ip6tables -A INPUT -p icmpv6 --icmpv6-type neighbor-advertisement -j ACCEPT');
    expect(await pingOnSimulatedClock(a, PING_B)).toContain('1 received');
  });

  it('a rule on the solicitation counts the one that A sent, and B answers it with an advertisement its OUTPUT rule counts', async () => {
    const { a, b } = wire();
    await sudo(b, 'ip6tables -A INPUT -p icmpv6 --icmpv6-type neighbor-solicitation -j ACCEPT');
    await sudo(b, 'ip6tables -A OUTPUT -p icmpv6 --icmpv6-type neighbor-advertisement -j ACCEPT');
    await pingOnSimulatedClock(a, PING_B);
    expect(countOf(await sudo(b, 'ip6tables -L INPUT -v -n'), 'ACCEPT')).toBe(1);
    expect(countOf(await sudo(b, 'ip6tables -L OUTPUT -v -n'), 'ACCEPT')).toBe(1);
  });

  it('the messages of neighbour discovery are UNTRACKED : not NEW, not INVALID', async () => {
    const { a, b } = wire();
    await sudo(b, 'ip6tables -A INPUT -m conntrack --ctstate UNTRACKED -p icmpv6 -j ACCEPT');
    await sudo(b, 'ip6tables -A INPUT -m conntrack --ctstate INVALID -p icmpv6 -j DROP');
    await pingOnSimulatedClock(a, PING_B);
    const listing = await sudo(b, 'ip6tables -L INPUT -v -n');
    expect(countOf(listing, 'ACCEPT')).toBeGreaterThanOrEqual(1);
    expect(countOf(listing, 'DROP')).toBe(0);
  });
});

describe('the OUTPUT chain of the sender sees the messages it sends', () => {
  it('a DROP of the solicitation in OUTPUT stops the resolution and counts every attempt', async () => {
    const { a } = wire();
    await sudo(a, 'ip6tables -A OUTPUT -p icmpv6 --icmpv6-type neighbor-solicitation -j DROP');
    expect(await pingOnSimulatedClock(a, PING_B)).toContain('100% packet loss');
    expect(countOf(await sudo(a, 'ip6tables -L OUTPUT -v -n'), 'DROP')).toBeGreaterThanOrEqual(1);
    expect(await a.executeCommand('ip -6 neigh show')).not.toContain('lladdr');
  });

  it('a router solicitation is a packet of the OUTPUT chain too : counted by the rule that decides it, once per message', async () => {
    const { a } = wire();
    const before = sentMessages(a, 'ndp:rs-sent');
    await sudo(a, 'ip6tables -A OUTPUT -p icmpv6 --icmpv6-type router-solicitation -j DROP');
    a.sendRouterSolicitation('eth0');
    expect(countOf(await sudo(a, 'ip6tables -L OUTPUT -v -n'), 'DROP')).toBe(1);
    expect(sentMessages(a, 'ndp:rs-sent')).toBe(before);
    await sudo(a, 'ip6tables -F OUTPUT');
    await sudo(a, 'ip6tables -A OUTPUT -p icmpv6 --icmpv6-type router-solicitation -j ACCEPT');
    a.sendRouterSolicitation('eth0');
    expect(countOf(await sudo(a, 'ip6tables -L OUTPUT -v -n'), 'ACCEPT')).toBe(1);
    expect(sentMessages(a, 'ndp:rs-sent')).toBe(before + 1);
  });

  it('the unicast probe that a stale neighbour gets is a packet of OUTPUT as well', async () => {
    const scheduler = new VirtualTimeScheduler();
    __setDefaultScheduler(scheduler);
    const { a } = wire();
    await pingOnSimulatedClock(a, PING_B);
    await sudo(a, 'ip6tables -A OUTPUT -p icmpv6 --icmpv6-type neighbor-solicitation -j ACCEPT');
    scheduler.advance(NDP_REACHABLE_TIME_MS + 1);
    (a as unknown as { neighborCache: NeighborCache }).neighborCache.markUsed('2001:db8::2');
    scheduler.advance(NDP_DELAY_FIRST_PROBE_MS + 1);
    expect(countOf(await sudo(a, 'ip6tables -L OUTPUT -v -n'), 'ACCEPT')).toBe(1);
  });

  it('a REJECT of the unicast probe is answered to the sender through lo, and INPUT counts the error', async () => {
    const scheduler = new VirtualTimeScheduler();
    __setDefaultScheduler(scheduler);
    const { a } = wire();
    await pingOnSimulatedClock(a, PING_B);
    await sudo(a, 'ip6tables -A OUTPUT -p icmpv6 --icmpv6-type neighbor-solicitation -j REJECT');
    await sudo(a, 'ip6tables -A INPUT -i lo -p icmpv6 -j ACCEPT');
    scheduler.advance(NDP_REACHABLE_TIME_MS + 1);
    (a as unknown as { neighborCache: NeighborCache }).neighborCache.markUsed('2001:db8::2');
    scheduler.advance(NDP_DELAY_FIRST_PROBE_MS + 1);
    expect(countOf(await sudo(a, 'ip6tables -L INPUT -v -n'), 'ACCEPT')).toBe(1);
  });

  it('a TCP connection over IPv6 resolves its neighbour through OUTPUT too : a DROP of the solicitation leaves it without a route to the host', async () => {
    const { a, b } = wire();
    await sudo(b, 'systemctl start ssh');
    await sudo(a, 'ip6tables -A OUTPUT -p icmpv6 --icmpv6-type neighbor-solicitation -j DROP');
    expect(await pingOnSimulatedClock(a, 'nc -6 -zv -w 2 2001:db8::2 22')).toContain('failed: No route to host');
    expect(countOf(await sudo(a, 'ip6tables -L OUTPUT -v -n'), 'DROP')).toBeGreaterThanOrEqual(1);
  });

  it('the trace says an advertisement was sent only when the chain let it out', async () => {
    const accepted = wire();
    await pingOnSimulatedClock(accepted.a, PING_B);
    expect(sentMessages(accepted.b, 'ndp:na-sent')).toBe(1);
    const refused = wire();
    await sudo(refused.b, 'ip6tables -A OUTPUT -p icmpv6 --icmpv6-type neighbor-advertisement -j DROP');
    await pingOnSimulatedClock(refused.a, PING_B);
    expect(sentMessages(refused.b, 'ndp:na-sent')).toBe(0);
  });

  it('REJECT in OUTPUT refuses the message like a DROP does, and says so to the sender', async () => {
    const { a } = wire();
    await sudo(a, 'ip6tables -A OUTPUT -p icmpv6 --icmpv6-type neighbor-solicitation -j REJECT');
    expect(await pingOnSimulatedClock(a, PING_B)).toContain('100% packet loss');
  });
});

describe('ufw lets the neighbour discovery through and keeps the echo under its own rules', () => {

  it('ufw enabled on B : the solicitation and the advertisement cross its chains, and the ping itself is refused by the default deny', async () => {
    const { a, b } = wire();
    await sudo(b, 'ufw enable');
    expect(await pingOnSimulatedClock(a, PING_B)).toContain('100% packet loss');
    expect(rowCount(await sudo(b, 'ip6tables -L ufw-before-input -v -n'), 135)).toBe(1);
    expect(rowCount(await sudo(b, 'ip6tables -L ufw-before-output -v -n'), 136)).toBe(1);
    const input = await sudo(b, 'ip6tables -L ufw-before-input -v -n');
    for (const type of [1, 2, 3, 4, 128]) expect(typeRow(input, type)).toBe('');
  });

  it('TEMOIN : ufw enabled with the sender allowed by the user lets the whole exchange through', async () => {
    const { a, b } = wire();
    await sudo(b, 'ufw enable');
    await sudo(b, 'ufw allow from 2001:db8::1');
    expect(await pingOnSimulatedClock(a, PING_B)).toContain('1 received');
  });
});

describe('the echo crosses OUTPUT before the neighbour is asked for', () => {
  const UNUSED = 'ping -6 -c 2 -W 1 2001:db8::99';
  const solicitationsAfter = async (command: string): Promise<number> => {
    const { a } = wire();
    await sudo(a, 'ip6tables -A OUTPUT -p icmpv6 --icmpv6-type neighbor-solicitation -j ACCEPT');
    await pingOnSimulatedClock(a, command);
    return countOf(await sudo(a, 'ip6tables -L OUTPUT -v -n'), 'ACCEPT');
  };

  it('a policy DROP refuses the echo first : no solicitation ever leaves, so none is counted', async () => {
    const { a } = wire();
    await sudo(a, 'ip6tables -A OUTPUT -p icmpv6 --icmpv6-type neighbor-solicitation -j ACCEPT');
    await sudo(a, 'ip6tables -P OUTPUT DROP');
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 1 -W 1 2001:db8::2');
    expect(out).toContain('1 packets transmitted, 0 received, 100% packet loss');
    expect(out).not.toContain('From ');
    expect(countOf(await sudo(a, 'ip6tables -L OUTPUT -v -n'), 'ACCEPT')).toBe(0);
  });

  it('a REJECT of the echo refuses it first as well : the error comes back and no solicitation is counted', async () => {
    const { a } = wire();
    await sudo(a, 'ip6tables -A OUTPUT -p icmpv6 --icmpv6-type neighbor-solicitation -j ACCEPT');
    await sudo(a, 'ip6tables -A OUTPUT -p icmpv6 --icmpv6-type echo-request -j REJECT');
    const out = await pingOnSimulatedClock(a, 'ping -6 -c 1 -W 1 2001:db8::2');
    expect(out).toContain('1 packets transmitted, 0 received');
    expect(countOf(await sudo(a, 'ip6tables -L OUTPUT -v -n'), 'ACCEPT')).toBe(0);
  });

  it('TEMOIN : with the echo accepted the solicitation leaves, and is counted', async () => {
    expect(await solicitationsAfter('ping -6 -c 1 -W 1 2001:db8::2')).toBe(1);
  });

  it('an address nobody owns : every probe reports « Address unreachable » from our own address', async () => {
    const { a } = wire();
    const out = await pingOnSimulatedClock(a, UNUSED);
    expect(out).toContain('From 2001:db8::1 icmp_seq=1 Destination unreachable: Address unreachable');
    expect(out).toContain('From 2001:db8::1 icmp_seq=2 Destination unreachable: Address unreachable');
    expect(out).toContain('2 packets transmitted, 0 received, +2 errors, 100% packet loss');
  });

  it('and the engine asks for the neighbour once for the whole sequence, not once per probe', async () => {
    const { a } = wire();
    await sudo(a, 'ip6tables -A OUTPUT -p icmpv6 --icmpv6-type neighbor-solicitation -j ACCEPT');
    const engine = a as unknown as { executePing6Sequence(target: IPv6Address, count: number, timeoutMs: number, options: object): Promise<Array<{ error?: string }>> };
    const results = await engine.executePing6Sequence(new IPv6Address('2001:db8::99'), 3, 500, {});
    expect(results.map((result) => result.error)).toEqual(Array(3).fill('Destination unreachable (from 2001:db8::1)'));
    expect(countOf(await sudo(a, 'ip6tables -L OUTPUT -v -n'), 'ACCEPT')).toBe(1);
  });
});

describe('ufw needs the neighbour discovery from its own side too', () => {
  it('ufw enabled on the sender : the advertisement it waits for crosses ufw-before-input, and the ping goes through', async () => {
    const { a } = wire();
    await sudo(a, 'ufw enable');
    expect(await pingOnSimulatedClock(a, PING_B)).toContain('1 received');
    expect(rowCount(await sudo(a, 'ip6tables -L ufw-before-input -v -n'), 136)).toBe(1);
  });

  it('ufw with the outgoing traffic denied : the solicitation crosses ufw-before-output, the user rule carries the echo', async () => {
    const { a } = wire();
    await sudo(a, 'ufw enable');
    await sudo(a, 'ufw default deny outgoing');
    await sudo(a, 'ufw allow out from any to 2001:db8::2');
    expect(await pingOnSimulatedClock(a, PING_B)).toContain('1 received');
    expect(rowCount(await sudo(a, 'ip6tables -L ufw-before-output -v -n'), 135)).toBe(1);
  });

  it('TEMOIN : with the outgoing traffic denied and no rule for the destination, the echo itself is refused', async () => {
    const { a } = wire();
    await sudo(a, 'ufw enable');
    await sudo(a, 'ufw default deny outgoing');
    expect(await pingOnSimulatedClock(a, PING_B)).toContain('100% packet loss');
  });
});

describe('ufw lets a router advertisement in and a router solicitation out', () => {
  async function routerLab(prepare: (host: LinuxPC) => Promise<void>, cableFirst: boolean) {
    const router = new CiscoRouter('R1');
    const host = new LinuxPC('H');
    host.powerOn();
    await prepare(host);
    const cable = (): void => {
      new Cable('c').connect(router.getPort('GigabitEthernet0/0')!, host.getPort('eth0')!);
    };
    if (cableFirst) cable();
    for (const line of ['enable', 'configure terminal', 'ipv6 unicast-routing', 'interface GigabitEthernet0/0', 'ipv6 address 2001:db8::1/64', 'no shutdown', 'end']) {
      await router.executeCommand(line);
    }
    if (!cableFirst) cable();
    return host;
  }

  const AUTOCONFIGURED = /inet6 2001:db8::[0-9a-f:]+\/64 scope global/;

  it('the unsolicited advertisement crosses ufw-before-input : the host autoconfigures under a default deny', async () => {
    const host = await routerLab(async (h) => { await sudo(h, 'ufw enable'); }, true);
    expect(await host.executeCommand('ip -6 addr show')).toMatch(AUTOCONFIGURED);
  });

  it('the solicitation sent at link-up crosses ufw-before-output : the host still gets its answer with the outgoing traffic denied', async () => {
    const host = await routerLab(async (h) => {
      await sudo(h, 'ufw enable');
      await sudo(h, 'ufw default deny outgoing');
    }, false);
    expect(await host.executeCommand('ip -6 addr show')).toMatch(AUTOCONFIGURED);
    expect(rowCount(await sudo(host, 'ip6tables -L ufw-before-output -v -n'), 133)).toBe(1);
  });

  it('a policy DROP in INPUT keeps the advertisement out : no autoconfiguration', async () => {
    const host = await routerLab(async (h) => { await sudo(h, 'ip6tables -P INPUT DROP'); }, true);
    expect(await host.executeCommand('ip -6 addr show')).not.toMatch(AUTOCONFIGURED);
  });

  it('and a rule that accepts the advertisement gives the autoconfiguration back', async () => {
    const host = await routerLab(async (h) => {
      await sudo(h, 'ip6tables -P INPUT DROP');
      await sudo(h, 'ip6tables -A INPUT -p icmpv6 --icmpv6-type router-advertisement -j ACCEPT');
    }, true);
    expect(await host.executeCommand('ip -6 addr show')).toMatch(AUTOCONFIGURED);
  });

  it('TEMOIN : with no ufw the same lab autoconfigures, so the lab is sound', async () => {
    const host = await routerLab(async () => undefined, true);
    expect(await host.executeCommand('ip -6 addr show')).toMatch(AUTOCONFIGURED);
  });
});

describe('the default before6.rules says what the Ubuntu file says about ICMPv6', () => {
  it('the error and echo accepts, then the neighbour accepts, in the order of the file', async () => {
    const { a } = wire();
    const lines = (await sudo(a, 'cat /etc/ufw/before6.rules')).split('\n').filter((line) => line.includes('-p icmpv6'));
    expect(lines).toEqual([
      '-A ufw6-before-input -p icmpv6 --icmpv6-type destination-unreachable -j ACCEPT',
      '-A ufw6-before-input -p icmpv6 --icmpv6-type packet-too-big -j ACCEPT',
      '-A ufw6-before-input -p icmpv6 --icmpv6-type time-exceeded -j ACCEPT',
      '-A ufw6-before-input -p icmpv6 --icmpv6-type parameter-problem -j ACCEPT',
      '-A ufw6-before-input -p icmpv6 --icmpv6-type echo-request -j ACCEPT',
      '-A ufw6-before-input -p icmpv6 --icmpv6-type router-solicitation -j ACCEPT',
      '-A ufw6-before-input -p icmpv6 --icmpv6-type router-advertisement -j ACCEPT',
      '-A ufw6-before-input -p icmpv6 --icmpv6-type neighbor-solicitation -j ACCEPT',
      '-A ufw6-before-input -p icmpv6 --icmpv6-type neighbor-advertisement -j ACCEPT',
      '-A ufw6-before-input -p icmpv6 --icmpv6-type redirect -j ACCEPT',
      '-A ufw6-before-output -p icmpv6 --icmpv6-type router-solicitation -j ACCEPT',
      '-A ufw6-before-output -p icmpv6 --icmpv6-type neighbor-solicitation -j ACCEPT',
      '-A ufw6-before-output -p icmpv6 --icmpv6-type neighbor-advertisement -j ACCEPT',
    ]);
  });
});
