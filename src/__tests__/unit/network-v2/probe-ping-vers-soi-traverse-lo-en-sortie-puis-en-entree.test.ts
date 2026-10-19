/**
 * Un paquet qu'une machine s'adresse a elle-meme (127.0.0.1, ::1, ou une adresse qu'elle porte) n'est pas un cas a part pour netfilter : il
 * sort par `lo` (chaine OUTPUT, interface de sortie `lo`), rentre par `lo` (chaine INPUT, interface d'entree `lo`), et la reponse que le
 * noyau fabrique refait le meme trajet. Chaque trajet compte un paquet emis ET un paquet recu sur `lo` (`/proc/net/dev`, `ip -s link`),
 * octets d'IP seuls (loopback_xmit compte `skb->len` apres `eth_type_trans`). Le MTU de `lo` borne l'envoi comme celui de n'importe quelle
 * interface, et 65535 octets d'IP bornent tout datagramme (`__ip_append_data` : EMSGSIZE, `mtu` = celui de la route).
 *
 * Mesure de depart (2da9bf8d + lots precedents ; un LinuxPC, 10.0.0.1/24 et 2001:db8::1/64) :
 *     iptables -A OUTPUT -o lo -j DROP        ->  ping 127.0.0.1 et ping 10.0.0.1 repondent ; le compteur de la regle reste a 0
 *     iptables -A INPUT -i lo -j DROP         ->  ping 127.0.0.1 repond
 *     iptables -A INPUT -p icmp --icmp-type echo-request -j DROP  ->  ping 127.0.0.1 repond
 *     ip6tables -A OUTPUT -o lo -j DROP       ->  ping -6 ::1 et ping -6 2001:db8::1 repondent
 *     ping -c 3 127.0.0.1                     ->  /proc/net/dev : lo a 0 octet et 0 paquet ; `ip -s link show lo` de meme
 *     ping -s 65508 127.0.0.1                 ->  65516 octets de reponse (un datagramme IP de 65536 octets n'existe pas)
 *     ping -M do -s 65508 127.0.0.1           ->  idem
 *     ping -6 -M do -s 1453 2001:db8::77 (on-link, personne)  ->  l'attente du voisin puis « Address unreachable » au lieu de l'erreur locale
 * La reponse etait FABRIQUEE (`localEchoResults`) : aucun paquet n'etait construit, donc aucune chaine, aucun compteur, aucune taille.
 * Le trafic UDP vers soi-meme (`sendUdpDatagram`, `sendUdpDatagram6`) et les erreurs ICMP rebouclees ne consultaient que OUTPUT (les
 * erreurs) ou rien du tout (UDP), alors que le TCP local passait deja par OUTPUT puis INPUT.
 *
 * Autorites : noyau Linux 6.1 -- net/ipv4/ip_output.c (__ip_append_data : EMSGSIZE et ip_local_error avec le MTU de la route),
 * net/core/dev.c et drivers/net/loopback.c (loopback_xmit : `len = skb->len` apres eth_type_trans, donc des octets d'IP), net/ipv4/
 * netfilter/nf_reject_ipv4.c et net/ipv6/netfilter/nf_reject_ipv6.c (le paquet rejete en INPUT recoit l'erreur par `lo`),
 * net/ipv4/icmp.c __icmp_send (« Assume any unknown ICMP type is an error » : pas d'erreur sur une erreur) ; iputils 20221126 ping.c
 * (ping4_receive_error_msg : « local error: message too long, mtu=%u », « From %s icmp_seq=%u ») et ping_common.c (pinger).
 * Windows : le pare-feu ne filtre pas le bouclage (la sonde le verifie, elle n'invente pas de regle).
 *
 * Discrimination : 52 des 75 cas tombent contre l'etat precedent (les sources remises a leur etat, la sonde et son support conserves).
 * Vingt-trois passent des deux cotes : quatre TEMOINS (sans regle la sonde est repondue, en v4 et en v6, vers la boucle et vers l'adresse
 * portee), six bornes de taille que l'etat precedent tenait deja (65507 octets de donnees en IPv4, les quatre bornes IPv6), le temoin
 * « eth0 ne porte rien de ce trafic », la requete que OUTPUT refuse (zero paquet compte avant comme apres : coincidence), le temoin du
 * RTT (un voisin est chronometre sur le fil, seul un envoi local est plancher a 0,01 ms), les deux cas « un envoi refuse n'attend pas de
 * reponse » (la reponse fabriquee n'attendait pas non plus : coincidence), les quatre cas de cadence de Linux apres une erreur ou un
 * silence et les deux de Windows (code deplace sans changement : non-regression), le temoin Windows (rien n'etait filtre avant, et la
 * sonde interdit que cela change) et le cas IPv4 de l'ordre « la route decide avant le voisin » (la commande ping decidait avant tout,
 * le moteur doit garder cet ordre : non-regression -- la premiere version du deplacement le perdait, et le cas tombe contre elle).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { ETHERTYPE_ARP, ETHERTYPE_IPV6, IPAddress, IPv6Address, MACAddress, SubnetMask, resetCounters, type EthernetFrame } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock, timedOnSimulatedClock } from '../../support/fastPing';
import { framesSentOn } from '../../support/wireWatch';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function machine(): LinuxPC {
  const host = new LinuxPC('H', 0, 0);
  host.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  host.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);
  return host;
}

function machineWithPeer(): { host: LinuxPC; peer: LinuxPC } {
  const host = machine();
  const peer = new LinuxPC('P', 0, 0);
  new Cable('c').connect(host.getPort('eth0')!, peer.getPort('eth0')!);
  peer.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { host, peer };
}

const sudo = (host: LinuxPC, command: string): Promise<string> => host.executeCommand(`sudo ${command}`);

const SENDMSG = 'ping: sendmsg: Operation not permitted';

interface Family {
  readonly name: string;
  readonly tool: 'iptables' | 'ip6tables';
  readonly icmp: 'icmp' | 'icmpv6';
  readonly typeOption: '--icmp-type' | '--icmpv6-type';
  readonly pingCommand: (target: string) => string;
  readonly targets: readonly (readonly [string, string])[];
  readonly packetBytes: number;
  readonly errorFrom: (target: string) => string;
  readonly unreachable: string;
}

const FAMILIES: readonly Family[] = [
  {
    name: 'IPv4', tool: 'iptables', icmp: 'icmp', typeOption: '--icmp-type',
    pingCommand: (target) => `ping -c 1 -W 1 ${target}`,
    targets: [['loopback', '127.0.0.1'], ['own address', '10.0.0.1']],
    packetBytes: 84, errorFrom: (target) => `From ${target}`, unreachable: 'Destination Port Unreachable',
  },
  {
    name: 'IPv6', tool: 'ip6tables', icmp: 'icmpv6', typeOption: '--icmpv6-type',
    pingCommand: (target) => `ping -6 -c 1 -W 1 ${target}`,
    targets: [['loopback', '::1'], ['own address', '2001:db8::1']],
    packetBytes: 104, errorFrom: (target) => `From ${target}`, unreachable: 'Destination unreachable: Port unreachable',
  },
];

function chainLine(listing: string, targetName: string): string {
  return listing.split('\n').find((line) => new RegExp(`^\\s*\\d+\\s+\\d+\\s+${targetName}\\s`).test(line)) ?? '';
}

const counters = (line: string): [number, number] => {
  const match = /^\s*(\d+)\s+(\d+)\s/.exec(line);
  return match === null ? [-1, -1] : [Number(match[1]), Number(match[2])];
};

describe.each(FAMILIES)('$name : a ping to oneself crosses OUTPUT, then INPUT, for the request and for the reply', (family) => {
  describe.each(family.targets)('target %s', (_label, target) => {
    const probe = family.pingCommand(target);

    it('TEMOIN : with no rule the probe is answered and every rule below is what removes the answer', async () => {
      const host = machine();
      expect(await pingOnSimulatedClock(host, probe)).toContain(`64 bytes from ${target}: icmp_seq=1`);
    });

    it('a DROP on lo in OUTPUT refuses the send : nothing printed, one packet counted, INPUT never reached', async () => {
      const host = machine();
      await sudo(host, `${family.tool} -A OUTPUT -o lo -j DROP`);
      await sudo(host, `${family.tool} -A INPUT -j ACCEPT`);
      const out = await pingOnSimulatedClock(host, probe);
      expect(out).not.toContain('bytes from');
      expect(out).not.toContain('sendmsg');
      expect(out).toContain('1 packets transmitted, 0 received, 100% packet loss');
      expect(counters(chainLine(await sudo(host, `${family.tool} -L OUTPUT -v -n`), 'DROP'))).toEqual([1, family.packetBytes]);
      expect(counters(chainLine(await sudo(host, `${family.tool} -L INPUT -v -n`), 'ACCEPT'))).toEqual([0, 0]);
    });

    it('a DROP on lo in INPUT loses the request after it left : one packet counted in each chain', async () => {
      const host = machine();
      await sudo(host, `${family.tool} -A OUTPUT -o lo -j ACCEPT`);
      await sudo(host, `${family.tool} -A INPUT -i lo -j DROP`);
      const out = await pingOnSimulatedClock(host, probe);
      expect(out).not.toContain('bytes from');
      expect(out).toContain('1 packets transmitted, 0 received, 100% packet loss');
      expect(counters(chainLine(await sudo(host, `${family.tool} -L OUTPUT -v -n`), 'ACCEPT'))).toEqual([1, family.packetBytes]);
      expect(counters(chainLine(await sudo(host, `${family.tool} -L INPUT -v -n`), 'DROP'))).toEqual([1, family.packetBytes]);
    });

    it.each(['echo-request', 'echo-reply'])('a DROP on the %s type in INPUT is enough to lose the probe', async (type) => {
      const host = machine();
      await sudo(host, `${family.tool} -A INPUT -p ${family.icmp} ${family.typeOption} ${type} -j DROP`);
      const out = await pingOnSimulatedClock(host, probe);
      expect(out).not.toContain('bytes from');
      expect(out).toContain('1 packets transmitted, 0 received, 100% packet loss');
    });

    it('a DROP on echo-reply in OUTPUT lets the request in and loses the answer that the kernel builds', async () => {
      const host = machine();
      await sudo(host, `${family.tool} -A INPUT -p ${family.icmp} ${family.typeOption} echo-request -j ACCEPT`);
      await sudo(host, `${family.tool} -A OUTPUT -p ${family.icmp} ${family.typeOption} echo-reply -j DROP`);
      const out = await pingOnSimulatedClock(host, probe);
      expect(out).not.toContain('bytes from');
      expect(out).not.toContain('sendmsg');
      expect(out).toContain('1 packets transmitted, 0 received, 100% packet loss');
      expect(counters(chainLine(await sudo(host, `${family.tool} -L INPUT -v -n`), 'ACCEPT'))).toEqual([1, family.packetBytes]);
      expect(counters(chainLine(await sudo(host, `${family.tool} -L OUTPUT -v -n`), 'DROP'))).toEqual([1, family.packetBytes]);
    });

    it('TEMOIN : a rule on another message type changes nothing, and the rule removed gives the answer back', async () => {
      const host = machine();
      await sudo(host, `${family.tool} -A INPUT -p ${family.icmp} ${family.typeOption} destination-unreachable -j DROP`);
      expect(await pingOnSimulatedClock(host, probe)).toContain(`64 bytes from ${target}: icmp_seq=1`);
      await sudo(host, `${family.tool} -A INPUT -j DROP`);
      expect(await pingOnSimulatedClock(host, probe)).not.toContain('bytes from');
      await sudo(host, `${family.tool} -F INPUT`);
      expect(await pingOnSimulatedClock(host, probe)).toContain(`64 bytes from ${target}: icmp_seq=1`);
    });

    it('a REJECT of the request in OUTPUT hands the socket the error, then the send fails', async () => {
      const host = machine();
      await sudo(host, `${family.tool} -A OUTPUT -o lo -p ${family.icmp} ${family.typeOption} echo-request -j REJECT`);
      const lines = (await pingOnSimulatedClock(host, probe)).split('\n');
      expect(lines).toContain(`${family.errorFrom(target)} icmp_seq=1 ${family.unreachable}`);
      expect(lines.indexOf(SENDMSG)).toBe(lines.indexOf(`${family.errorFrom(target)} icmp_seq=1 ${family.unreachable}`) + 1);
      expect(lines.join('\n')).toContain('1 packets transmitted, 0 received, +1 errors, 100% packet loss');
    });

    it('a REJECT of the request in INPUT answers the sender through lo, and the send itself succeeded', async () => {
      const host = machine();
      await sudo(host, `${family.tool} -A INPUT -i lo -p ${family.icmp} ${family.typeOption} echo-request -j REJECT`);
      const out = await pingOnSimulatedClock(host, probe);
      expect(out.split('\n')).toContain(`${family.errorFrom(target)} icmp_seq=1 ${family.unreachable}`);
      expect(out).not.toContain('sendmsg');
      expect(out).toContain('1 packets transmitted, 0 received, +1 errors, 100% packet loss');
    });

    it('a REJECT that also catches the error it generates is answered by nothing : no error about an error', async () => {
      const host = machine();
      await sudo(host, `${family.tool} -A INPUT -i lo -j REJECT`);
      const out = await pingOnSimulatedClock(host, probe);
      expect(out).not.toContain('From ');
      expect(out).not.toContain('bytes from');
      expect(out).toContain('1 packets transmitted, 0 received, 100% packet loss');
    });
  });
});

describe('every packet that crosses lo is counted once out and once in, in IP bytes', () => {
  async function loRow(host: LinuxPC): Promise<string> {
    return (await host.executeCommand('cat /proc/net/dev')).split('\n').find((line) => line.trim().startsWith('lo:')) ?? '';
  }

  it('IPv4 : three probes are six packets of 84 bytes each way', async () => {
    const host = machine();
    await pingOnSimulatedClock(host, 'ping -c 3 127.0.0.1');
    expect(await loRow(host)).toMatch(/^\s*lo:\s+504\s+6\s+0\s+0\s+0\s+0\s+0\s+0\s+504\s+6\s+/);
    const link = await host.executeCommand('ip -s link show lo');
    expect(link).toMatch(/RX:[^\n]*\n\s+504\s+6\s/);
    expect(link).toMatch(/TX:[^\n]*\n\s+504\s+6\s/);
  });

  it('IPv6 : two probes are four packets of 104 bytes each way', async () => {
    const host = machine();
    await pingOnSimulatedClock(host, 'ping -6 -c 2 ::1');
    expect(await loRow(host)).toMatch(/^\s*lo:\s+416\s+4\s+0\s+0\s+0\s+0\s+0\s+0\s+416\s+4\s+/);
  });

  it('a request that OUTPUT refuses is not counted : nothing left', async () => {
    const host = machine();
    await sudo(host, 'iptables -A OUTPUT -o lo -j DROP');
    await pingOnSimulatedClock(host, 'ping -c 2 127.0.0.1');
    expect(await loRow(host)).toMatch(/^\s*lo:\s+0\s+0\s+0\s+0\s+0\s+0\s+0\s+0\s+0\s+0\s+/);
  });

  it('a request that INPUT drops was carried by lo first : counted out and in', async () => {
    const host = machine();
    await sudo(host, 'iptables -A INPUT -i lo -j DROP');
    await pingOnSimulatedClock(host, 'ping -c 2 127.0.0.1');
    expect(await loRow(host)).toMatch(/^\s*lo:\s+168\s+2\s+0\s+0\s+0\s+0\s+0\s+0\s+168\s+2\s+/);
  });

  it('the source given with -I is the source of the request on lo', async () => {
    const host = machine();
    await sudo(host, 'iptables -A OUTPUT -o lo -s 10.0.0.1 -d 127.0.0.1 -p icmp -j ACCEPT');
    await pingOnSimulatedClock(host, 'ping -I 10.0.0.1 -c 2 127.0.0.1');
    expect(counters(chainLine(await sudo(host, 'iptables -L OUTPUT -v -n'), 'ACCEPT'))[0]).toBe(2);
  });

  it('TEMOIN : eth0 carries none of it', async () => {
    const host = machine();
    const before = (await host.executeCommand('cat /proc/net/dev')).split('\n').find((line) => line.trim().startsWith('eth0:'));
    await pingOnSimulatedClock(host, 'ping -c 2 10.0.0.1');
    const after = (await host.executeCommand('cat /proc/net/dev')).split('\n').find((line) => line.trim().startsWith('eth0:'));
    expect(after).toBe(before);
  });
});

describe('the size rule lives in the engine : 65535 bytes of IP at most, and the MTU of lo when the packet may not be fragmented', () => {
  it.each([
    ['ping -c 1 -s 65507 127.0.0.1', '65515 bytes from 127.0.0.1: icmp_seq=1'],
    ['ping -c 1 -M do -s 65507 127.0.0.1', '65515 bytes from 127.0.0.1: icmp_seq=1'],
    ['ping -c 1 -s 65508 127.0.0.1', 'ping: local error: message too long, mtu=65536'],
    ['ping -c 1 -M do -s 65508 127.0.0.1', 'ping: local error: message too long, mtu=65536'],
    ['ping -c 1 -M want -s 65508 10.0.0.1', 'ping: local error: message too long, mtu=65536'],
    ['ping -6 -c 1 -s 65527 ::1', '65535 bytes from ::1: icmp_seq=1'],
    ['ping -6 -c 1 -s 65528 ::1', 'ping: local error: message too long, mtu: 65536'],
    ['ping -6 -c 1 -M do -s 65488 ::1', '65496 bytes from ::1: icmp_seq=1'],
    ['ping -6 -c 1 -M do -s 65489 ::1', 'ping: local error: message too long, mtu: 65536'],
  ])('%s', async (command, line) => {
    const host = machine();
    const out = await pingOnSimulatedClock(host, command);
    expect(out.split('\n').some((candidate) => candidate.startsWith(line))).toBe(true);
    if (line.startsWith('ping:')) expect(out).toContain('1 packets transmitted, 0 received, +1 errors, 100% packet loss');
  });

  it('a smaller MTU on lo is the limit for a packet that may not be fragmented, and no limit otherwise', async () => {
    const host = machine();
    await sudo(host, 'ip link set lo mtu 1500');
    expect(await pingOnSimulatedClock(host, 'ping -c 1 -M do -s 1473 127.0.0.1')).toContain('ping: local error: message too long, mtu=1500');
    expect(await pingOnSimulatedClock(host, 'ping -c 1 -M do -s 1472 127.0.0.1')).toContain('1480 bytes from 127.0.0.1: icmp_seq=1');
    expect(await pingOnSimulatedClock(host, 'ping -c 1 -s 3000 127.0.0.1')).toContain('3008 bytes from 127.0.0.1: icmp_seq=1');
  });

  it('TEMOIN : the remote send obeys the same function : a probe over 65535 bytes is refused whatever the route, the MTU reported is the route\'s', async () => {
    const { host } = machineWithPeer();
    expect(await pingOnSimulatedClock(host, 'ping -c 1 -W 1 -s 65508 10.0.0.2')).toContain('ping: local error: message too long, mtu=1500');
    expect(await pingOnSimulatedClock(host, 'ping -c 1 -W 1 -M do -s 1473 10.0.0.2')).toContain('ping: local error: message too long, mtu=1500');
    expect(await pingOnSimulatedClock(host, 'ping -c 1 -W 1 -M do -s 1472 10.0.0.2')).toContain('1480 bytes from 10.0.0.2: icmp_seq=1');
    expect(await pingOnSimulatedClock(host, 'ping -c 1 -W 1 -s 3000 10.0.0.2')).toContain('3008 bytes from 10.0.0.2: icmp_seq=1');
  });
});

const neighbourRequests = (frames: EthernetFrame[]): number => frames.filter((frame) => frame.etherType === ETHERTYPE_ARP
  || (frame.etherType === ETHERTYPE_IPV6 && (frame.payload as { payload?: { icmpType?: string } }).payload?.icmpType === 'neighbor-solicitation')).length;

describe('the size rule is decided by the route : before anything is asked of the neighbour', () => {
  it.each([
    ['IPv4', 'ping -c 1 -W 1 -M do -s 1473 10.0.0.77', 'ping -c 1 -W 1 10.0.0.77', 'ping: local error: message too long, mtu=1500', 'Destination Host Unreachable'],
    ['IPv6', 'ping -6 -c 1 -W 1 -M do -s 1453 2001:db8::77', 'ping -6 -c 1 -W 1 2001:db8::77', 'ping: local error: message too long, mtu: 1500', 'Address unreachable'],
  ])('%s : a probe that is too big is refused at once and sends nothing, where a small probe to the same address asks and finds nobody', async (_family, big, small, refused, unreachable) => {
    const { host } = machineWithPeer();
    const frames = framesSentOn(host, 'eth0');
    const refusal = await timedOnSimulatedClock(host, big);
    expect(refusal.output).toContain(refused);
    expect(refusal.output).not.toContain(unreachable);
    expect(refusal.elapsedMs).toBeLessThan(1000);
    expect(neighbourRequests(frames)).toBe(0);
    const control = await timedOnSimulatedClock(host, small);
    expect(control.output).toContain(unreachable);
    expect(control.elapsedMs).toBeGreaterThanOrEqual(1000);
    expect(neighbourRequests(frames)).toBeGreaterThan(0);
  });
});

describe('UDP to oneself crosses the same two chains', () => {
  const PORT = 5000;

  function listener(host: LinuxPC): void {
    host.udpListen(PORT, 'probe', {});
  }

  const received = async (host: LinuxPC, tool: 'iptables' | 'ip6tables'): Promise<number> => {
    if (tool === 'ip6tables') {
      const row = (await host.executeCommand('cat /proc/net/snmp6')).split('\n').find((line) => line.startsWith('Udp6InDatagrams')) ?? '';
      return Number(row.split(/\s+/)[1]);
    }
    const snmp = (await host.executeCommand('cat /proc/net/snmp')).split('\n');
    const header = snmp.find((line) => line.startsWith('Udp:') && line.includes('InDatagrams')) ?? '';
    const values = snmp.find((line) => line.startsWith('Udp:') && !line.includes('InDatagrams')) ?? '';
    return Number(values.split(/\s+/)[header.split(/\s+/).indexOf('InDatagrams')]);
  };

  it.each([
    ['IPv4', 'iptables', (host: LinuxPC) => host.sendUdpDatagram(new IPAddress('127.0.0.1'), PORT, 4000, 'x', 1)],
    ['IPv6', 'ip6tables', (host: LinuxPC) => host.sendUdpDatagram6(new IPv6Address('::1'), PORT, 4000, 'x', 1)],
  ] as const)('%s : TEMOIN, then OUTPUT refuses the send, then INPUT loses it', async (_name, tool, send) => {
    const host = machine();
    listener(host);
    expect(send(host)).toBe(true);
    expect(await received(host, tool)).toBe(1);

    await sudo(host, `${tool} -A OUTPUT -o lo -p udp --dport ${PORT} -j DROP`);
    expect(send(host)).toBe(false);
    expect(await received(host, tool)).toBe(1);
    expect(counters(chainLine(await sudo(host, `${tool} -L OUTPUT -v -n`), 'DROP'))[0]).toBe(1);

    await sudo(host, `${tool} -F OUTPUT`);
    await sudo(host, `${tool} -A INPUT -i lo -p udp --dport ${PORT} -j DROP`);
    expect(send(host)).toBe(true);
    expect(await received(host, tool)).toBe(1);
    expect(counters(chainLine(await sudo(host, `${tool} -L INPUT -v -n`), 'DROP'))[0]).toBe(1);
  });

  it('a REJECT in OUTPUT refuses the send like a DROP does', async () => {
    const host = machine();
    listener(host);
    await sudo(host, `iptables -A OUTPUT -o lo -p udp --dport ${PORT} -j REJECT`);
    expect(host.sendUdpDatagram(new IPAddress('127.0.0.1'), PORT, 4000, 'x', 1)).toBe(false);
  });

  it('a datagram to a port nobody listens on is answered by a port unreachable that comes back through INPUT on lo', async () => {
    const host = machine();
    await sudo(host, 'iptables -A INPUT -i lo -p icmp --icmp-type destination-unreachable -j ACCEPT');
    expect(host.sendUdpDatagram(new IPAddress('127.0.0.1'), PORT, 4000, 'x', 1)).toBe(true);
    expect(counters(chainLine(await sudo(host, 'iptables -L INPUT -v -n'), 'ACCEPT'))[0]).toBe(1);
  });
});

describe('the round trip and the interval of the probes do not depend on where the probe goes', () => {
  it('TEMOIN : a probe to a neighbour is timed on the wire, and only a probe to oneself is floored at 0.01 ms', async () => {
    const { host } = machineWithPeer();
    const remote = Number(/time=([\d.]+) ms/.exec(await pingOnSimulatedClock(host, 'ping -c 1 -W 1 10.0.0.2'))?.[1]);
    const local = Number(/time=([\d.]+) ms/.exec(await pingOnSimulatedClock(host, 'ping -c 1 -W 1 127.0.0.1'))?.[1]);
    const local6 = Number(/time=([\d.]+) ms/.exec(await pingOnSimulatedClock(host, 'ping -6 -c 1 -W 1 ::1'))?.[1]);
    expect(remote).toBeGreaterThan(0);
    expect(remote).toBeLessThan(0.01);
    expect(local).toBe(0.01);
    expect(local6).toBe(0.01);
  });

  it.each([
    ['IPv4', 'iptables', 'ping -c 2 -W 3 127.0.0.1'],
    ['IPv6', 'ip6tables', 'ping -6 -c 2 -W 3 ::1'],
  ])('%s : a send that OUTPUT refuses does not wait for a reply that cannot come', async (_name, tool, command) => {
    const host = machine();
    await sudo(host, `${tool} -A OUTPUT -o lo -j DROP`);
    expect(await pingOnSimulatedClock(host, command)).toContain('time 1000ms');
  });

  it.each([
    ['an error reply', 'iptables -A INPUT -p icmp -j REJECT', 'ping -c 2 -W 1 10.0.0.2', 'time 1000ms'],
    ['an error reply, with a longer interval', 'iptables -A INPUT -p icmp -j REJECT', 'ping -c 3 -i 2 -W 1 10.0.0.2', 'time 4000ms'],
    ['silence', 'iptables -A INPUT -p icmp -j DROP', 'ping -c 2 -W 1 10.0.0.2', 'time 1000ms'],
  ])('after %s the next probe leaves one interval later and the last probe is not followed by a pause', async (_name, rule, command, elapsed) => {
    const { host, peer } = machineWithPeer();
    await sudo(peer, rule);
    expect(await pingOnSimulatedClock(host, command)).toContain(elapsed);
  });

  it('the command ends with the last error reply : the pause that follows an error reply is only between two probes', async () => {
    const { host, peer } = machineWithPeer();
    await sudo(peer, 'iptables -A INPUT -p icmp -j REJECT');
    const { elapsedMs } = await timedOnSimulatedClock(host, 'ping -c 3 -i 2 -W 1 10.0.0.2');
    expect(elapsedMs).toBeGreaterThanOrEqual(4000);
    expect(elapsedMs).toBeLessThan(4100);
  });
});

describe('the datagram counters of the IP layer see each leg once', () => {
  const field = async (host: LinuxPC, family: 4 | 6, name: string): Promise<number> => {
    if (family === 6) {
      const row = (await host.executeCommand('cat /proc/net/snmp6')).split('\n').find((line) => line.startsWith(`Ip6${name} `)) ?? '';
      return Number(row.split(/\s+/)[1]);
    }
    const lines = (await host.executeCommand('cat /proc/net/snmp')).split('\n').filter((line) => line.startsWith('Ip:'));
    return Number(lines[1].split(/\s+/)[lines[0].split(/\s+/).indexOf(name)]);
  };

  it.each([
    [4, 'ping -c 3 127.0.0.1', 6],
    [6, 'ping -6 -c 2 ::1', 4],
  ] as const)('IPv%i : %s moves received, delivered and requested by the same number', async (family, command, legs) => {
    const host = machine();
    const names = ['InReceives', 'InDelivers', 'OutRequests'];
    const before = await Promise.all(names.map((name) => field(host, family, name)));
    await pingOnSimulatedClock(host, command);
    const after = await Promise.all(names.map((name) => field(host, family, name)));
    expect(after.map((value, index) => value - before[index])).toEqual([legs, legs, legs]);
  });
});

describe('Windows paces its probes through the same loop', () => {
  async function windowsAgainst(peerRule: string): Promise<{ output: string; elapsedMs: number }> {
    const windows = new WindowsPC('windows-pc', 'W1', 0, 0);
    const peer = new LinuxPC('P', 0, 0);
    new Cable('c').connect(windows.getPort('eth0')!, peer.getPort('eth0')!);
    windows.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    peer.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    await sudo(peer, peerRule);
    return timedOnSimulatedClock(windows as unknown as LinuxPC, 'ping -n 3 10.0.0.2');
  }

  it('an error reply is followed by the interval, except after the last probe : two seconds for three probes', async () => {
    const { output, elapsedMs } = await windowsAgainst('iptables -A INPUT -p icmp -j REJECT');
    expect(output.match(/Destination host unreachable/g)).toHaveLength(3);
    expect(elapsedMs).toBeGreaterThanOrEqual(2000);
    expect(elapsedMs).toBeLessThan(2100);
  });

  it('a timeout is its own wait : three silent probes cost three timeouts and no extra interval', async () => {
    const { output, elapsedMs } = await windowsAgainst('iptables -A INPUT -p icmp -j DROP');
    expect(output.match(/Request timed out/g)).toHaveLength(3);
    expect(elapsedMs).toBeGreaterThanOrEqual(12000);
    expect(elapsedMs).toBeLessThan(12100);
  });
});

describe('Windows does not filter the loopback', () => {
  it('a Windows host that blocks every direction still answers its own loopback, and ping to itself keeps its TTL', async () => {
    const windows = new WindowsPC('windows-pc', 'W1', 0, 0);
    await windows.executeCommand('netsh advfirewall set allprofiles firewallpolicy blockinbound,blockoutbound');
    const out = await pingOnSimulatedClock(windows as unknown as LinuxPC, 'ping -n 1 127.0.0.1');
    expect(out).toContain('Reply from 127.0.0.1: bytes=32');
    expect(out).toContain('TTL=128');
  });
});
