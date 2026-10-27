/**
 * Ce que la machine ouvre elle-meme traverse la table nat. Le paquet d'un socket TCP ou UDP local passe, dans l'ordre du noyau, par le
 * suivi de connexions, la chaine OUTPUT de la table nat (DNAT, REDIRECT, DROP), la recherche de route refaite quand l'ADRESSE de
 * destination a change (`ip_route_me_harder` : un changement de port seul garde la route), la chaine OUTPUT du filtre, puis POSTROUTING.
 * Une destination devenue locale reboucle par lo -- POSTROUTING puis INPUT, interface lo -- en portant la meme entree de suivi, de sorte
 * que la reponse d'un serveur local derriere un REDIRECT repart sous l'adresse et le port que le client a composes. Une capture voit le
 * paquet tel qu'il traverse l'interface : le port atteint sur lo, l'adresse traduite sur eth0.
 *
 * Mesure de depart (E7a ; inside 10.0.0.2 -- voisin 10.0.0.3 -- GW 10.0.0.1 -- outside 203.0.113.2) :
 *     -t nat -A OUTPUT -p tcp --dport 8080 -j DNAT --to-destination 10.0.0.3:22 ; nc -zv 10.0.0.9 8080  ->  « No route to host », compteur de la
 *                                              regle a 0 et un flux SYN_SENT vers 10.0.0.9:8080 : la chaine n'est pas lue pour un TCP local
 *     -t nat -A OUTPUT -p tcp --dport 80 -j REDIRECT --to-ports 8080 (ecoute locale sur 8080) ; nc 10.0.0.3 80  ->  « Connection refused »,
 *                                              compteur a 0 ; meme regle avec -o lo ; nc 127.0.0.1 80  ->  « Connection refused », compteur a 0
 *     -t nat -A OUTPUT -p tcp --dport 22 -j DROP ; nc 10.0.0.3 22  ->  « succeeded! », compteur a 0
 *     le meme DNAT et le meme REDIRECT en UDP  ->  le datagramme arrive traduit : un cas particulier de l'UDP lisait la table nat hors du
 *                                              suivi et inscrivait le tuple traduit comme tuple d'origine, deux ecritures d'un meme fait
 *
 * Autorites : noyau Linux 6.1 -- net/ipv4/netfilter/iptable_nat.c (la table nat est accrochee a NF_INET_LOCAL_OUT), net/netfilter/
 * nf_nat_proto.c (nf_nat_ipv4_local_fn : la chaine nat est lue par nf_nat_ipv4_fn, puis `ip_route_me_harder` si l'adresse de destination du
 * tuple d'origine differe de l'adresse source du tuple de reponse), nf_nat_core.c (nf_nat_inet_fn : le flux n'est lu qu'une fois),
 * nf_nat_redirect.c (nf_nat_redirect_ipv4 : 127.0.0.1 en OUTPUT) ; iptables 1.8.7 pour la grammaire et l'impression.
 *
 * Discrimination : contre l'arbre sans le lot (sources remises a leur etat, sonde et support conserves), 35 des 41 cas tombent et 6 passent
 * des deux cotes : le TEMOIN (sans regle nat, une connexion vers une adresse que personne ne porte echoue : le laboratoire est sain),
 * et cinq cas de non-regression que l'ancien chemin tenait deja (un DROP de la table nat refuse le datagramme des l'envoi ; un datagramme
 * redirige que la chaine INPUT de lo jette est perdu apres un envoi qui a reussi ; un REJECT de la chaine OUTPUT de lo repond une seule
 * fois ; une sonde de soi-meme lit l'en-tete de la reponse qu'elle recoit ; un paquet IPv6 que le filtre INPUT de lo jette etait sur lo).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { watchHalfOpen } from '../../support/tcpHalfOpen';
import {
  natGateway, nat, sudo, flows, connect, fetchPage, escaped, type Host,
  INSIDE_IP, NEIGHBOUR_IP, OUTSIDE_IP,
} from '../../support/natGateway';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const NOBODY = '10.0.0.9';
const OFF_LINK = '192.0.2.77';

async function packetsOf(host: Host, table: string, chain: string, ruleIndex = 1): Promise<number> {
  const rows = (await sudo(host, `iptables -t ${table} -L ${chain} -v -n`)).split('\n').slice(2).filter((row) => row.trim() !== '');
  return Number(rows[ruleIndex - 1].trim().split(/\s+/)[0]);
}

const filterPackets = async (host: Host, chain: string, ruleIndex = 1): Promise<number> => packetsOf(host, 'filter', chain, ruleIndex);
const natPackets = async (host: Host, chain: string, ruleIndex = 1): Promise<number> => packetsOf(host, 'nat', chain, ruleIndex);

describe('DNAT in OUTPUT sends what the host opens to another address', () => {
  it('TEMOIN : with no nat rule a connection to an address nobody holds fails', async () => {
    const { inside } = await natGateway();
    expect(await connect(inside, NOBODY, 8080)).toContain('No route to host');
  });

  it('a connection dialed at an address nobody holds reaches the host the rule names', async () => {
    const { inside, neighbour } = await natGateway();
    await nat(inside, `-A OUTPUT -p tcp --dport 8080 -j DNAT --to-destination ${NEIGHBOUR_IP}:2222`);
    neighbour.getTcpStack().listen(2222, { onAccept: () => undefined });
    const seen = watchHalfOpen(neighbour);
    const socket = inside.getTcpStack().connect(NOBODY, 8080);
    expect(socket!.state).toBe('established');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ localIp: NEIGHBOUR_IP, localPort: 2222, remoteIp: INSIDE_IP });
  });

  it('nc reports the connection as made', async () => {
    const { inside, neighbour } = await natGateway();
    await sudo(neighbour, 'systemctl start ssh');
    await nat(inside, `-A OUTPUT -p tcp --dport 8080 -j DNAT --to-destination ${NEIGHBOUR_IP}:22`);
    expect(await connect(inside, NOBODY, 8080)).toContain('succeeded!');
  });

  it('the flow keeps the dialed address in the original tuple and the translated one in the reply tuple', async () => {
    const { inside, neighbour } = await natGateway();
    await sudo(neighbour, 'systemctl start ssh');
    await nat(inside, `-A OUTPUT -p tcp --dport 8080 -j DNAT --to-destination ${NEIGHBOUR_IP}:22`);
    await connect(inside, NOBODY, 8080);
    const lines = await flows(inside, '-p', 'tcp');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`src=${escaped(INSIDE_IP)} dst=${escaped(NOBODY)} sport=\\d+ dport=8080 src=${escaped(NEIGHBOUR_IP)} dst=${escaped(INSIDE_IP)} sport=22 dport=\\d+ \\[ASSURED\\]`));
  });

  it('a page fetched through the rule arrives whole, from a host beyond the gateway', async () => {
    const { inside, outside } = await natGateway();
    await sudo(outside, 'systemctl start nginx');
    await nat(inside, `-A OUTPUT -p tcp --dport 8080 -j DNAT --to-destination ${OUTSIDE_IP}:80`);
    expect(await fetchPage(inside, `http://${NOBODY}:8080/`)).toContain('Welcome to nginx!');
  });

  it('the nat chain is read for the first packet of the flow only', async () => {
    const { inside, outside } = await natGateway();
    await sudo(outside, 'systemctl start nginx');
    await nat(inside, `-A OUTPUT -p tcp --dport 8080 -j DNAT --to-destination ${OUTSIDE_IP}:80`);
    await fetchPage(inside, `http://${NOBODY}:8080/`);
    expect(await natPackets(inside, 'OUTPUT')).toBe(1);
  });

  it('a rule that changes only the port keeps the route and reaches the same host on the new port', async () => {
    const { inside, neighbour } = await natGateway();
    neighbour.getTcpStack().listen(2222, { onAccept: () => undefined });
    const seen = watchHalfOpen(neighbour);
    await nat(inside, `-A OUTPUT -d ${NEIGHBOUR_IP} -p tcp --dport 8080 -j DNAT --to-destination :2222`);
    expect(inside.getTcpStack().connect(NEIGHBOUR_IP, 8080)!.state).toBe('established');
    expect(seen[0]).toMatchObject({ localIp: NEIGHBOUR_IP, localPort: 2222, remoteIp: INSIDE_IP });
  });

  it('the route is looked up again after the rewrite : an address with no route is rescued by a rule that names a neighbour', async () => {
    const { inside, neighbour } = await natGateway();
    await nat(inside, `-A OUTPUT -d ${OFF_LINK} -p tcp --dport 8080 -j DNAT --to-destination ${NEIGHBOUR_IP}:2222`);
    neighbour.getTcpStack().listen(2222, { onAccept: () => undefined });
    const socket = inside.getTcpStack().connect(OFF_LINK, 8080);
    expect(socket!.state).toBe('established');
  });

  it('and the other way : an address on the link rewritten to a host beyond the gateway leaves through the gateway', async () => {
    const { inside, outside } = await natGateway();
    await nat(inside, `-A OUTPUT -d ${NOBODY} -p tcp --dport 8080 -j DNAT --to-destination ${OUTSIDE_IP}:2222`);
    outside.getTcpStack().listen(2222, { onAccept: () => undefined });
    const seen = watchHalfOpen(outside);
    const socket = inside.getTcpStack().connect(NOBODY, 8080);
    expect(socket!.state).toBe('established');
    expect(seen[0]).toMatchObject({ localIp: OUTSIDE_IP, remoteIp: INSIDE_IP });
  });

  it('-o names the interface of the route chosen before the rewrite', async () => {
    const { inside, neighbour } = await natGateway();
    neighbour.getTcpStack().listen(2222, { onAccept: () => undefined });
    await nat(inside,
      `-A OUTPUT -o lo -p tcp --dport 8080 -j DNAT --to-destination ${NEIGHBOUR_IP}:2222`,
      `-A OUTPUT -o eth0 -p tcp --dport 8080 -j DNAT --to-destination ${NEIGHBOUR_IP}:2222`);
    expect(inside.getTcpStack().connect(OFF_LINK, 8080)!.state).toBe('established');
    expect(await natPackets(inside, 'OUTPUT', 1)).toBe(0);
    expect(await natPackets(inside, 'OUTPUT', 2)).toBe(1);
  });

  it('the filter OUTPUT chain sees the translated packet, not the dialed one', async () => {
    const { inside, neighbour } = await natGateway();
    neighbour.getTcpStack().listen(2222, { onAccept: () => undefined });
    await nat(inside, `-A OUTPUT -p tcp --dport 8080 -j DNAT --to-destination ${NEIGHBOUR_IP}:2222`);
    await sudo(inside, `iptables -A OUTPUT -d ${NOBODY} -p tcp -j ACCEPT`);
    await sudo(inside, `iptables -A OUTPUT -d ${NEIGHBOUR_IP} -p tcp --dport 2222 -j DROP`);
    const socket = inside.getTcpStack().connect(NOBODY, 8080);
    expect(socket!.state).not.toBe('established');
    expect(await filterPackets(inside, 'OUTPUT', 1)).toBe(0);
    expect(await filterPackets(inside, 'OUTPUT', 2)).toBe(1);
  });

  it('an ACCEPT before the DNAT leaves the connection as it was dialed, and once it is gone the DNAT applies', async () => {
    const { inside, neighbour } = await natGateway();
    neighbour.getTcpStack().listen(2222, { onAccept: () => undefined });
    await nat(inside,
      '-A OUTPUT -p tcp --dport 8080 -j ACCEPT',
      `-A OUTPUT -p tcp --dport 8080 -j DNAT --to-destination ${NEIGHBOUR_IP}:2222`);
    const seen = watchHalfOpen(neighbour);
    expect(inside.getTcpStack().connect(NOBODY, 8080)!.state).not.toBe('established');
    expect(seen).toHaveLength(0);
    await nat(inside, '-D OUTPUT -p tcp --dport 8080 -j ACCEPT');
    expect(inside.getTcpStack().connect(NOBODY, 8080)!.state).toBe('established');
    expect(seen).toHaveLength(1);
  });

  it('a flow keeps its translation after the rule is deleted, and the next connection is no longer translated', async () => {
    const { inside, neighbour } = await natGateway();
    neighbour.getTcpStack().listen(2222, { onAccept: () => undefined });
    await nat(inside, `-A OUTPUT -p tcp --dport 8080 -j DNAT --to-destination ${NEIGHBOUR_IP}:2222`);
    expect(inside.getTcpStack().connect(NOBODY, 8080)!.state).toBe('established');
    await nat(inside, `-D OUTPUT -p tcp --dport 8080 -j DNAT --to-destination ${NEIGHBOUR_IP}:2222`);
    expect(await flows(inside, '-p', 'tcp')).toHaveLength(1);
    expect(inside.getTcpStack().connect(NOBODY, 8080)!.state).not.toBe('established');
  });
});

describe('REDIRECT in OUTPUT hands what the host opens to a server of its own', () => {
  it('a connection dialed at another host reaches the local listener, which sees the egress address as its peer', async () => {
    const { inside } = await natGateway();
    inside.getTcpStack().listen(8080, { onAccept: () => undefined });
    const seen = watchHalfOpen(inside);
    await nat(inside, '-A OUTPUT -p tcp --dport 80 -j REDIRECT --to-ports 8080');
    const socket = inside.getTcpStack().connect(NEIGHBOUR_IP, 80);
    expect(socket!.state).toBe('established');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ localIp: '127.0.0.1', localPort: 8080, remoteIp: INSIDE_IP });
  });

  it('the flow is dialed at the other host and answered from the loopback address', async () => {
    const { inside } = await natGateway();
    inside.getTcpStack().listen(8080, { onAccept: () => undefined });
    await nat(inside, '-A OUTPUT -p tcp --dport 80 -j REDIRECT --to-ports 8080');
    await connect(inside, NEIGHBOUR_IP, 80);
    const lines = await flows(inside, '-p', 'tcp');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`src=${escaped(INSIDE_IP)} dst=${escaped(NEIGHBOUR_IP)} sport=\\d+ dport=80 src=127\\.0\\.0\\.1 dst=${escaped(INSIDE_IP)} sport=8080 dport=\\d+ \\[ASSURED\\]`));
  });

  it('a rule bound to lo takes loopback traffic to the other port and leaves remote traffic alone', async () => {
    const { inside } = await natGateway();
    inside.getTcpStack().listen(8080, { onAccept: () => undefined });
    await nat(inside, '-A OUTPUT -o lo -p tcp --dport 80 -j REDIRECT --to-ports 8080');
    expect(await connect(inside, '127.0.0.1', 80)).toContain('succeeded!');
    expect(await natPackets(inside, 'OUTPUT')).toBe(1);
    expect(await connect(inside, NEIGHBOUR_IP, 80)).toContain('Connection refused');
    expect(await natPackets(inside, 'OUTPUT')).toBe(1);
  });

  it('a page served locally on another port arrives whole', async () => {
    const { inside } = await natGateway();
    await sudo(inside, 'systemctl start nginx');
    await nat(inside, '-A OUTPUT -p tcp --dport 8888 -j REDIRECT --to-ports 80');
    expect(await fetchPage(inside, `http://${NEIGHBOUR_IP}:8888/`)).toContain('Welcome to nginx!');
  });

  it('a redirected port that nobody listens on refuses the connection, although the host that was dialed would have accepted it', async () => {
    const { inside, neighbour } = await natGateway();
    neighbour.getTcpStack().listen(80, { onAccept: () => undefined });
    await nat(inside, '-A OUTPUT -p tcp --dport 80 -j REDIRECT --to-ports 8081');
    expect(await connect(inside, NEIGHBOUR_IP, 80)).toContain('Connection refused');
  });

  it('a REJECT in the OUTPUT chain of lo answers the connection once', async () => {
    const { inside } = await natGateway();
    inside.getTcpStack().listen(8080, { onAccept: () => undefined });
    await sudo(inside, 'iptables -A OUTPUT -o lo -p tcp --dport 8080 -j REJECT');
    expect(await connect(inside, '127.0.0.1', 8080)).toContain('Connection refused');
    const statistics = await sudo(inside, 'netstat -s');
    expect(statistics).toMatch(/1 ICMP messages sent/);
    expect(statistics).toMatch(/ICMP output histogram:\n\s+destination unreachable: 1\n/);
  });

  it('the looped packets cross the INPUT chain of lo : a rule there that drops the redirected port stops the connection', async () => {
    const { inside } = await natGateway();
    inside.getTcpStack().listen(8080, { onAccept: () => undefined });
    await nat(inside, '-A OUTPUT -p tcp --dport 80 -j REDIRECT --to-ports 8080');
    await sudo(inside, 'iptables -A INPUT -i lo -p tcp --dport 8080 -j DROP');
    expect(inside.getTcpStack().connect(NEIGHBOUR_IP, 80)!.state).not.toBe('established');
    expect(await filterPackets(inside, 'INPUT')).toBe(1);
  });

  it('the PREROUTING chain does not read a packet that the OUTPUT chain already decided', async () => {
    const { inside } = await natGateway();
    inside.getTcpStack().listen(8080, { onAccept: () => undefined });
    await nat(inside,
      '-A OUTPUT -o lo -p tcp --dport 80 -j REDIRECT --to-ports 8080',
      '-A PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 9999');
    expect(await connect(inside, '127.0.0.1', 80)).toContain('succeeded!');
    expect(await natPackets(inside, 'PREROUTING')).toBe(0);
  });
});

describe('a capture shows the packets as they cross the interface, after the translation', () => {
  const capture = async (host: Host, iface: string, name: string): Promise<void> => {
    await sudo(host, `tcpdump -i ${iface} tcp -w /tmp/${name}.pcap &`);
  };
  const seen = async (host: Host, name: string): Promise<string> => sudo(host, `tcpdump -r /tmp/${name}.pcap -nn`);

  it('a loopback connection redirected to another port shows the port it reached on lo', async () => {
    const { inside } = await natGateway();
    inside.getTcpStack().listen(8080, { onAccept: () => undefined });
    await nat(inside, '-A OUTPUT -o lo -p tcp --dport 80 -j REDIRECT --to-ports 8080');
    await capture(inside, 'lo', 'near');
    await connect(inside, '127.0.0.1', 80);
    const shown = await seen(inside, 'near');
    expect(shown).toMatch(/127\.0\.0\.1\.\d+ > 127\.0\.0\.1\.8080: Flags \[S\]/);
    expect(shown).not.toMatch(/> 127\.0\.0\.1\.80: /);
  });

  it('a connection redirected from another host crosses lo, not eth0, and the answer carries the dialed address', async () => {
    const { inside } = await natGateway();
    inside.getTcpStack().listen(8080, { onAccept: () => undefined });
    await nat(inside, '-A OUTPUT -p tcp --dport 80 -j REDIRECT --to-ports 8080');
    await capture(inside, 'lo', 'looped');
    await capture(inside, 'eth0', 'wire');
    await connect(inside, NEIGHBOUR_IP, 80);
    const onLo = await seen(inside, 'looped');
    expect(onLo).toMatch(new RegExp(`${escaped(INSIDE_IP)}\\.\\d+ > 127\\.0\\.0\\.1\\.8080: Flags \\[S\\]`));
    expect(onLo).toMatch(new RegExp(`${escaped(NEIGHBOUR_IP)}\\.80 > ${escaped(INSIDE_IP)}\\.\\d+: Flags \\[S\\.\\]`));
    expect(await seen(inside, 'wire')).not.toContain(`${NEIGHBOUR_IP}.80`);
  });

  it('a connection that is rewritten toward another host leaves eth0 under the translated address', async () => {
    const { inside, neighbour } = await natGateway();
    neighbour.getTcpStack().listen(2222, { onAccept: () => undefined });
    await nat(inside, `-A OUTPUT -p tcp --dport 8080 -j DNAT --to-destination ${NEIGHBOUR_IP}:2222`);
    await capture(inside, 'eth0', 'out');
    await connect(inside, NOBODY, 8080);
    const shown = await seen(inside, 'out');
    expect(shown).toMatch(new RegExp(`${escaped(INSIDE_IP)}\\.\\d+ > ${escaped(NEIGHBOUR_IP)}\\.2222: Flags \\[S\\]`));
    expect(shown).not.toContain(`${NOBODY}.8080`);
  });

  it('the captured packet carries the checksum of the translated segment', async () => {
    const { inside } = await natGateway();
    inside.getTcpStack().listen(8080, { onAccept: () => undefined });
    await nat(inside, '-A OUTPUT -o lo -p tcp --dport 80 -j REDIRECT --to-ports 8080');
    await sudo(inside, 'tcpdump -i lo tcp -w /tmp/sum.pcap &');
    await connect(inside, '127.0.0.1', 80);
    const shown = await sudo(inside, 'tcpdump -r /tmp/sum.pcap -nn -v');
    const syn = shown.split('\n').findIndex((line) => line.includes('> 127.0.0.1.8080: Flags [S]'));
    expect(syn).toBeGreaterThan(0);
    expect(shown.split('\n')[syn]).toMatch(/cksum 0x[0-9a-f]{4} \(correct\)/);
    expect(shown.split('\n')[syn - 1]).toMatch(/ttl 64, id \d+, offset 0, flags \[DF\], proto TCP \(6\)/);
    expect(shown).not.toContain('incorrect');
  });

  it('a POSTROUTING rule bound to lo translates the source a local listener sees', async () => {
    const { inside } = await natGateway();
    inside.getTcpStack().listen(8080, { onAccept: () => undefined });
    const seen = watchHalfOpen(inside);
    await nat(inside, '-A POSTROUTING -o lo -p tcp --dport 8080 -j SNAT --to-source 127.0.0.9');
    expect(inside.getTcpStack().connect('127.0.0.1', 8080)!.state).toBe('established');
    expect(seen[0]).toMatchObject({ localIp: '127.0.0.1', localPort: 8080, remoteIp: '127.0.0.9' });
    const [flow] = await flows(inside, '-p', 'tcp');
    expect(flow).toMatch(/src=127\.0\.0\.1 dst=127\.0\.0\.1 sport=\d+ dport=8080 src=127\.0\.0\.1 dst=127\.0\.0\.9 sport=8080 dport=\d+ \[ASSURED\]/);
  });

  it('a probe of oneself reads the header of the reply it gets back', async () => {
    const { inside } = await natGateway();
    inside.getTcpStack().listen(8080, { onAccept: () => undefined });
    expect(await sudo(inside, 'hping3 -S -p 8080 -c 1 127.0.0.1')).toMatch(/len=44 ip=127\.0\.0\.1 ttl=64 DF id=\d+ sport=8080 flags=SA/);
    expect(await sudo(inside, 'nmap -sS -p 8080 127.0.0.1 --reason')).toMatch(/8080\/tcp open\s+\S+\s+syn-ack ttl 64/);
  });

  it('an IPv6 packet that the OUTPUT filter drops was on no interface', async () => {
    const { inside } = await natGateway();
    inside.getTcpStack().listen(8080, { onAccept: () => undefined });
    await sudo(inside, 'ip6tables -A OUTPUT -o lo -p tcp --dport 8080 -j DROP');
    await capture(inside, 'lo', 'six-output');
    expect(await connect(inside, '::1', 8080)).toContain('timed out: Operation now in progress');
    expect(await seen(inside, 'six-output')).not.toContain('Flags [S]');
  });

  it('an IPv6 packet that the INPUT filter of lo drops was on lo all the same', async () => {
    const { inside } = await natGateway();
    inside.getTcpStack().listen(8080, { onAccept: () => undefined });
    await sudo(inside, 'ip6tables -A INPUT -i lo -p tcp --dport 8080 -j DROP');
    await capture(inside, 'lo', 'six-input');
    expect(await connect(inside, '::1', 8080)).toContain('timed out: Operation now in progress');
    expect(await seen(inside, 'six-input')).toMatch(/IP6 ::1\.\d+ > ::1\.8080: Flags \[S\]/);
  });

  it('a packet that the INPUT filter of lo drops was on lo all the same', async () => {
    const { inside } = await natGateway();
    inside.getTcpStack().listen(8080, { onAccept: () => undefined });
    await nat(inside, '-A OUTPUT -o lo -p tcp --dport 80 -j REDIRECT --to-ports 8080');
    await sudo(inside, 'iptables -A INPUT -i lo -p tcp --dport 8080 -j DROP');
    await capture(inside, 'lo', 'input');
    await connect(inside, '127.0.0.1', 80);
    expect(await seen(inside, 'input')).toMatch(/> 127\.0\.0\.1\.8080: Flags \[S\]/);
  });

  it('a packet that the OUTPUT filter drops was on no interface', async () => {
    const { inside } = await natGateway();
    inside.getTcpStack().listen(8080, { onAccept: () => undefined });
    await nat(inside, '-A OUTPUT -o lo -p tcp --dport 80 -j REDIRECT --to-ports 8080');
    await sudo(inside, 'iptables -A OUTPUT -o lo -p tcp --dport 8080 -j DROP');
    await capture(inside, 'lo', 'output');
    await connect(inside, '127.0.0.1', 80);
    expect(await filterPackets(inside, 'OUTPUT')).toBeGreaterThanOrEqual(1);
    expect(await seen(inside, 'output')).not.toMatch(/> 127\.0\.0\.1\.8080: Flags \[S\]/);
  });
});

describe('a DROP in the nat OUTPUT chain stops what the host opens', () => {
  it('a TCP connection never leaves, and the rule counts the packet', async () => {
    const { inside, neighbour } = await natGateway();
    await sudo(neighbour, 'systemctl start ssh');
    await nat(inside, '-A OUTPUT -p tcp --dport 22 -j DROP');
    await sudo(neighbour, `iptables -A INPUT -s ${INSIDE_IP} -p tcp -j ACCEPT`);
    expect(await connect(inside, NEIGHBOUR_IP, 22)).toContain('timed out: Operation now in progress');
    expect(await natPackets(inside, 'OUTPUT')).toBeGreaterThanOrEqual(1);
    expect(await filterPackets(neighbour, 'INPUT')).toBe(0);
  });

  it('a UDP datagram is refused at the send', async () => {
    const { inside, neighbour } = await natGateway();
    await nat(inside, '-A OUTPUT -p udp --dport 5000 -j DROP');
    const received: string[] = [];
    neighbour.udpBind(5000, (d) => received.push(String(d.udp.payload)));
    expect(inside.sendUdpDatagram(new IPAddress(NEIGHBOUR_IP), 5000, 40000, 'ping', 4)).toBe(false);
    expect(received).toEqual([]);
  });
});

describe('UDP goes through the same flow table as TCP', () => {
  it('a datagram dialed at an address nobody holds reaches the host the rule names, and the flow keeps the dialed tuple', async () => {
    const { inside, neighbour } = await natGateway();
    await nat(inside, `-A OUTPUT -d ${NOBODY} -p udp --dport 5000 -j DNAT --to-destination ${NEIGHBOUR_IP}:6000`);
    const received: string[] = [];
    neighbour.udpBind(6000, (d) => received.push(`${d.udp.payload} from ${d.sourceIP}`));
    expect(inside.sendUdpDatagram(new IPAddress(NOBODY), 5000, 40000, 'ping', 4)).toBe(true);
    expect(received).toEqual([`ping from ${INSIDE_IP}`]);
    const [flow] = await flows(inside, '-p', 'udp', '--dport', '5000');
    expect(flow).toMatch(new RegExp(`src=${escaped(INSIDE_IP)} dst=${escaped(NOBODY)} sport=40000 dport=5000 \\[UNREPLIED\\] src=${escaped(NEIGHBOUR_IP)} dst=${escaped(INSIDE_IP)} sport=6000 dport=40000`));
  });

  it('the reply reaches the socket that sent the datagram, under the address and port it dialed', async () => {
    const { inside, neighbour } = await natGateway();
    await nat(inside, `-A OUTPUT -d ${NOBODY} -p udp --dport 5000 -j DNAT --to-destination ${NEIGHBOUR_IP}:6000`);
    neighbour.udpBind(6000, (d) => {
      neighbour.sendUdpDatagram(d.sourceIP as IPAddress, d.udp.sourcePort, 6000, 'pong', 4);
    });
    const received: string[] = [];
    inside.udpBind(40000, (d) => received.push(`${d.udp.payload} from ${d.sourceIP}:${d.udp.sourcePort}`));
    inside.sendUdpDatagram(new IPAddress(NOBODY), 5000, 40000, 'ping', 4);
    expect(received).toEqual([`pong from ${NOBODY}:5000`]);
  });

  it('a datagram dialed at another host reaches the local listener on the redirected port', async () => {
    const { inside, neighbour } = await natGateway();
    await nat(inside, '-A OUTPUT -p udp --dport 5000 -j REDIRECT --to-ports 9090');
    const local: string[] = [];
    const remote: string[] = [];
    inside.udpBind(9090, (d) => local.push(String(d.udp.payload)));
    neighbour.udpBind(5000, (d) => remote.push(String(d.udp.payload)));
    expect(inside.sendUdpDatagram(new IPAddress(NEIGHBOUR_IP), 5000, 40000, 'ping', 4)).toBe(true);
    expect(local).toEqual(['ping']);
    expect(remote).toEqual([]);
    const [flow] = await flows(inside, '-p', 'udp', '--dport', '5000');
    expect(flow).toMatch(new RegExp(`src=${escaped(INSIDE_IP)} dst=${escaped(NEIGHBOUR_IP)} sport=40000 dport=5000 \\[UNREPLIED\\] src=127\\.0\\.0\\.1 dst=${escaped(INSIDE_IP)} sport=9090 dport=40000`));
  });

  it('a rule bound to lo redirects a loopback datagram and leaves a remote one alone', async () => {
    const { inside, neighbour } = await natGateway();
    await nat(inside, '-A OUTPUT -o lo -p udp --dport 5353 -j REDIRECT --to-ports 9090');
    const local: string[] = [];
    const remote: string[] = [];
    inside.udpBind(9090, (d) => local.push(String(d.udp.payload)));
    neighbour.udpBind(5353, (d) => remote.push(String(d.udp.payload)));
    inside.sendUdpDatagram(new IPAddress('127.0.0.1'), 5353, 40000, 'near', 4);
    inside.sendUdpDatagram(new IPAddress(NEIGHBOUR_IP), 5353, 40001, 'far', 3);
    expect(local).toEqual(['near']);
    expect(remote).toEqual(['far']);
  });

  it('a redirected datagram that the INPUT chain of lo drops is lost after a send that succeeded', async () => {
    const { inside } = await natGateway();
    await nat(inside, '-A OUTPUT -p udp --dport 5000 -j REDIRECT --to-ports 9090');
    await sudo(inside, 'iptables -A INPUT -i lo -p udp --dport 9090 -j DROP');
    const local: string[] = [];
    inside.udpBind(9090, (d) => local.push(String(d.udp.payload)));
    expect(inside.sendUdpDatagram(new IPAddress(NEIGHBOUR_IP), 5000, 40000, 'ping', 4)).toBe(true);
    expect(local).toEqual([]);
    expect(await filterPackets(inside, 'INPUT')).toBe(1);
  });

  it('the nat chain is read once per flow : a second datagram from the same port does not count, one from another port does', async () => {
    const { inside, neighbour } = await natGateway();
    await nat(inside, `-A OUTPUT -d ${NOBODY} -p udp --dport 5000 -j DNAT --to-destination ${NEIGHBOUR_IP}:6000`);
    neighbour.udpBind(6000, () => undefined);
    inside.sendUdpDatagram(new IPAddress(NOBODY), 5000, 40000, 'a', 1);
    inside.sendUdpDatagram(new IPAddress(NOBODY), 5000, 40000, 'b', 1);
    expect(await natPackets(inside, 'OUTPUT')).toBe(1);
    inside.sendUdpDatagram(new IPAddress(NOBODY), 5000, 40001, 'c', 1);
    expect(await natPackets(inside, 'OUTPUT')).toBe(2);
  });
});

describe('the two ends of a local flow can both be translated', () => {
  it('an OUTPUT DNAT and a POSTROUTING SNAT apply to the same connection', async () => {
    const { inside, neighbour } = await natGateway();
    await sudo(inside, 'ip addr add 10.0.0.77/24 dev eth0');
    neighbour.getTcpStack().listen(2222, { onAccept: () => undefined });
    await nat(inside,
      `-A OUTPUT -p tcp --dport 8080 -j DNAT --to-destination ${NEIGHBOUR_IP}:2222`,
      `-A POSTROUTING -d ${NEIGHBOUR_IP} -p tcp -j SNAT --to-source 10.0.0.77`);
    const seen = watchHalfOpen(neighbour);
    expect(inside.getTcpStack().connect(NOBODY, 8080)!.state).toBe('established');
    expect(seen[0]).toMatchObject({ remoteIp: '10.0.0.77', localPort: 2222 });
    const [flow] = await flows(inside, '-p', 'tcp');
    expect(flow).toMatch(new RegExp(`dst=${escaped(NOBODY)} sport=\\d+ dport=8080 src=${escaped(NEIGHBOUR_IP)} dst=10\\.0\\.0\\.77 sport=2222`));
  });

  it('the gateway still translates what it forwards while its own OUTPUT chain translates what it opens', async () => {
    const { inside, gateway, outside } = await natGateway();
    await sudo(outside, 'systemctl start ssh');
    await nat(gateway, '-A POSTROUTING -o eth1 -j MASQUERADE');
    await nat(gateway, `-A OUTPUT -d 203.0.113.9 -p tcp --dport 22 -j DNAT --to-destination ${OUTSIDE_IP}:22`);
    expect(await connect(gateway, '203.0.113.9', 22)).toContain('succeeded!');
    expect(await connect(inside, OUTSIDE_IP, 22)).toContain('succeeded!');
  });
});
