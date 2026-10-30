/**
 * Une traduction d'adresse a deux sens. La table nat ne decide que du PREMIER paquet d'un flux ; ce qu'elle decide s'inscrit dans le tuple
 * de reponse du conntrack, et c'est lui qui traduit ensuite chaque paquet des deux sens : SNAT et MASQUERADE reecrivent la source a la
 * sortie et la DESTINATION de la reponse a l'entree, DNAT et REDIRECT la destination a l'entree et la SOURCE de la reponse a la sortie
 * (`nf_nat_packet` : le bit de statut du sens de la reponse est le bit oppose). Le paquet de chaque jambe traverse les crochets dans
 * l'ordre du noyau -- PREROUTING, puis INPUT ou FORWARD et POSTROUTING, ou bien OUTPUT puis POSTROUTING pour ce qu'une machine emet --,
 * en portant la meme entree de suivi, et un flux n'est inscrit qu'une fois, a la fin du dernier crochet.
 *
 * Mesure de depart (cd198baf ; inside 10.0.0.2 -- GW eth0 10.0.0.1 / eth1 203.0.113.1, ip_forward=1 -- outside 203.0.113.2) :
 *     -t nat -A POSTROUTING -o eth1 -j MASQUERADE ; ping de inside vers outside  ->  100 % de perte (la requete part traduite, outside voit
 *                                              203.0.113.1, mais la reponse est adressee a la passerelle, qui la garde)
 *     meme regle ; nc -zv de inside vers outside:22  ->  « Connection timed out » ; un aller-retour UDP : outside recoit, inside ne recoit rien
 *     -t nat -A PREROUTING -p tcp --dport 8022 -j DNAT --to-destination 10.0.0.2:22 ; nc de outside vers GW:8022  ->  « Connection timed out »
 *                                              (le SYN-ACK part sous l'adresse du serveur interne, que la socket du client ne reconnait pas)
 *     apres `iptables -t nat -F`  ->  la source des paquets de inside est encore reecrite (le compteur « -s 203.0.113.1 » de outside passe
 *                                              de 1 a 3) : la machine gardait a part, dans un ensemble que rien ne defaisait, les interfaces
 *                                              ayant recu une regle MASQUERADE, deux ecritures d'un meme fait dont la table n'etait pas la source
 *     -j DNAT sans --to-destination, --to-destination 10.0.0.2:99999, 10.0.0.2:90-80, 10.0.0.2:1:2, 10.0.0.999, deux --to-destination,
 *     -j MASQUERADE --to-ports 70000 ou 90-80, -j REDIRECT --to-ports abc, un port sans -p tcp/udp  ->  acceptes, ou refuses sans les mots d'iptables
 *
 * Autorites : noyau Linux 6.1 -- net/netfilter/nf_nat_core.c (nf_nat_setup_info, get_unique_tuple, nf_nat_used_tuple, nf_nat_packet,
 * nf_nat_inet_fn : le chaine nat n'est lue que pour un flux NEW dont le crochet n'est pas encore initialise, sinon liaison nulle),
 * nf_nat_masquerade.c (nf_nat_masquerade_ipv4 : adresse `inet_select_addr(sortie, saut suivant)`, source 0.0.0.0 laissee telle quelle),
 * nf_nat_redirect.c (nf_nat_redirect_ipv4 : adresse de l'interface d'arrivee en PREROUTING, 127.0.0.1 en OUTPUT), net/ipv4/devinet.c
 * (inet_select_addr), net/netfilter/nf_conntrack_core.c (__nf_conntrack_confirm : un tuple de reponse deja pris rend `insert_failed`) ;
 * iptables 1.8.7 -- extensions/libipt_DNAT.c, libipt_SNAT.c, libipt_MASQUERADE.c, libipt_REDIRECT.c et libxt_DNAT.c (grammaire, messages,
 * impression).
 *
 * Discrimination : contre l'arbre sans le lot (sources remises a leur etat, sonde et support conserves), 71 des 93 cas tombent et 22 passent
 * des deux cotes : trois TEMOINS (sans regle nat l'inside atteint outside sous son adresse ; sans regle DNAT le port transmis ne repond pas ;
 * un port UDP ouvert repond a la sonde de nc, quelle que soit la traduction), la politique FORWARD a DROP sans regle ESTABLISHED (la
 * reponse n'arrivait deja jamais : coincidence), le DROP de la table nat (lot precedent), la plage SNAT qui contient deja l'adresse et le
 * port de la source (le moteur de base laissait toute source intacte : coincidence), douze grammaires que le moteur acceptait deja et
 * quatre impressions que le moteur rendait deja. Les cas des fichiers voisins -- probe-iptables-le-tuple-unique-vient-du-noyau,
 * probe-iptables-chaque-crochet-de-la-table-nat-decide et port-address-toward -- ont leur propre en-tete.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { pingOnSimulatedClock } from '../../support/fastPing';
import {
  natGateway, natPath, nat, sudo, flows, connect, fetchPage, watchSources, escaped, type Host,
  FAR_IP, GATEWAY_OUTSIDE_IP, INSIDE_IP, NEIGHBOUR_IP, OUTSIDE_IP, ROUTER_GATEWAY_SIDE_IP,
} from '../../support/natGateway';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const ping = (host: Host, target = OUTSIDE_IP): Promise<string> => pingOnSimulatedClock(host, `ping -c 1 ${target}`);

describe('MASQUERADE translates the source on the way out and the reply on the way back', () => {
  it('TEMOIN : with no nat rule the inside host reaches the outside host under its own address', async () => {
    const { inside, outside } = await natGateway();
    const seen = await watchSources(outside, 'icmp', INSIDE_IP, GATEWAY_OUTSIDE_IP);
    expect(await ping(inside)).toContain('1 received');
    expect(await seen()).toEqual({ [INSIDE_IP]: 1, [GATEWAY_OUTSIDE_IP]: 0 });
  });

  it('a ping through MASQUERADE is answered, and the outside host saw the egress address', async () => {
    const { inside, gateway, outside } = await natGateway();
    await nat(gateway, '-A POSTROUTING -o eth1 -j MASQUERADE');
    const seen = await watchSources(outside, 'icmp', INSIDE_IP, GATEWAY_OUTSIDE_IP);
    expect(await ping(inside)).toContain('1 received');
    expect(await seen()).toEqual({ [INSIDE_IP]: 0, [GATEWAY_OUTSIDE_IP]: 1 });
  });

  it('the flow keeps the inside address in the original tuple and the egress address in the reply tuple', async () => {
    const { inside, gateway } = await natGateway();
    await nat(gateway, '-A POSTROUTING -o eth1 -j MASQUERADE');
    await ping(inside);
    const [flow] = await flows(gateway, '-p', 'icmp');
    expect(flow).toMatch(new RegExp(`^icmp\\s+1 \\d+ src=${escaped(INSIDE_IP)} dst=${escaped(OUTSIDE_IP)} type=8 code=0 id=\\d+ src=${escaped(OUTSIDE_IP)} dst=${escaped(GATEWAY_OUTSIDE_IP)} type=0 code=0 id=\\d+ `));
  });

  it('a TCP connection through MASQUERADE completes, and the reply tuple is addressed to the egress address', async () => {
    const { inside, gateway, outside } = await natGateway();
    await nat(gateway, '-A POSTROUTING -o eth1 -j MASQUERADE');
    await sudo(outside, 'systemctl start ssh');
    expect(await connect(inside, OUTSIDE_IP, 22)).toContain('succeeded!');
    const lines = await flows(gateway, '-p', 'tcp');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`src=${escaped(INSIDE_IP)} dst=${escaped(OUTSIDE_IP)} sport=\\d+ dport=22 src=${escaped(OUTSIDE_IP)} dst=${escaped(GATEWAY_OUTSIDE_IP)} sport=22 dport=\\d+ \\[ASSURED\\]`));
  });

  it('a page fetched through MASQUERADE arrives whole', async () => {
    const { inside, gateway, outside } = await natGateway();
    await nat(gateway, '-A POSTROUTING -o eth1 -j MASQUERADE');
    await sudo(outside, 'systemctl start nginx');
    expect(await fetchPage(inside, `http://${OUTSIDE_IP}/`)).toContain('Welcome to nginx!');
  });

  it('a UDP round trip through MASQUERADE reaches the inside socket from the outside server', async () => {
    const { inside, gateway, outside } = await natGateway();
    await nat(gateway, '-A POSTROUTING -o eth1 -j MASQUERADE');
    const outsideSaw: string[] = [];
    const insideSaw: string[] = [];
    outside.udpBind(5000, (d) => {
      outsideSaw.push(`${d.sourceIP}:${d.udp.sourcePort}`);
      outside.sendUdpDatagram(d.sourceIP as IPAddress, d.udp.sourcePort, 5000, 'pong', 4);
    });
    inside.udpBind(40000, (d) => insideSaw.push(`${d.udp.payload} from ${d.sourceIP}:${d.udp.sourcePort}`));
    inside.sendUdpDatagram(new IPAddress(OUTSIDE_IP), 5000, 40000, 'ping', 4);
    expect(outsideSaw).toEqual([`${GATEWAY_OUTSIDE_IP}:40000`]);
    expect(insideSaw).toEqual([`pong from ${OUTSIDE_IP}:5000`]);
  });

  it('with the nat table flushed the translation stops : the outside host sees the inside address again', async () => {
    const { inside, gateway, outside } = await natGateway();
    await nat(gateway, '-A POSTROUTING -o eth1 -j MASQUERADE');
    await nat(gateway, '-F');
    const seen = await watchSources(outside, 'icmp', INSIDE_IP, GATEWAY_OUTSIDE_IP);
    expect(await ping(inside)).toContain('1 received');
    expect(await seen()).toEqual({ [INSIDE_IP]: 1, [GATEWAY_OUTSIDE_IP]: 0 });
  });

  it('with the rule deleted the translation stops', async () => {
    const { inside, gateway, outside } = await natGateway();
    await nat(gateway, '-A POSTROUTING -o eth1 -j MASQUERADE');
    await nat(gateway, '-D POSTROUTING -o eth1 -j MASQUERADE');
    const seen = await watchSources(outside, 'icmp', INSIDE_IP, GATEWAY_OUTSIDE_IP);
    expect(await ping(inside)).toContain('1 received');
    expect(await seen()).toEqual({ [INSIDE_IP]: 1, [GATEWAY_OUTSIDE_IP]: 0 });
  });

  it('a MASQUERADE rule bound to another interface leaves the flow alone', async () => {
    const { inside, gateway, outside } = await natGateway();
    await nat(gateway, '-A POSTROUTING -o eth0 -j MASQUERADE');
    const seen = await watchSources(outside, 'icmp', INSIDE_IP, GATEWAY_OUTSIDE_IP);
    expect(await ping(inside)).toContain('1 received');
    expect(await seen()).toEqual({ [INSIDE_IP]: 1, [GATEWAY_OUTSIDE_IP]: 0 });
  });

  it('only the sources the rule names are translated', async () => {
    const { inside, neighbour, gateway, outside } = await natGateway();
    await nat(gateway, `-A POSTROUTING -o eth1 -s ${INSIDE_IP} -j MASQUERADE`);
    const seen = await watchSources(outside, 'icmp', INSIDE_IP, NEIGHBOUR_IP, GATEWAY_OUTSIDE_IP);
    expect(await ping(inside)).toContain('1 received');
    expect(await ping(neighbour)).toContain('1 received');
    expect(await seen()).toEqual({ [INSIDE_IP]: 0, [NEIGHBOUR_IP]: 1, [GATEWAY_OUTSIDE_IP]: 1 });
  });

  it('the egress address is the one of the subnet that faces the next hop, not the first address of the interface', async () => {
    const { inside, gateway, outside } = await natGateway();
    await sudo(gateway, 'ip addr flush dev eth1');
    await sudo(gateway, 'ip addr add 198.51.100.1/24 dev eth1');
    await sudo(gateway, `ip addr add ${GATEWAY_OUTSIDE_IP}/24 dev eth1`);
    await nat(gateway, '-A POSTROUTING -o eth1 -j MASQUERADE');
    const seen = await watchSources(outside, 'icmp', '198.51.100.1', GATEWAY_OUTSIDE_IP);
    expect(await ping(inside)).toContain('1 received');
    expect(await seen()).toEqual({ '198.51.100.1': 0, [GATEWAY_OUTSIDE_IP]: 1 });
  });
});

describe('SNAT, MASQUERADE --to-ports and the unique tuple', () => {
  it('SNAT to an address the gateway owns : the outside host sees it, and the reply comes back', async () => {
    const { inside, gateway, outside } = await natGateway();
    await sudo(gateway, 'ip addr add 203.0.113.9/24 dev eth1');
    await nat(gateway, '-A POSTROUTING -o eth1 -j SNAT --to-source 203.0.113.9');
    const seen = await watchSources(outside, 'icmp', '203.0.113.9', GATEWAY_OUTSIDE_IP);
    expect(await ping(inside)).toContain('1 received');
    expect(await seen()).toEqual({ '203.0.113.9': 1, [GATEWAY_OUTSIDE_IP]: 0 });
  });

  it('a second flow from the same source socket keeps the translated port of the first, when that port is outside the range', async () => {
    const { inside, gateway, outside } = await natGateway();
    await nat(gateway, '-A POSTROUTING -o eth1 -p udp -j SNAT --to-source :1000-2000');
    const seen: Record<number, number[]> = { 5000: [], 5001: [] };
    for (const port of [5000, 5001]) outside.udpBind(port, (d) => { seen[port].push(d.udp.sourcePort); });
    inside.sendUdpDatagram(new IPAddress(OUTSIDE_IP), 5000, 6000, 'first', 5);
    inside.sendUdpDatagram(new IPAddress(OUTSIDE_IP), 5001, 6000, 'second', 6);
    expect(seen[5000]).toHaveLength(1);
    expect(seen[5001]).toEqual(seen[5000]);
    expect(seen[5000][0]).toBeGreaterThanOrEqual(1000);
    expect(seen[5000][0]).toBeLessThanOrEqual(2000);
  });

  it('SNAT with a port range puts the translated source port inside the range', async () => {
    const { inside, gateway, outside } = await natGateway();
    await sudo(gateway, 'ip addr add 203.0.113.9/24 dev eth1');
    await nat(gateway, '-A POSTROUTING -o eth1 -p udp -j SNAT --to-source 203.0.113.9:6000-6003');
    const insideSaw: string[] = [];
    const outsideSaw: number[] = [];
    outside.udpBind(5000, (d) => {
      outsideSaw.push(d.udp.sourcePort);
      outside.sendUdpDatagram(d.sourceIP as IPAddress, d.udp.sourcePort, 5000, 'pong', 4);
    });
    inside.udpBind(40000, (d) => insideSaw.push(`${d.sourceIP}:${d.udp.sourcePort}`));
    inside.sendUdpDatagram(new IPAddress(OUTSIDE_IP), 5000, 40000, 'ping', 4);
    expect(outsideSaw).toHaveLength(1);
    expect(outsideSaw[0]).toBeGreaterThanOrEqual(6000);
    expect(outsideSaw[0]).toBeLessThanOrEqual(6003);
    expect(insideSaw).toEqual([`${OUTSIDE_IP}:5000`]);
  });

  it('SNAT to a range of addresses hands each inside host the address the kernel hashes it to, and the replies come back', async () => {
    const { inside, neighbour, gateway, outside } = await natGateway();
    for (const last of [9, 10, 11, 12]) await sudo(gateway, `ip addr add 203.0.113.${last}/24 dev eth1`);
    await nat(gateway, '-A POSTROUTING -o eth1 -p udp -j SNAT --to-source 203.0.113.9-203.0.113.12');
    const sources: Record<string, string> = {};
    outside.udpBind(5000, (d) => {
      sources[String(d.udp.payload)] = d.sourceIP.toString();
      outside.sendUdpDatagram(d.sourceIP as IPAddress, d.udp.sourcePort, 5000, `for-${d.udp.payload}`, 7);
    });
    const answers: string[] = [];
    inside.udpBind(40000, (d) => answers.push(`inside ${d.udp.payload}`));
    neighbour.udpBind(40000, (d) => answers.push(`neighbour ${d.udp.payload}`));
    inside.sendUdpDatagram(new IPAddress(OUTSIDE_IP), 5000, 40000, 'one', 3);
    neighbour.sendUdpDatagram(new IPAddress(OUTSIDE_IP), 5000, 40000, 'two', 3);
    expect(sources).toEqual({ one: '203.0.113.12', two: '203.0.113.10' });
    expect(answers.sort()).toEqual(['inside for-one', 'neighbour for-two']);
  });

  it('SNAT with ports only keeps the source address and moves the source port into the range', async () => {
    const { inside, gateway, outside } = await natGateway();
    await nat(gateway, '-A POSTROUTING -o eth1 -p udp -j SNAT --to-source :6000-6003');
    const outsideSaw: string[] = [];
    outside.udpBind(5000, (d) => { outsideSaw.push(`${d.sourceIP}:${d.udp.sourcePort}`); });
    inside.sendUdpDatagram(new IPAddress(OUTSIDE_IP), 5000, 40000, 'ping', 4);
    expect(outsideSaw).toHaveLength(1);
    const [, port] = outsideSaw[0].split(':');
    expect(outsideSaw[0].startsWith(`${INSIDE_IP}:`)).toBe(true);
    expect(Number(port)).toBeGreaterThanOrEqual(6000);
    expect(Number(port)).toBeLessThanOrEqual(6003);
  });

  it('SNAT to a range that contains the source address picks the address again when the source port is outside the range', async () => {
    const { inside, gateway, outside } = await natGateway();
    await nat(gateway, '-A POSTROUTING -o eth1 -p udp -j SNAT --to-source 10.0.0.1-10.0.0.9:6000-6003');
    const outsideSaw: string[] = [];
    outside.udpBind(5000, (d) => { outsideSaw.push(`${d.sourceIP}:${d.udp.sourcePort}`); });
    inside.sendUdpDatagram(new IPAddress(OUTSIDE_IP), 5000, 40000, 'ping', 4);
    expect(outsideSaw).toHaveLength(1);
    const [address, port] = outsideSaw[0].split(':');
    expect(address).toBe('10.0.0.9');
    expect(Number(port)).toBeGreaterThanOrEqual(6000);
    expect(Number(port)).toBeLessThanOrEqual(6003);
  });

  it('SNAT to a range that contains the source address and the source port keeps both', async () => {
    const { inside, gateway, outside } = await natGateway();
    await nat(gateway, '-A POSTROUTING -o eth1 -p udp -j SNAT --to-source 10.0.0.1-10.0.0.9:40000-40003');
    const outsideSaw: string[] = [];
    outside.udpBind(5000, (d) => { outsideSaw.push(`${d.sourceIP}:${d.udp.sourcePort}`); });
    inside.sendUdpDatagram(new IPAddress(OUTSIDE_IP), 5000, 40000, 'ping', 4);
    expect(outsideSaw).toEqual([`${INSIDE_IP}:40000`]);
  });

  it('MASQUERADE --to-ports keeps the translated TCP source port inside the range', async () => {
    const { inside, gateway, outside } = await natGateway();
    await nat(gateway, '-A POSTROUTING -o eth1 -p tcp -j MASQUERADE --to-ports 5000-5010');
    await sudo(outside, 'systemctl start ssh');
    expect(await connect(inside, OUTSIDE_IP, 22)).toContain('succeeded!');
    const [flow] = await flows(gateway, '-p', 'tcp');
    const translated = Number(/sport=22 dport=(\d+)/.exec(flow)?.[1]);
    expect(translated).toBeGreaterThanOrEqual(5000);
    expect(translated).toBeLessThanOrEqual(5010);
  });

  it('two inside hosts using the same source port get different translated ports, and both are answered', async () => {
    const { inside, neighbour, gateway, outside } = await natGateway();
    await nat(gateway, '-A POSTROUTING -o eth1 -j MASQUERADE');
    const outsideSaw: number[] = [];
    const answers: string[] = [];
    outside.udpBind(5000, (d) => {
      outsideSaw.push(d.udp.sourcePort);
      outside.sendUdpDatagram(d.sourceIP as IPAddress, d.udp.sourcePort, 5000, `for-${d.udp.payload}`, 7);
    });
    inside.udpBind(40000, (d) => answers.push(`inside ${d.udp.payload}`));
    neighbour.udpBind(40000, (d) => answers.push(`neighbour ${d.udp.payload}`));
    inside.sendUdpDatagram(new IPAddress(OUTSIDE_IP), 5000, 40000, 'one', 3);
    neighbour.sendUdpDatagram(new IPAddress(OUTSIDE_IP), 5000, 40000, 'two', 3);
    expect(outsideSaw).toHaveLength(2);
    expect(outsideSaw[0]).not.toBe(outsideSaw[1]);
    expect(answers.sort()).toEqual(['inside for-one', 'neighbour for-two']);
  });

  it('a ping identifier the gateway already uses is remapped, and both pings are answered', async () => {
    const { inside, gateway } = await natGateway();
    await nat(gateway, '-A POSTROUTING -o eth1 -j MASQUERADE');
    expect(await ping(gateway)).toContain('1 received');
    expect(await ping(inside)).toContain('1 received');
    const lines = await flows(gateway, '-p', 'icmp');
    const replyIds = lines.map((line) => /type=0 code=0 id=(\d+)/.exec(line)?.[1]);
    expect(lines).toHaveLength(2);
    expect(new Set(replyIds).size).toBe(2);
  });

  it('the gateway own traffic goes through its own POSTROUTING : SNAT applies to what it originates', async () => {
    const { gateway, outside } = await natGateway();
    await sudo(gateway, 'ip addr add 203.0.113.9/24 dev eth1');
    await nat(gateway, '-A POSTROUTING -o eth1 -j SNAT --to-source 203.0.113.9');
    const seen = await watchSources(outside, 'icmp', '203.0.113.9', GATEWAY_OUTSIDE_IP);
    expect(await ping(gateway)).toContain('1 received');
    expect(await seen()).toEqual({ '203.0.113.9': 1, [GATEWAY_OUTSIDE_IP]: 0 });
  });
});

describe('DNAT and REDIRECT translate the destination on the way in and the reply on the way out', () => {
  it('TEMOIN : without the rule the forwarded port answers nothing', async () => {
    const { inside, outside } = await natGateway();
    await sudo(inside, 'systemctl start ssh');
    expect(await connect(outside, GATEWAY_OUTSIDE_IP, 8022)).not.toContain('succeeded!');
  });

  it('a DNAT port forward completes the TCP handshake, and the tuples show both sides', async () => {
    const { inside, gateway, outside } = await natGateway();
    await sudo(inside, 'systemctl start ssh');
    await nat(gateway, `-A PREROUTING -p tcp --dport 8022 -j DNAT --to-destination ${INSIDE_IP}:22`);
    expect(await connect(outside, GATEWAY_OUTSIDE_IP, 8022)).toContain('succeeded!');
    const lines = await flows(gateway, '-p', 'tcp');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`src=${escaped(OUTSIDE_IP)} dst=${escaped(GATEWAY_OUTSIDE_IP)} sport=(\\d+) dport=8022 src=${escaped(INSIDE_IP)} dst=${escaped(OUTSIDE_IP)} sport=22 dport=\\1 \\[ASSURED\\]`));
  });

  it('a page fetched through a DNAT port forward arrives whole', async () => {
    const { inside, gateway, outside } = await natGateway();
    await sudo(inside, 'systemctl start nginx');
    await nat(gateway, `-A PREROUTING -p tcp --dport 8080 -j DNAT --to-destination ${INSIDE_IP}:80`);
    expect(await fetchPage(outside, `http://${GATEWAY_OUTSIDE_IP}:8080/`)).toContain('Welcome to nginx!');
  });

  it('the reply of a DNAT UDP flow leaves under the address and port the client dialed', async () => {
    const { inside, gateway, outside } = await natGateway();
    await nat(gateway, `-A PREROUTING -p udp --dport 5300 -j DNAT --to-destination ${INSIDE_IP}:5000`);
    const insideSaw: string[] = [];
    const outsideSaw: string[] = [];
    inside.udpBind(5000, (d) => {
      insideSaw.push(`${d.sourceIP}:${d.udp.sourcePort}`);
      inside.sendUdpDatagram(d.sourceIP as IPAddress, d.udp.sourcePort, 5000, 'pong', 4);
    });
    outside.udpBind(41000, (d) => outsideSaw.push(`${d.sourceIP}:${d.udp.sourcePort}`));
    outside.sendUdpDatagram(new IPAddress(GATEWAY_OUTSIDE_IP), 5300, 41000, 'ping', 4);
    expect(insideSaw).toEqual([`${OUTSIDE_IP}:41000`]);
    expect(outsideSaw).toEqual([`${GATEWAY_OUTSIDE_IP}:5300`]);
  });

  it('a DNAT without a port keeps the port the client dialed', async () => {
    const { inside, gateway, outside } = await natGateway();
    await sudo(inside, 'systemctl start ssh');
    await nat(gateway, `-A PREROUTING -p tcp --dport 22 -j DNAT --to-destination ${INSIDE_IP}`);
    expect(await connect(outside, GATEWAY_OUTSIDE_IP, 22)).toContain('succeeded!');
    const [flow] = await flows(gateway, '-p', 'tcp');
    expect(flow).toMatch(new RegExp(`dport=22 src=${escaped(INSIDE_IP)} dst=${escaped(OUTSIDE_IP)} sport=22 `));
  });

  it('a DNAT of a ping is answered under the address the client pinged', async () => {
    const { gateway, outside } = await natGateway();
    await nat(gateway, `-A PREROUTING -p icmp -j DNAT --to-destination ${INSIDE_IP}`);
    const output = await ping(outside, GATEWAY_OUTSIDE_IP);
    expect(output).toContain(`64 bytes from ${GATEWAY_OUTSIDE_IP}`);
    expect(output).toContain('1 received');
  });

  it('a REDIRECT hands the connection to a local server and the answer leaves under the dialed port', async () => {
    const { gateway, outside } = await natGateway();
    await sudo(gateway, 'systemctl start ssh');
    await nat(gateway, '-A PREROUTING -p tcp --dport 8080 -j REDIRECT --to-ports 22');
    expect(await connect(outside, GATEWAY_OUTSIDE_IP, 8080)).toContain('succeeded!');
    const [flow] = await flows(gateway, '-p', 'tcp');
    expect(flow).toMatch(new RegExp(`src=${escaped(OUTSIDE_IP)} dst=${escaped(GATEWAY_OUTSIDE_IP)} sport=(\\d+) dport=8080 src=${escaped(GATEWAY_OUTSIDE_IP)} dst=${escaped(OUTSIDE_IP)} sport=22 dport=\\1 `));
  });

  it('a page served locally behind a REDIRECT arrives whole', async () => {
    const { gateway, outside } = await natGateway();
    await sudo(gateway, 'systemctl start nginx');
    await nat(gateway, '-A PREROUTING -p tcp --dport 8080 -j REDIRECT --to-ports 80');
    expect(await fetchPage(outside, `http://${GATEWAY_OUTSIDE_IP}:8080/`)).toContain('Welcome to nginx!');
  });

  it('a REDIRECT without --to-ports keeps the port and takes the address of the interface the packet arrived on', async () => {
    const { inside, gateway } = await natGateway();
    await sudo(gateway, 'systemctl start ssh');
    await nat(gateway, '-A PREROUTING -i eth0 -p tcp --dport 22 -j REDIRECT');
    expect(await connect(inside, OUTSIDE_IP, 22)).toContain('succeeded!');
    const [flow] = await flows(gateway, '-p', 'tcp');
    expect(flow).toMatch(new RegExp(`src=${escaped(INSIDE_IP)} dst=${escaped(OUTSIDE_IP)} sport=\\d+ dport=22 src=10\\.0\\.0\\.1 dst=${escaped(INSIDE_IP)} sport=22 `));
  });

  it('a DROP in the nat table kills the connection before any flow is kept', async () => {
    const { inside, gateway, outside } = await natGateway();
    await sudo(inside, 'systemctl start ssh');
    await nat(gateway, '-A PREROUTING -p tcp --dport 8022 -j DROP');
    await nat(gateway, `-A PREROUTING -p tcp --dport 8022 -j DNAT --to-destination ${INSIDE_IP}:22`);
    expect(await connect(outside, GATEWAY_OUTSIDE_IP, 8022)).toContain('timed out');
    expect(await flows(gateway, '-p', 'tcp')).toEqual([]);
  });
});

describe('an ICMP error about a translated packet is translated too', () => {
  it('traceroute through MASQUERADE lists the router beyond the gateway and the far host', async () => {
    const { inside, gateway } = await natPath();
    await nat(gateway, '-A POSTROUTING -o eth1 -j MASQUERADE');
    const output = await pingOnSimulatedClock(inside, `traceroute -n -w 1 -q 1 ${FAR_IP}`);
    expect(output).toMatch(/^\s*1\s+10\.0\.0\.1\s/m);
    expect(output).toMatch(new RegExp(`^\\s*2\\s+${escaped(ROUTER_GATEWAY_SIDE_IP)}\\s`, 'm'));
    expect(output).toMatch(new RegExp(`^\\s*3\\s+${escaped(FAR_IP)}\\s`, 'm'));
  });

  it('traceroute -I (echo probes) through MASQUERADE lists the same hops', async () => {
    const { inside, gateway } = await natPath();
    await nat(gateway, '-A POSTROUTING -o eth1 -j MASQUERADE');
    const output = await pingOnSimulatedClock(inside, `traceroute -I -n -w 1 -q 1 ${FAR_IP}`);
    expect(output).toMatch(new RegExp(`^\\s*2\\s+${escaped(ROUTER_GATEWAY_SIDE_IP)}\\s`, 'm'));
    expect(output).toMatch(new RegExp(`^\\s*3\\s+${escaped(FAR_IP)}\\s`, 'm'));
  });

  it('a DF ping bigger than the MTU of a link beyond the gateway is told that MTU, and the host keeps it', async () => {
    const { inside, gateway, router } = await natPath();
    await nat(gateway, '-A POSTROUTING -o eth1 -j MASQUERADE');
    await sudo(router, 'ip link set dev eth1 mtu 1000');
    const output = await pingOnSimulatedClock(inside, `ping -c 1 -M do -s 1200 ${FAR_IP}`);
    expect(output).toContain(`From ${ROUTER_GATEWAY_SIDE_IP} icmp_seq=1 Frag needed and DF set (mtu = 1000)`);
    expect(await sudo(inside, `ip route get ${FAR_IP}`)).toContain('mtu 1000');
  });

  it('TEMOIN : a UDP port that is open answers the probe of nc, whatever the translation', async () => {
    const { gateway, outside } = await natGateway();
    gateway.udpBind(5998, () => undefined);
    await nat(gateway, '-A PREROUTING -p udp --dport 5301 -j REDIRECT --to-ports 5998');
    expect(await pingOnSimulatedClock(outside, `nc -u -zv -w 2 ${GATEWAY_OUTSIDE_IP} 5301; echo rc=$?`)).toContain('rc=0');
  });

  it('a UDP datagram redirected to a closed local port is refused to the client, under the port it dialed', async () => {
    const { gateway, outside } = await natGateway();
    await nat(gateway, '-A PREROUTING -p udp --dport 5300 -j REDIRECT --to-ports 5999');
    expect(await pingOnSimulatedClock(outside, `nc -u -zv -w 2 ${GATEWAY_OUTSIDE_IP} 5300; echo rc=$?`)).toContain('rc=1');
  });

  it('a UDP datagram forwarded by DNAT to a closed port is refused to the client, from the address it dialed', async () => {
    const { gateway, outside } = await natGateway();
    await nat(gateway, `-A PREROUTING -p udp --dport 5300 -j DNAT --to-destination ${INSIDE_IP}:5999`);
    expect(await pingOnSimulatedClock(outside, `nc -u -zv -w 2 ${GATEWAY_OUTSIDE_IP} 5300; echo rc=$?`)).toContain('rc=1');
  });

  it('a UDP datagram masqueraded toward a closed port is refused to the inside client', async () => {
    const { inside, gateway } = await natPath();
    await nat(gateway, '-A POSTROUTING -o eth1 -j MASQUERADE');
    expect(await pingOnSimulatedClock(inside, `nc -u -zv -w 2 ${FAR_IP} 5999; echo rc=$?`)).toContain('rc=1');
  });
});

describe('the filter table sees the connection once, in the state the translation leaves it', () => {
  it('with FORWARD at DROP and ESTABLISHED accepted, a masqueraded connection still completes', async () => {
    const { inside, gateway, outside } = await natGateway();
    await nat(gateway, '-A POSTROUTING -o eth1 -j MASQUERADE');
    await sudo(gateway, 'iptables -P FORWARD DROP');
    await sudo(gateway, 'iptables -A FORWARD -i eth0 -o eth1 -j ACCEPT');
    await sudo(gateway, 'iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT');
    await sudo(outside, 'systemctl start ssh');
    expect(await connect(inside, OUTSIDE_IP, 22)).toContain('succeeded!');
  });

  it('with FORWARD at DROP and no ESTABLISHED rule, the replies are refused and the connection times out', async () => {
    const { inside, gateway, outside } = await natGateway();
    await nat(gateway, '-A POSTROUTING -o eth1 -j MASQUERADE');
    await sudo(gateway, 'iptables -P FORWARD DROP');
    await sudo(gateway, 'iptables -A FORWARD -i eth0 -o eth1 -j ACCEPT');
    await sudo(outside, 'systemctl start ssh');
    expect(await connect(inside, OUTSIDE_IP, 22)).toContain('timed out');
  });

  it('with FORWARD at DROP and ESTABLISHED,RELATED accepted, the errors of a masqueraded flow still reach the inside host', async () => {
    const { inside, gateway } = await natPath();
    await nat(gateway, '-A POSTROUTING -o eth1 -j MASQUERADE');
    await sudo(gateway, 'iptables -P FORWARD DROP');
    await sudo(gateway, 'iptables -A FORWARD -i eth0 -o eth1 -j ACCEPT');
    await sudo(gateway, 'iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT');
    const output = await pingOnSimulatedClock(inside, `traceroute -n -w 1 -q 1 ${FAR_IP}`);
    expect(output).toMatch(new RegExp(`^\\s*2\\s+${escaped(ROUTER_GATEWAY_SIDE_IP)}\\s`, 'm'));
    expect(output).toMatch(new RegExp(`^\\s*3\\s+${escaped(FAR_IP)}\\s`, 'm'));
  });

  it('a forwarded connection is one flow, whatever the number of hooks it crossed', async () => {
    const { inside, gateway, outside } = await natGateway();
    await nat(gateway, '-A POSTROUTING -o eth1 -j MASQUERADE');
    await sudo(outside, 'systemctl start ssh');
    await connect(inside, OUTSIDE_IP, 22);
    expect(await flows(gateway, '-p', 'tcp')).toHaveLength(1);
  });
});

describe('the nat rule grammar is the one of libipt_DNAT, libipt_SNAT, libipt_MASQUERADE and libipt_REDIRECT', () => {
  const listed = async (rule: string, table = 'nat'): Promise<string[]> => {
    const host = new LinuxPC('H', 0, 0);
    expect(await sudo(host, `iptables -t ${table} ${rule}`)).toBe('');
    return (await sudo(host, `iptables -t ${table} -S`)).split('\n');
  };

  it.each([
    ['-A PREROUTING -p tcp -m tcp --dport 80 -j DNAT --to-destination 10.0.0.2:8080', '-A PREROUTING -p tcp -m tcp --dport 80 -j DNAT --to-destination 10.0.0.2:8080'],
    ['-A PREROUTING -p udp -m udp --dport 53 -j DNAT --to-destination 10.0.0.2-10.0.0.4:5353 --persistent --random', '-A PREROUTING -p udp -m udp --dport 53 -j DNAT --to-destination 10.0.0.2-10.0.0.4:5353 --random --persistent'],
    ['-A PREROUTING -p tcp -m tcp --dport 8000 -j DNAT --to-destination 10.0.0.9:8000-8010/9000', '-A PREROUTING -p tcp -m tcp --dport 8000 -j DNAT --to-destination 10.0.0.9:8000-8010/9000'],
    ['-A POSTROUTING -o eth1 -p tcp -j MASQUERADE --to-ports 1024-2048', '-A POSTROUTING -o eth1 -p tcp -j MASQUERADE --to-ports 1024-2048'],
    ['-A POSTROUTING -o eth1 -j MASQUERADE --random-fully', '-A POSTROUTING -o eth1 -j MASQUERADE --random-fully'],
    ['-A POSTROUTING -o eth2 -p udp -j SNAT --to-source 1.2.3.4-1.2.3.8:100-200 --random', '-A POSTROUTING -o eth2 -p udp -j SNAT --to-source 1.2.3.4-1.2.3.8:100-200 --random'],
    ['-A PREROUTING -p tcp -m tcp --dport 8080 -j REDIRECT --to-ports 3128', '-A PREROUTING -p tcp -m tcp --dport 8080 -j REDIRECT --to-ports 3128'],
    ['-A PREROUTING -p tcp -m tcp --dport 9090 -j REDIRECT', '-A PREROUTING -p tcp -m tcp --dport 9090 -j REDIRECT'],
    ['-A PREROUTING -p tcp -m tcp --dport 80 -j DNAT --to-destination 10.0.0.2:8080-8080', '-A PREROUTING -p tcp -m tcp --dport 80 -j DNAT --to-destination 10.0.0.2:8080'],
    ['-A PREROUTING -p tcp -m tcp --dport 80 -j DNAT --to-destination :8080', '-A PREROUTING -p tcp -m tcp --dport 80 -j DNAT --to-destination :8080'],
    ['-A PREROUTING -p tcp -m tcp --dport 80 -j DNAT --to-destination 10.0.0.2:65535', '-A PREROUTING -p tcp -m tcp --dport 80 -j DNAT --to-destination 10.0.0.2:65535'],
    ['-A PREROUTING -p tcp -m tcp --dport 80 -j DNAT --to-destination 10.0.0.2:8000-8010/65535', '-A PREROUTING -p tcp -m tcp --dport 80 -j DNAT --to-destination 10.0.0.2:8000-8010/65535'],
    ['-A PREROUTING -p tcp -m tcp --dport 80 -j REDIRECT --to-ports 65535', '-A PREROUTING -p tcp -m tcp --dport 80 -j REDIRECT --to-ports 65535'],
    ['-A PREROUTING -p tcp -m tcp --dport 80 -j REDIRECT --to-ports 010', '-A PREROUTING -p tcp -m tcp --dport 80 -j REDIRECT --to-ports 8'],
    ['-A PREROUTING -p tcp -m tcp --dport 80 -j REDIRECT --to-ports 0x1f90', '-A PREROUTING -p tcp -m tcp --dport 80 -j REDIRECT --to-ports 8080'],
    ['-A PREROUTING -p 132 -j DNAT --to-destination 10.0.0.2:8080', '-A PREROUTING -p 132 -j DNAT --to-destination 10.0.0.2:8080'],
    ['-A PREROUTING -p 33 -j DNAT --to-destination 10.0.0.2:8080', '-A PREROUTING -p 33 -j DNAT --to-destination 10.0.0.2:8080'],
    ['-A POSTROUTING -o eth1 -p tcp -j MASQUERADE --to-ports 80-80', '-A POSTROUTING -o eth1 -p tcp -j MASQUERADE --to-ports 80'],
    ['-A POSTROUTING -p icmp -j SNAT --to-source 1.2.3.4:1000-2000', '-A POSTROUTING -p icmp -j SNAT --to-source 1.2.3.4:1000-2000'],
    ['-A POSTROUTING -o eth1 -p icmp -j MASQUERADE --to-ports 1000-2000', '-A POSTROUTING -o eth1 -p icmp -j MASQUERADE --to-ports 1000-2000'],
  ])('%s is saved as %s', async (rule, saved) => {
    expect(await listed(rule)).toContain(saved);
  });

  it.each([
    ['-A PREROUTING -p tcp -m tcp --dport 80 -j DNAT --to-destination 10.0.0.2:8080', 'tcp dpt:80 to:10.0.0.2:8080'],
    ['-A PREROUTING -p udp -m udp --dport 53 -j DNAT --to-destination 10.0.0.2-10.0.0.4:5353 --persistent --random', 'to:10.0.0.2-10.0.0.4:5353 random persistent'],
    ['-A POSTROUTING -o eth1 -p tcp -j MASQUERADE --to-ports 1024-2048', 'masq ports: 1024-2048'],
    ['-A POSTROUTING -o eth1 -j MASQUERADE --random-fully', 'random-fully'],
    ['-A POSTROUTING -o eth2 -p udp -j SNAT --to-source 1.2.3.4-1.2.3.8:100-200 --random', 'to:1.2.3.4-1.2.3.8:100-200 random'],
    ['-A PREROUTING -p tcp -m tcp --dport 8080 -j REDIRECT --to-ports 3128', 'redir ports 3128'],
  ])('%s is listed with %s', async (rule, shown) => {
    const host = new LinuxPC('H', 0, 0);
    await sudo(host, `iptables -t nat ${rule}`);
    expect(await sudo(host, 'iptables -t nat -L -n')).toContain(shown);
  });

  it.each([
    ['-A PREROUTING -j DNAT', 'DNAT: option "--to-destination" must be specified'],
    ['-A PREROUTING -p tcp -j SNAT', 'SNAT: option "--to-source" must be specified'],
    ['-A PREROUTING -p tcp -j DNAT --to-destination 10.0.0.2:99999', "Port `99999' not valid"],
    ['-A PREROUTING -p tcp -j DNAT --to-destination 10.0.0.2:65536', "Port `65536' not valid"],
    ['-A PREROUTING -p tcp -j DNAT --to-destination 10.0.0.2:0', "Port `0' not valid"],
    ['-A PREROUTING -p tcp -j DNAT --to-destination 10.0.0.2:80-0', "Port `0' not valid"],
    ['-A PREROUTING -p tcp -j DNAT --to-destination 10.0.0.2:80-99999', "Port `99999' not valid"],
    ['-A PREROUTING -p tcp -j DNAT --to-destination 10.0.0.2:80-90/99999', "Port `99999' not valid"],
    ['-A PREROUTING -p 34 -j DNAT --to-destination 10.0.0.2:8080', 'Need TCP, UDP, SCTP or DCCP with port specification'],
    ['-A PREROUTING -p 133 -j DNAT --to-destination 10.0.0.2:8080', 'Need TCP, UDP, SCTP or DCCP with port specification'],
    ['-A POSTROUTING -p udplite -j SNAT --to-source 1.2.3.4:1000-2000', 'Need TCP, UDP, SCTP or DCCP with port specification'],
    ['-A POSTROUTING -o eth1 -p udplite -j MASQUERADE --to-ports 1000-2000', 'Need TCP, UDP, SCTP or DCCP with port specification'],
    ['-A PREROUTING -p tcp -j DNAT --to-destination 10.0.0.2:90-80', "Port range `90-80' funky"],
    ['-A PREROUTING -p tcp -j DNAT --to-destination 10.0.0.2:1:2', 'Invalid port:port syntax - use dash'],
    ['-A PREROUTING -j DNAT --to-destination 10.0.0.2:80', 'Need TCP, UDP, SCTP or DCCP with port specification'],
    ['-A PREROUTING -p tcp -j DNAT --to-destination 10.0.0.999', 'Bad IP address "10.0.0.999"'],
    ['-A PREROUTING -p tcp -j DNAT --to-destination 10.0.0.1 --to-destination 10.0.0.2', 'DNAT: Multiple --to-destination not supported'],
    ['-A POSTROUTING -p tcp -j MASQUERADE --to-ports 70000', 'MASQUERADE: Bad value for "--to-ports" option: "70000"'],
    ['-A POSTROUTING -p tcp -j MASQUERADE --to-ports 65536', 'MASQUERADE: Bad value for "--to-ports" option: "65536"'],
    ['-A POSTROUTING -j MASQUERADE --to-ports 80', 'Need TCP, UDP, SCTP or DCCP with port specification'],
    ['-A POSTROUTING -p tcp -j MASQUERADE --to-ports 90-80', 'MASQUERADE: Bad value for "--to-ports" option: "90-80"'],
    ['-A PREROUTING -p tcp -j REDIRECT --to-ports abc', 'REDIRECT: Bad value for "--to-ports" option: "abc"'],
    ['-A POSTROUTING -p tcp -j MASQUERADE --to-ports 80-abc', 'MASQUERADE: Bad value for "--to-ports" option: "80-abc"'],
    ['-A PREROUTING -p tcp -j DNAT --to-destination -10.0.0.1', 'Bad IP address ""'],
  ])('%s is refused with %s', async (rule, problem) => {
    const host = new LinuxPC('H', 0, 0);
    const output = await sudo(host, `iptables -t nat ${rule}`);
    expect(output).toContain(`iptables v1.8.7 (nf_tables): ${problem}`);
    expect(await sudo(host, 'iptables -t nat -S')).not.toMatch(/^-A /m);
  });
});
