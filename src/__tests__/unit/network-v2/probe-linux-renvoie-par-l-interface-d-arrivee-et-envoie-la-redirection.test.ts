/**
 * Un routeur Linux renvoie un paquet par l'interface par laquelle il est arrive, et il dit alors a l'emetteur le chemin plus court.
 * `ip_forward` (net/ipv4/ip_forward.c) ne jette rien de tel : il verifie le TTL, puis la MTU d'un paquet DF (`Frag needed` part AVANT
 * le crochet FORWARD), puis envoie la redirection (`ip_rt_send_redirect`, elle aussi AVANT le crochet), puis passe la chaine FORWARD.
 * La redirection est due quand la sortie est l'interface d'arrivee, que la source est directement connectee par cette interface
 * (`fib_validate_source` rend 1) et que l'interface envoie des redirections (`send_redirects`, OU de `all` et de l'interface) ;
 * `shared_media` ou une passerelle sur le lien de la source decide du reste (`__mkroute_input`). Neuf redirections au plus par
 * source, avec une attente qui double (`ip_rt_redirect_load` 20 ms), puis le silence tant que la source continue (`ip_rt_redirect_silence`).
 *
 * Mesure de depart (arbre portant les lots NAT precedents ; A 10.0.0.2 et B 10.0.1.2 sur un concentrateur, la passerelle porte
 * 10.0.0.1/24 et 10.0.1.1/24 sur eth0, ip_forward=1) :
 *     ping de A vers B  ->  100 % de perte (`EndHost.forwardIPv4` rendait la main sur `outPortName === inPort`, sans un mot)
 *     DNAT 203.0.113.1:8022 -> 10.0.0.2:22 et MASQUERADE de 10.0.0.0/24 vers 10.0.0.2, nc d'un voisin  ->  « Connection timed out »
 *     sysctl net.ipv4.conf.all.send_redirects  ->  « cannot stat /proc/sys/net/ipv4/conf/all/send_redirects »
 *     un paquet DF plus gros que la MTU de sortie, FORWARD a DROP  ->  rien ne revenait (la base filtrait avant de mesurer)
 *
 * Autorites : noyau Linux 6.1 -- net/ipv4/ip_forward.c, net/ipv4/route.c (__mkroute_input : IPSKB_DOREDIRECT ; ip_rt_send_redirect ;
 * __ip_do_redirect : ce que fait l'hote qui recoit), include/linux/inetdevice.h (IN_DEV_ORCONF, IN_DEV_ANDCONF, IN_DEV_RX_REDIRECTS),
 * net/ipv4/devinet.c (valeurs par defaut, devinet_copy_dflt_conf, inet_forward_change : `all/accept_redirects` suit `ip_forward`),
 * net/ipv4/icmp.c (__icmp_send : une redirection n'est pas limitee par le masque de debit des erreurs). iputils ping compte une
 * redirection parmi les erreurs et s'arrete a `recues + erreurs >= -c`, ce que les sorties ci-dessous reprennent.
 *
 * Discrimination : contre l'arbre sans le lot (support et sonde conserves), 42 des 55 cas tombent et 13 passent des deux cotes : quatre
 * TEMOINS (une interface par sous-reseau ne redirige pas ; ip_forward a 0 ne transmet ni ne redirige ; le meme DNAT sert un client du
 * reseau exterieur ; avant toute redirection la route d'un hote passe par sa passerelle), la politique FORWARD a DROP (la base jetait
 * deja tout), le TTL qui expire (le « Time Exceeded » part des deux cotes), le DNAT seul d'un client interne (l'echec du noyau est aussi
 * celui de la base : la reponse du serveur ne porte pas l'adresse que le client a composee), deux non-regressions que la base tenait
 * deja (une redirection qui nomme la passerelle d'ou elle vient ne change rien ; le parametre d'une interface qui n'existe pas ne se
 * lit pas) et quatre absences (les codes 4 a 7 ne sont pas une redirection :
 * la base ne prenait aucune redirection venue du constructeur de ce lot, l'absence est la meme des deux cotes, et les quatre cas voisins
 * des codes 0 a 3, qui tombent, en sont le temoin). Les deux fichiers voisins, icmp-redirect-rules et
 * ipv4-device-conf, ne peuvent pas charger contre la base : les modules qu'ils lisent n'y existaient pas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ETHERTYPE_IPV4, IP_PROTO_ICMP, IPAddress, MACAddress, SubnetMask, createIPv4Packet, resetCounters,
  type EthernetFrame, type ICMPPacket,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { buildICMPError, ICMP_REDIRECT_HOST } from '@/network/core/IcmpErrors';
import { pingOnSimulatedClock } from '../../support/fastPing';
import { natGateway, sudo, connect, flows, watchSources, escaped, type Host } from '../../support/natGateway';
import {
  routerOnAStick, stickWithRouterBehind, STICK_A_IP, STICK_B_IP, STICK_GATEWAY_A_SIDE_IP, STICK_GATEWAY_B_SIDE_IP,
  BEHIND_IP, type StickLab,
} from '../../support/routerOnAStick';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const pingFromA = (lab: StickLab, command: string): Promise<string> => pingOnSimulatedClock(lab.a, command, [lab.b, lab.gateway]);
const redirectLines = (text: string): string[] => text.split('\n').filter((line) => line.includes('Redirect'));
const redirectedSequences = (text: string): number[] => [...text.matchAll(/icmp_seq=(\d+) Redirect/g)].map((match) => Number(match[1]));
const replyTtls = (text: string): number[] => [...text.matchAll(/icmp_seq=\d+ ttl=(\d+)/g)].map((match) => Number(match[1]));
const statistics = (text: string): string => text.split('\n').find((line) => line.includes('packets transmitted')) ?? '';
const noRedirects = { all: 0, eth0: 0 };

async function setRedirectKnob(host: Host, knob: string, scopes: Record<string, number>): Promise<void> {
  for (const [scope, value] of Object.entries(scopes)) {
    expect(await sudo(host, `sysctl -w net.ipv4.conf.${scope}.${knob}=${value}`)).toContain(`${knob} = ${value}`);
  }
}

async function ruleHits(host: Host, chain: string, source: string, destination: string): Promise<number> {
  const listing = await sudo(host, `iptables -L ${chain} -v -n`);
  const row = listing.split('\n').find((line) => new RegExp(`^\\s*\\d+\\s+\\d+\\s+ACCEPT\\s+icmp\\s+--\\s+\\*\\s+\\*\\s+${escaped(source)}\\s+${escaped(destination)}`).test(line)) ?? '';
  return Number(row.trim().split(/\s+/)[0]);
}

describe('a Linux gateway forwards what arrives on an interface back out of the same interface', () => {
  it('TEMOIN : a gateway with one interface per subnet answers a ping between them and sends no redirect', async () => {
    const { inside, outside } = await natGateway();
    const text = await pingOnSimulatedClock(inside, `ping -c 3 -W 1 ${outside.getPort('eth0')!.getIPAddress()}`);
    expect(replyTtls(text)).toEqual([63, 63, 63]);
    expect(redirectLines(text)).toEqual([]);
  });

  it('a ping between the two subnets of a gateway that holds both on eth0 is answered', async () => {
    const lab = await routerOnAStick();
    const text = await pingFromA(lab, `ping -c 3 -W 1 ${STICK_B_IP}`);
    expect(replyTtls(text)[0]).toBe(63);
    expect(statistics(text)).toMatch(/ 0% packet loss/);
  });

  it('a TCP connection between the two subnets completes', async () => {
    const lab = await routerOnAStick();
    expect(await connect(lab.a, STICK_B_IP, 22)).toContain('succeeded');
  });

  it('the packets that go back out of the arrival interface cross the FORWARD chain', async () => {
    const lab = await routerOnAStick();
    await sudo(lab.gateway, `iptables -A FORWARD -s ${STICK_A_IP} -d ${STICK_B_IP} -p icmp -j ACCEPT`);
    await sudo(lab.gateway, `iptables -A FORWARD -s ${STICK_B_IP} -d ${STICK_A_IP} -p icmp -j ACCEPT`);
    await pingFromA(lab, `ping -c 1 -W 1 ${STICK_B_IP}`);
    expect(await ruleHits(lab.gateway, 'FORWARD', STICK_A_IP, STICK_B_IP)).toBe(1);
    expect(await ruleHits(lab.gateway, 'FORWARD', STICK_B_IP, STICK_A_IP)).toBe(1);
  });

  it('a FORWARD policy of DROP stops them, as it stops any forwarded packet', async () => {
    const lab = await routerOnAStick();
    await sudo(lab.gateway, 'iptables -P FORWARD DROP');
    expect(statistics(await pingFromA(lab, `ping -c 2 -W 1 ${STICK_B_IP}`))).toMatch(/ 100% packet loss/);
  });

  it('TEMOIN : with ip_forward at 0 the gateway forwards nothing and sends no redirect', async () => {
    const lab = await routerOnAStick();
    await sudo(lab.gateway, 'sysctl -w net.ipv4.ip_forward=0');
    const text = await pingFromA(lab, `ping -c 2 -W 1 ${STICK_B_IP}`);
    expect(statistics(text)).toMatch(/ 100% packet loss/);
    expect(redirectLines(text)).toEqual([]);
  });
});

describe('the gateway tells the sender the shorter path, as ip_rt_send_redirect does', () => {
  it('the first echo is answered, and the sender is told to talk to the destination itself', async () => {
    const lab = await routerOnAStick();
    const text = await pingFromA(lab, `ping -c 6 -W 1 ${STICK_B_IP}`);
    expect(redirectLines(text)[0]).toBe(`From ${STICK_GATEWAY_A_SIDE_IP} icmp_seq=1 Redirect Host(New nexthop: ${STICK_B_IP})`);
    expect(replyTtls(text)[0]).toBe(63);
  });

  it('once the redirect is taken the two hosts talk directly, one hop shorter', async () => {
    const lab = await routerOnAStick();
    const text = await pingFromA(lab, `ping -c 8 -W 1 ${STICK_B_IP}`);
    const ttls = replyTtls(text);
    expect(ttls[0]).toBe(63);
    expect(ttls[ttls.length - 1]).toBe(64);
  });

  it('the redirect to the other subnet leaves from the address of that subnet', async () => {
    const lab = await routerOnAStick();
    const text = await pingOnSimulatedClock(lab.b, `ping -c 6 -W 1 ${STICK_A_IP}`, [lab.a, lab.gateway]);
    expect(redirectLines(text)[0]).toBe(`From ${STICK_GATEWAY_B_SIDE_IP} icmp_seq=1 Redirect Host(New nexthop: ${STICK_A_IP})`);
  });

  it('send_redirects at 0 silences the gateway and every echo keeps going through it', async () => {
    const lab = await routerOnAStick();
    await setRedirectKnob(lab.gateway, 'send_redirects', noRedirects);
    const text = await pingFromA(lab, `ping -c 4 -W 1 ${STICK_B_IP}`);
    expect(redirectLines(text)).toEqual([]);
    expect(replyTtls(text)).toEqual([63, 63, 63, 63]);
  });

  it.each([
    ['all at 0, the interface at 1', { all: 0, eth0: 1 }, true],
    ['all at 1, the interface at 0', { all: 1, eth0: 0 }, true],
    ['all and the interface at 0', { all: 0, eth0: 0 }, false],
  ])('send_redirects with %s: redirect sent is %s', async (_label, scopes, sent) => {
    const lab = await routerOnAStick();
    await setRedirectKnob(lab.gateway, 'send_redirects', scopes);
    expect(redirectLines(await pingFromA(lab, `ping -c 6 -W 1 ${STICK_B_IP}`)).length > 0).toBe(sent);
  });

  it('a source that sits behind another router is not directly connected, so it gets no redirect', async () => {
    const lab = await stickWithRouterBehind();
    const text = await pingOnSimulatedClock(lab.behind, `ping -c 3 -W 1 ${STICK_B_IP}`, [lab.a, lab.b, lab.gateway, lab.router]);
    expect(redirectLines(text)).toEqual([]);
    expect(statistics(text)).toMatch(/ 0% packet loss/);
  });

  it('shared_media at 1 advises a next hop that sits on another subnet of the interface', async () => {
    const lab = await stickWithRouterBehind('10.0.1.254');
    const text = await pingOnSimulatedClock(lab.a, `ping -c 3 -W 1 ${BEHIND_IP}`, [lab.b, lab.gateway, lab.router, lab.behind]);
    expect(redirectLines(text)[0]).toBe(`From ${STICK_GATEWAY_A_SIDE_IP} icmp_seq=1 Redirect Host(New nexthop: 10.0.1.254)`);
  });

  it('shared_media at 0 advises only a next hop that shares a subnet with the source', async () => {
    const lab = await stickWithRouterBehind('10.0.1.254');
    await setRedirectKnob(lab.gateway, 'shared_media', noRedirects);
    const text = await pingOnSimulatedClock(lab.a, `ping -c 3 -W 1 ${BEHIND_IP}`, [lab.b, lab.gateway, lab.router, lab.behind]);
    expect(redirectLines(text)).toEqual([]);
    expect(statistics(text)).toMatch(/ 0% packet loss/);
  });

  it('a next hop on the source subnet is advised whatever shared_media says', async () => {
    const lab = await stickWithRouterBehind();
    await setRedirectKnob(lab.gateway, 'shared_media', noRedirects);
    const text = await pingOnSimulatedClock(lab.a, `ping -c 3 -W 1 ${BEHIND_IP}`, [lab.b, lab.gateway, lab.router, lab.behind]);
    expect(redirectLines(text)[0]).toBe(`From ${STICK_GATEWAY_A_SIDE_IP} icmp_seq=1 Redirect Host(New nexthop: 10.0.0.254)`);
  });

  it('a sender that ignores them is told nine times with exponential back-off, then left alone', async () => {
    const lab = await routerOnAStick();
    await setRedirectKnob(lab.a, 'accept_redirects', noRedirects);
    const text = await pingFromA(lab, `ping -c 30 -W 1 ${STICK_B_IP}`);
    expect(redirectedSequences(text)).toEqual([1, 2, 3, 4, 5, 6, 8, 11, 17]);
    expect(statistics(text)).toMatch(/^21 packets transmitted, 21 received, \+9 errors/);
  });

  it('the redirect is sent before the FORWARD chain decides, so a dropped packet still gets one', async () => {
    const lab = await routerOnAStick();
    await sudo(lab.gateway, 'iptables -P FORWARD DROP');
    const text = await pingFromA(lab, `ping -c 1 -W 1 ${STICK_B_IP}`);
    expect(redirectedSequences(text)).toEqual([1]);
    expect(replyTtls(text)).toEqual([]);
  });

  it('an echo whose TTL runs out gets Time Exceeded and no redirect', async () => {
    const lab = await routerOnAStick();
    const text = await pingFromA(lab, `ping -c 1 -W 1 -t 1 ${STICK_B_IP}`);
    expect(text).toContain('Time to live exceeded');
    expect(redirectLines(text)).toEqual([]);
  });

  it('a DF datagram bigger than the interface MTU gets Frag needed before the FORWARD chain, and no redirect', async () => {
    const lab = await routerOnAStick();
    await sudo(lab.gateway, 'ip link set dev eth0 mtu 1400');
    await sudo(lab.gateway, 'iptables -P FORWARD DROP');
    const text = await pingFromA(lab, `ping -c 1 -W 1 -M do -s 1450 ${STICK_B_IP}`);
    expect(text).toContain('Frag needed and DF set (mtu = 1400)');
    expect(redirectLines(text)).toEqual([]);
  });

  it('a DF datagram exactly as big as the interface MTU is forwarded, and one byte more is refused', async () => {
    const lab = await routerOnAStick();
    await sudo(lab.gateway, 'ip link set dev eth0 mtu 1400');
    expect(await pingFromA(lab, `ping -c 1 -W 1 -M do -s 1372 ${STICK_B_IP}`)).toContain('1 received');
    expect(await pingFromA(lab, `ping -c 1 -W 1 -M do -s 1373 ${STICK_B_IP}`)).toContain('Frag needed and DF set (mtu = 1400)');
  });

  it('a datagram that may be fragmented and is bigger than the MTU is cut in pieces and delivered, not refused', async () => {
    const lab = await routerOnAStick();
    await sudo(lab.gateway, 'ip link set dev eth0 mtu 1400');
    const text = await pingFromA(lab, `ping -c 1 -W 1 -M dont -s 1450 ${STICK_B_IP}`);
    expect(text).toContain('1 received');
    expect(text).not.toContain('Frag needed');
  });
});

describe('a host takes a redirect according to accept_redirects, and a router does not take them', () => {
  it('a sender that accepts the redirect stops going through the gateway after the second one', async () => {
    const lab = await routerOnAStick();
    await sudo(lab.gateway, `iptables -A FORWARD -s ${STICK_A_IP} -d ${STICK_B_IP} -p icmp -j ACCEPT`);
    await pingFromA(lab, `ping -c 8 -W 1 ${STICK_B_IP}`);
    expect(await ruleHits(lab.gateway, 'FORWARD', STICK_A_IP, STICK_B_IP)).toBe(2);
  });

  it('TEMOIN : a sender that refuses redirects still reports them, and keeps going through the gateway', async () => {
    const lab = await routerOnAStick();
    await setRedirectKnob(lab.a, 'accept_redirects', noRedirects);
    await sudo(lab.gateway, `iptables -A FORWARD -s ${STICK_A_IP} -d ${STICK_B_IP} -p icmp -j ACCEPT`);
    const text = await pingFromA(lab, `ping -c 8 -W 1 ${STICK_B_IP}`);
    expect(redirectLines(text).length).toBeGreaterThan(0);
    expect(await ruleHits(lab.gateway, 'FORWARD', STICK_A_IP, STICK_B_IP)).toBeGreaterThan(2);
  });

  it('enabling ip_forward turns accept_redirects off for all, disabling it turns it back on', async () => {
    const { gateway } = await routerOnAStick();
    expect(await sudo(gateway, 'sysctl net.ipv4.conf.all.accept_redirects')).toBe('net.ipv4.conf.all.accept_redirects = 0');
    await sudo(gateway, 'sysctl -w net.ipv4.ip_forward=0');
    expect(await sudo(gateway, 'sysctl net.ipv4.conf.all.accept_redirects')).toBe('net.ipv4.conf.all.accept_redirects = 1');
  });

  it('a second write of the value ip_forward already has changes nothing', async () => {
    const { gateway } = await routerOnAStick();
    await setRedirectKnob(gateway, 'accept_redirects', { all: 1 });
    await sudo(gateway, 'sysctl -w net.ipv4.ip_forward=1');
    expect(await sudo(gateway, 'sysctl net.ipv4.conf.all.accept_redirects')).toBe('net.ipv4.conf.all.accept_redirects = 1');
  });
});

describe('a host judges the redirect it receives as __ip_do_redirect does', () => {
  const FAR = '198.51.100.9';
  const NEIGHBOUR = '10.0.0.3';
  const SECOND_SUBNET_ADDRESS = '10.0.1.5';
  const echoRequest: ICMPPacket = { type: 'icmp', icmpType: 'echo-request', code: 0, id: 1, sequence: 1, dataSize: 8 };

  async function receiverLab(): Promise<StickLab> {
    const lab = await routerOnAStick();
    const neighbour = new LinuxPC('linux-pc', 'C');
    neighbour.configureInterface('eth0', new IPAddress(NEIGHBOUR), new SubnetMask('255.255.255.0'));
    new Cable('neighbour').connect(neighbour.getPort('eth0')!, lab.hub.getPort('eth3')!);
    await pingOnSimulatedClock(lab.a, `ping -c 1 -W 1 ${NEIGHBOUR}`, [neighbour]);
    return lab;
  }

  function redirect(lab: StickLab, gateway: string, code: number = ICMP_REDIRECT_HOST): void {
    const port = lab.a.getPort('eth0')!;
    const quoted = createIPv4Packet(new IPAddress(STICK_A_IP), new IPAddress(FAR), IP_PROTO_ICMP, 63, echoRequest, 8);
    port.receiveFrame({
      srcMAC: lab.gateway.getPort('eth0')!.getMAC(), dstMAC: port.getMAC(), etherType: ETHERTYPE_IPV4,
      payload: buildICMPError(new IPAddress(STICK_GATEWAY_A_SIDE_IP), quoted, 'redirect', code, 64, { gateway: new IPAddress(gateway) }),
    } as EthernetFrame);
  }

  const routeToFar = async (lab: StickLab): Promise<string> => (await sudo(lab.a, `ip route get ${FAR}`)).split('\n')[0];
  const viaGateway = `${FAR} via ${STICK_GATEWAY_A_SIDE_IP} dev eth0`;
  const viaNeighbour = `${FAR} via ${NEIGHBOUR} dev eth0`;
  const noSharedMedia = { all: 0, eth0: 0 };

  it('TEMOIN : before any redirect the route goes through the gateway', async () => {
    expect(await routeToFar(await receiverLab())).toContain(viaGateway);
  });

  it('a redirect to a neighbour of the link is taken, and the route says so', async () => {
    const lab = await receiverLab();
    redirect(lab, NEIGHBOUR);
    expect(await sudo(lab.a, `ip route get ${FAR}`)).toContain(`${viaNeighbour} src 10.0.0.2 uid 0 \n    cache <redirected>`);
  });

  it('a redirect that names the gateway it came from changes nothing', async () => {
    const lab = await receiverLab();
    redirect(lab, STICK_GATEWAY_A_SIDE_IP);
    expect(await sudo(lab.a, `ip route get ${FAR}`)).not.toContain('redirected');
  });

  it.each([
    [0, 'network'],
    [1, 'host'],
    [2, 'network and type of service'],
    [3, 'host and type of service'],
  ])('a redirect of code %i, for a %s, is taken', async (code) => {
    const lab = await receiverLab();
    redirect(lab, NEIGHBOUR, code);
    expect(await routeToFar(lab)).toContain(viaNeighbour);
  });

  it.each([4, 5, 6, 7])('a redirect of code %i is no redirect at all', async (code) => {
    const lab = await receiverLab();
    redirect(lab, NEIGHBOUR, code);
    expect(await routeToFar(lab)).toContain(viaGateway);
  });

  it('the code is read modulo 8 : 9 is a host redirect, and 4 is nothing', async () => {
    const lab = await receiverLab();
    redirect(lab, NEIGHBOUR, 4);
    expect(await routeToFar(lab)).toContain(viaGateway);
    redirect(lab, NEIGHBOUR, 9);
    expect(await routeToFar(lab)).toContain(viaNeighbour);
  });

  it('a gateway that nothing routes to is refused, whatever the media', async () => {
    const lab = await receiverLab();
    await sudo(lab.a, 'ip route del default');
    await sudo(lab.a, `ip route add 198.51.100.0/24 via ${STICK_GATEWAY_A_SIDE_IP}`);
    const asked: string[] = [];
    lab.a.getBus().subscribe('port.frame.tx-requested', (event: unknown) => {
      const packet = (event as { payload: { frame: EthernetFrame } }).payload.frame.payload as { type?: string; targetIP?: unknown };
      if (packet.type === 'arp') asked.push(String(packet.targetIP));
    });
    redirect(lab, '192.0.2.77');
    expect(await routeToFar(lab)).toContain(viaGateway);
    expect(asked).toEqual([]);
    redirect(lab, NEIGHBOUR);
    expect(await routeToFar(lab)).toContain(viaNeighbour);
  });

  it('on shared media a gateway of another subnet of the interface is taken, off shared media it is not', async () => {
    const lab = await receiverLab();
    await sudo(lab.a, `ip addr add ${SECOND_SUBNET_ADDRESS}/24 dev eth0`);
    await pingOnSimulatedClock(lab.a, `ping -c 1 -W 1 ${STICK_B_IP}`, [lab.b, lab.gateway]);
    await setRedirectKnob(lab.a, 'shared_media', noSharedMedia);
    redirect(lab, STICK_B_IP);
    expect(await routeToFar(lab)).toContain(viaGateway);
    await setRedirectKnob(lab.a, 'shared_media', { all: 1 });
    redirect(lab, STICK_B_IP);
    expect(await routeToFar(lab)).toContain(`${FAR} via ${STICK_B_IP} dev eth0`);
  });

  it('off shared media with secure_redirects, only a gateway the host already lists is taken', async () => {
    const lab = await receiverLab();
    await setRedirectKnob(lab.a, 'shared_media', noSharedMedia);
    redirect(lab, NEIGHBOUR);
    expect(await routeToFar(lab)).toContain(viaGateway);
    await sudo(lab.a, `ip route add 203.0.113.0/24 via ${NEIGHBOUR}`);
    redirect(lab, NEIGHBOUR);
    expect(await routeToFar(lab)).toContain(viaNeighbour);
  });

  it('off shared media and without secure_redirects, a gateway on the link of the old one is taken', async () => {
    const lab = await receiverLab();
    await setRedirectKnob(lab.a, 'shared_media', noSharedMedia);
    await setRedirectKnob(lab.a, 'secure_redirects', noRedirects);
    redirect(lab, NEIGHBOUR);
    expect(await routeToFar(lab)).toContain(viaNeighbour);
  });
});

describe('hairpin NAT : a client of the inside network reaches the inside server through the public address', () => {
  const dnat = 'PREROUTING -p tcp --dport 8022 -d 203.0.113.1 -j DNAT --to-destination 10.0.0.2:22';
  const hairpinMasquerade = 'POSTROUTING -s 10.0.0.0/24 -d 10.0.0.2 -p tcp --dport 22 -j MASQUERADE';

  it('TEMOIN : the same DNAT serves a client of the outside network', async () => {
    const { gateway, outside } = await natGateway();
    await sudo(gateway, `iptables -t nat -A ${dnat}`);
    expect(await connect(outside, '203.0.113.1', 8022)).toContain('succeeded');
  });

  it('DNAT alone does not complete : the server answers the client directly, under its own address', async () => {
    const { gateway, neighbour } = await natGateway();
    await sudo(gateway, `iptables -t nat -A ${dnat}`);
    expect(await connect(neighbour, '203.0.113.1', 8022)).toContain('timed out');
  });

  it('DNAT and a MASQUERADE of the inside network complete the handshake', async () => {
    const { gateway, neighbour } = await natGateway();
    await sudo(gateway, `iptables -t nat -A ${dnat}`);
    await sudo(gateway, `iptables -t nat -A ${hairpinMasquerade}`);
    expect(await connect(neighbour, '203.0.113.1', 8022)).toContain('succeeded');
  });

  it('the server sees the gateway as the client, and the flow keeps the address the client dialed', async () => {
    const { gateway, neighbour, inside } = await natGateway();
    await sudo(gateway, `iptables -t nat -A ${dnat}`);
    await sudo(gateway, `iptables -t nat -A ${hairpinMasquerade}`);
    const seen = await watchSources(inside, 'tcp', '10.0.0.1', '10.0.0.3');
    await connect(neighbour, '203.0.113.1', 8022);
    const hits = await seen();
    expect(hits['10.0.0.1']).toBeGreaterThan(0);
    expect(hits['10.0.0.3']).toBe(0);
    expect((await flows(gateway, '-p', 'tcp', '--dport', '8022'))[0]).toMatch(
      /src=10\.0\.0\.3 dst=203\.0\.113\.1 sport=\d+ dport=8022 src=10\.0\.0\.2 dst=10\.0\.0\.1 sport=22 dport=\d+/);
  });
});

describe('the redirect knobs are kernel parameters', () => {
  it.each(['all', 'default', 'eth0'])('conf/%s carries accept_redirects, send_redirects, secure_redirects and shared_media', async (scope) => {
    const { gateway } = await routerOnAStick();
    const values = await Promise.all(['send_redirects', 'secure_redirects', 'shared_media'].map((knob) => sudo(gateway, `cat /proc/sys/net/ipv4/conf/${scope}/${knob}`)));
    expect(values).toEqual(['1', '1', '1']);
  });

  it('sysctl and /proc/sys answer the same about the same knob', async () => {
    const { gateway } = await routerOnAStick();
    await sudo(gateway, 'sysctl -w net.ipv4.conf.eth0.send_redirects=0');
    expect(await sudo(gateway, 'cat /proc/sys/net/ipv4/conf/eth0/send_redirects')).toBe('0');
    expect(await sudo(gateway, 'sysctl net.ipv4.conf.eth0.send_redirects')).toBe('net.ipv4.conf.eth0.send_redirects = 0');
  });

  it('a value written to default reaches the interfaces nobody wrote to, and only those', async () => {
    const { gateway } = await routerOnAStick();
    await sudo(gateway, 'sysctl -w net.ipv4.conf.default.send_redirects=0');
    expect(await sudo(gateway, 'sysctl -n net.ipv4.conf.eth0.send_redirects')).toBe('0');
    await sudo(gateway, 'sysctl -w net.ipv4.conf.eth0.send_redirects=1');
    await sudo(gateway, 'sysctl -w net.ipv4.conf.default.send_redirects=0');
    expect(await sudo(gateway, 'sysctl -n net.ipv4.conf.eth0.send_redirects')).toBe('1');
  });

  it('the directory of a scope belongs to root, as every directory of /proc/sys does', async () => {
    const { gateway } = await routerOnAStick();
    const scopes = ['lo', 'eth1', 'eth0', 'all'].map((scope) => `/proc/sys/net/ipv4/conf/${scope}`).join(' ');
    expect(await sudo(gateway, `stat -c %U:%G ${scopes}`)).toBe('root:root\nroot:root\nroot:root\nroot:root');
  });

  it('a knob of an interface that does not exist cannot be read', async () => {
    const { gateway } = await routerOnAStick();
    expect(await sudo(gateway, 'sysctl net.ipv4.conf.eth9.send_redirects')).toContain('cannot stat /proc/sys/net/ipv4/conf/eth9/send_redirects');
  });

  it('a value that is not an integer is refused', async () => {
    const { gateway } = await routerOnAStick();
    expect(await sudo(gateway, 'sysctl -w net.ipv4.conf.all.send_redirects=yes')).toContain('Invalid argument');
    expect(await sudo(gateway, 'sysctl -n net.ipv4.conf.all.send_redirects')).toBe('1');
  });
});
