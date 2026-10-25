/**
 * La table nat se parcourt comme n'importe quelle table netfilter : la premiere regle qui decide termine le parcours de la chaine
 * (ACCEPT : pas de traduction ; DROP : le paquet meurt ; DNAT, SNAT, MASQUERADE, REDIRECT : la traduction), un saut `-j CHAINE` entre dans
 * la chaine utilisateur et en revient au RETURN ou a la fin, un `-g` n'en revient pas, et un paquet que personne ne decide tombe sur la
 * politique. Le crochet de la table nat avait sa propre boucle : un ACCEPT ou un RETURN ne terminait rien (la regle suivante etait quand
 * meme lue), un saut vers une chaine utilisateur n'etait jamais suivi (`-j DOCKER` ne traduisait donc plus rien), DROP n'existait pas, et
 * la boucle du filtre, qui sait deja tout cela, n'etait pas reutilisee. Les cibles de traduction sont de la table nat, REJECT de la table
 * filter : le noyau refuse l'autre placement a l'insertion (`xt_DNAT` : « only valid in nat table, not filter »).
 *
 * Mesure de depart (32f6d9e9, deux LinuxPC sur un lien, les crochets appeles comme le plan de donnees les appelle) :
 *     -t nat -A PREROUTING -p tcp --dport 80 -j ACCEPT, puis -j DNAT --to-destination 10.0.0.9:8080
 *                                                    ->  un SYN vers 80 est translate ; les deux regles comptent le paquet
 *     -t nat -N DOCKER ; -A PREROUTING -j DOCKER ; -A DOCKER -p tcp --dport 8080 -j DNAT --to-destination 10.0.0.9:80
 *                                                    ->  aucune traduction ; la regle de DOCKER compte 0
 *     -t nat -A PREROUTING -p tcp --dport 80 -g CHAINE vide, puis -j DNAT   ->  translate (le noyau s'arrete : un `-g` ne revient pas)
 *     -t nat -A PREROUTING -p icmp -j DROP           ->  le ping de B repond
 *     -t nat -A POSTROUTING -j DROP sur une passerelle  ->  le ping traverse
 *     iptables -A INPUT -j DNAT --to-destination 10.0.0.9      ->  accepte (table filter)
 *     iptables -t nat -A PREROUTING -j REJECT                  ->  accepte
 *
 * Autorites : noyau Linux 6.1 -- net/netfilter/nf_nat_core.c (nf_nat_inet_fn : les chaines nat sont celles de la table, leur verdict
 * NF_ACCEPT laisse le paquet sans traduction, NF_DROP le jette), net/netfilter/x_tables.c (xt_check_target : la cible declare sa table
 * et ses crochets), xt_nat.c (`.table = "nat"`), ipt_REJECT.c (`.table = "filter"`) ; iptables 1.8.7 (libiptc, regle de saut `-j`/`-g`).
 *
 * Discrimination : contre l'arbre sans le lot (sources remises a leur etat, sonde conservee), 16 des 25 cas tombent et 9 passent des deux
 * cotes : trois TEMOINS (un ACCEPT qui ne correspond pas laisse la traduction a la regle suivante, une chaine utilisateur qui ne prend pas
 * le paquet le rend a l'appelant, les memes cibles dans leur propre table sont acceptees), la premiere traduction qui correspond gagne
 * (deja vrai), la politique compte ce qu'aucune regle ne decide (E1d), RETURN rend le paquet a la regle qui suit le saut (coincidence :
 * le saut n'etait pas suivi, donc la regle suivante etait lue de toute facon) et les trois cas de non-regression qui lisent l'adresse que
 * la regle nomme (SNAT, REDIRECT sous ses deux orthographes : l'ancienne boucle la rendait deja).
 *
 * Depuis la chaine OUTPUT de nat des paquets que la machine ouvre, l'UDP passe par le suivi comme le TCP : la table n'est lue que pour le
 * premier paquet d'un flux (`nf_nat_inet_fn`, « Already setup manip »). Le cas OUTPUT de DROP envoie donc son second datagramme depuis un autre
 * port source -- un flux neuf --, qui seul est refuse, et un cas de plus tient la regle du noyau : un flux deja etabli n'est pas relu. Le
 * fichier compte 26 cas ; l'ancien cas supposait que chaque datagramme relisait la table, ce qui n'est pas ce que fait le noyau.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, MACAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { hooksOf, tcp4, tcp6 } from '../../support/natHooks';
import { pingOnSimulatedClock } from '../../support/fastPing';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const SYN = { syn: true };
interface Shell { executeCommand(command: string): Promise<string> | string }

const sudo = async (host: Shell, command: string): Promise<string> => host.executeCommand(`sudo ${command}`);

async function nat(host: Shell, ...rules: string[]): Promise<void> {
  for (const rule of rules) expect(await sudo(host, `iptables -t nat ${rule}`)).toBe('');
}

const counted = (listing: string, target: string, protocol = 'tcp'): number => {
  const row = listing.split('\n').find((line) => new RegExp(`^\\s*\\d+\\s+\\d+\\s+${target}\\s+${protocol}\\s`).test(line)) ?? '';
  return Number(row.trim().split(/\s+/)[0]);
};

describe('the first rule that decides ends the traversal of the chain', () => {
  it('ACCEPT keeps the packet untranslated and the rules behind it unread', async () => {
    const host = new LinuxPC('H', 0, 0);
    await nat(host, '-A PREROUTING -p tcp --dport 80 -j ACCEPT', '-A PREROUTING -p tcp --dport 80 -j DNAT --to-destination 10.0.0.9:8080');
    expect(hooksOf(host).evaluatePreRouting('eth0', tcp4(SYN))).toBeNull();
    const listing = await sudo(host, 'iptables -t nat -L PREROUTING -v -n');
    expect(counted(listing, 'ACCEPT')).toBe(1);
    expect(counted(listing, 'DNAT')).toBe(0);
  });

  it('TEMOIN : an ACCEPT that does not match leaves the translation to the rule behind it', async () => {
    const host = new LinuxPC('H', 0, 0);
    await nat(host, '-A PREROUTING -p tcp --dport 22 -j ACCEPT', '-A PREROUTING -p tcp --dport 80 -j DNAT --to-destination 10.0.0.9:8080');
    expect(hooksOf(host).evaluatePreRouting('eth0', tcp4(SYN))).toEqual({ action: 'DNAT', address: '10.0.0.9:8080' });
  });

  it('the translation of the first matching rule wins over the second one', async () => {
    const host = new LinuxPC('H', 0, 0);
    await nat(host, '-A PREROUTING -p tcp --dport 80 -j DNAT --to-destination 10.0.0.7', '-A PREROUTING -p tcp --dport 80 -j DNAT --to-destination 10.0.0.8');
    expect(hooksOf(host).evaluatePreRouting('eth0', tcp4(SYN))).toEqual({ action: 'DNAT', address: '10.0.0.7' });
    expect(counted(await sudo(host, 'iptables -t nat -L PREROUTING -v -n'), 'DNAT')).toBe(1);
  });

  it('DROP is a decision of the chain : the hook reports it', async () => {
    const host = new LinuxPC('H', 0, 0);
    await nat(host, '-A PREROUTING -p tcp --dport 80 -j DROP', '-A PREROUTING -p tcp --dport 80 -j DNAT --to-destination 10.0.0.9');
    expect(hooksOf(host).evaluatePreRouting('eth0', tcp4(SYN))).toEqual({ action: 'DROP' });
    expect(hooksOf(host).evaluatePreRouting('eth0', tcp4(SYN, 22))).toBeNull();
  });

  it('a packet that no rule decides falls on the policy, and the policy counts it', async () => {
    const host = new LinuxPC('H', 0, 0);
    await nat(host, '-A PREROUTING -p tcp --dport 22 -j DNAT --to-destination 10.0.0.9');
    expect(hooksOf(host).evaluatePreRouting('eth0', tcp4(SYN))).toBeNull();
    expect(await sudo(host, 'iptables -t nat -L PREROUTING -v -n')).toMatch(/^Chain PREROUTING \(policy ACCEPT 1 packets, \d+ bytes\)$/m);
  });
});

describe('every translation target reports the address its rule names', () => {
  it('SNAT --to-source', async () => {
    const host = new LinuxPC('H', 0, 0);
    await nat(host, '-A POSTROUTING -p tcp --dport 80 -j SNAT --to-source 203.0.113.9');
    expect(hooksOf(host).evaluateNat(tcp4(SYN), 'eth0', 'eth1')).toEqual({ action: 'SNAT', address: '203.0.113.9' });
  });

  it.each(['--to-ports', '--to-port'])('REDIRECT %s', async (option) => {
    const host = new LinuxPC('H', 0, 0);
    await nat(host, `-A PREROUTING -p tcp --dport 80 -j REDIRECT ${option} 8081`);
    expect(hooksOf(host).evaluatePreRouting('eth0', tcp4(SYN))).toEqual({ action: 'REDIRECT', address: '8081' });
  });
});

describe('a jump enters the user chain, comes back at RETURN or at its end, and a goto does not come back', () => {
  it('-j CHAIN : the translation set inside the chain is the one the hook reports, and both rules count the packet', async () => {
    const host = new LinuxPC('H', 0, 0);
    await nat(host, '-N DOCKER', '-A PREROUTING -j DOCKER', '-A DOCKER -p tcp --dport 8080 -j DNAT --to-destination 10.0.0.9:80');
    expect(hooksOf(host).evaluatePreRouting('eth0', tcp4(SYN, 8080))).toEqual({ action: 'DNAT', address: '10.0.0.9:80' });
    const listing = await sudo(host, 'iptables -t nat -L -v -n');
    expect(counted(listing, 'DOCKER', 'all')).toBe(1);
    expect(counted(listing, 'DNAT')).toBe(1);
  });

  it('TEMOIN : a packet the user chain does not take goes on with the caller', async () => {
    const host = new LinuxPC('H', 0, 0);
    await nat(host, '-N DOCKER', '-A PREROUTING -j DOCKER', '-A DOCKER -p tcp --dport 8080 -j DNAT --to-destination 10.0.0.9:80', '-A PREROUTING -p tcp --dport 22 -j DNAT --to-destination 10.0.0.7');
    expect(hooksOf(host).evaluatePreRouting('eth0', tcp4(SYN, 22))).toEqual({ action: 'DNAT', address: '10.0.0.7' });
  });

  it('RETURN gives the packet back to the rule that follows the jump', async () => {
    const host = new LinuxPC('H', 0, 0);
    await nat(host, '-N BACK', '-A BACK -j RETURN', '-A PREROUTING -p tcp --dport 80 -j BACK', '-A PREROUTING -p tcp --dport 80 -j DNAT --to-destination 10.0.0.9');
    expect(hooksOf(host).evaluatePreRouting('eth0', tcp4(SYN))).toEqual({ action: 'DNAT', address: '10.0.0.9' });
  });

  it('-g does not give it back : the end of the goto chain is the end of the caller', async () => {
    const host = new LinuxPC('H', 0, 0);
    await nat(host, '-N AWAY', '-A PREROUTING -p tcp --dport 80 -g AWAY', '-A PREROUTING -p tcp --dport 80 -j DNAT --to-destination 10.0.0.9');
    expect(hooksOf(host).evaluatePreRouting('eth0', tcp4(SYN))).toBeNull();
  });

  it('the same chain is read by the three hooks that read a table of this kind : OUTPUT and POSTROUTING jump too', async () => {
    const host = new LinuxPC('H', 0, 0);
    await nat(host, '-N SNATS', '-A POSTROUTING -j SNATS', '-A SNATS -p tcp --dport 80 -j MASQUERADE');
    expect(hooksOf(host).evaluateNat(tcp4(SYN), 'eth0', 'eth1')).toEqual({ action: 'MASQUERADE' });
  });

  it('IPv6 follows the same rules : a jump, an ACCEPT, a DROP', async () => {
    const host = new LinuxPC('H', 0, 0);
    await sudo(host, 'ip6tables -t nat -N V6');
    await sudo(host, 'ip6tables -t nat -A PREROUTING -j V6');
    await sudo(host, 'ip6tables -t nat -A V6 -p tcp --dport 80 -j REDIRECT --to-ports 8080');
    expect(hooksOf(host).evaluatePreRouting6('eth0', tcp6(SYN))).toEqual({ action: 'REDIRECT', address: '8080' });
    await sudo(host, 'ip6tables -t nat -I V6 1 -p tcp --dport 80 -j DROP');
    expect(hooksOf(host).evaluatePreRouting6('eth0', tcp6(SYN))).toEqual({ action: 'DROP' });
  });
});

describe('a DROP of the nat table kills the packet where the hook stands', () => {
  function pair() {
    const a = new LinuxPC('A', 0, 0);
    const b = new LinuxPC('B', 0, 0);
    new Cable('c').connect(a.getPort('eth0')!, b.getPort('eth0')!);
    a.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    b.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    return { a, b };
  }

  it('PREROUTING : the echo request never reaches the host, so nobody answers', async () => {
    const { a, b } = pair();
    expect(await pingOnSimulatedClock(a, 'ping -c 1 -W 1 10.0.0.2')).toContain('1 received');
    await nat(b, '-A PREROUTING -p icmp -j DROP');
    expect(await pingOnSimulatedClock(a, 'ping -c 1 -W 1 10.0.0.2')).toContain('100% packet loss');
  });

  it('OUTPUT : the datagram the host sends is refused, like a DROP of the filter table', async () => {
    const { a, b } = pair();
    b.udpListen(5000, 'probe', {});
    expect(a.sendUdpDatagram(new IPAddress('10.0.0.2'), 5000, 4000, 'x', 1)).toBe(true);
    await nat(a, '-A OUTPUT -p udp --dport 5000 -j DROP');
    expect(a.sendUdpDatagram(new IPAddress('10.0.0.2'), 5000, 4001, 'x', 1)).toBe(false);
    expect(a.sendUdpDatagram(new IPAddress('10.0.0.2'), 5001, 4001, 'x', 1)).toBe(true);
  });

  it('OUTPUT : a flow already set up is not read again, so a rule added afterwards does not refuse its datagrams', async () => {
    const { a, b } = pair();
    b.udpListen(5000, 'probe', {});
    expect(a.sendUdpDatagram(new IPAddress('10.0.0.2'), 5000, 4000, 'x', 1)).toBe(true);
    await nat(a, '-A OUTPUT -p udp --dport 5000 -j DROP');
    expect(a.sendUdpDatagram(new IPAddress('10.0.0.2'), 5000, 4000, 'x', 1)).toBe(true);
  });

  it('POSTROUTING : the packet a gateway forwards dies on the way out', async () => {
    const source = new LinuxPC('linux-pc', 'SRC');
    const gateway = new LinuxServer('linux-server', 'GW');
    const destination = new LinuxPC('linux-pc', 'DST');
    source.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    gateway.configureInterface('eth0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    gateway.configureInterface('eth1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));
    destination.configureInterface('eth0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
    source.setDefaultGateway(new IPAddress('10.0.1.1'));
    destination.setDefaultGateway(new IPAddress('10.0.2.1'));
    new Cable('c1').connect(source.getPort('eth0')!, gateway.getPort('eth0')!);
    new Cable('c2').connect(gateway.getPort('eth1')!, destination.getPort('eth0')!);
    await gateway.executeCommand('sysctl -w net.ipv4.ip_forward=1');
    expect(await pingOnSimulatedClock(source, 'ping -c 1 -W 1 10.0.2.2')).toContain('1 received');
    await nat(gateway, '-A POSTROUTING -o eth1 -j DROP');
    expect(await pingOnSimulatedClock(source, 'ping -c 1 -W 1 10.0.2.2')).toContain('100% packet loss');
  });
});

describe('a target lives in its own table : the kernel refuses the other placements at insertion', () => {
  const REFUSED = 'iptables v1.8.7 (nf_tables):  RULE_APPEND failed (Invalid argument): rule in chain';

  it.each([
    ['DNAT in the filter table', 'iptables -A INPUT -j DNAT --to-destination 10.0.0.9', `${REFUSED} INPUT`],
    ['SNAT in the filter table', 'iptables -A OUTPUT -j SNAT --to-source 10.0.0.9', `${REFUSED} OUTPUT`],
    ['MASQUERADE in the mangle table', 'iptables -t mangle -A POSTROUTING -j MASQUERADE', `${REFUSED} POSTROUTING`],
    ['REDIRECT in the filter table', 'iptables -A INPUT -p tcp -j REDIRECT --to-ports 8080', `${REFUSED} INPUT`],
    ['REJECT in the nat table', 'iptables -t nat -A PREROUTING -j REJECT', `${REFUSED} PREROUTING`],
    ['REJECT in the mangle table', 'iptables -t mangle -A FORWARD -j REJECT', `${REFUSED} FORWARD`],
  ])('%s', async (_name, command, expected) => {
    const host = new LinuxPC('H', 0, 0);
    expect(await sudo(host, command)).toBe(expected);
  });

  it('TEMOIN : the same targets in their own table are accepted', async () => {
    const host = new LinuxPC('H', 0, 0);
    expect(await sudo(host, 'iptables -t nat -A PREROUTING -j DNAT --to-destination 10.0.0.9')).toBe('');
    expect(await sudo(host, 'iptables -A INPUT -p tcp --dport 22 -j REJECT')).toBe('');
  });

  it('ip6tables says the same with its own name', async () => {
    const host = new LinuxPC('H', 0, 0);
    expect(await sudo(host, 'ip6tables -A INPUT -j DNAT --to-destination 2001:db8::9')).toBe(
      'ip6tables v1.8.7 (nf_tables):  RULE_APPEND failed (Invalid argument): rule in chain INPUT',
    );
  });
});
