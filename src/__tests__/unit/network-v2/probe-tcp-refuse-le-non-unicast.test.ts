/**
 * TCP n'adresse JAMAIS une destination non unicast, et le refus est
 * IMMEDIAT (BRD-Modele-TCP-IP.md phase 8).
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * Sur un routeur portant une route par defaut, `stack.connect()` vers
 * `224.0.0.1`, vers `255.255.255.255` et vers la diffusion DIRIGEE
 * `10.0.0.255` rendait un socket dans l'etat `syn-sent` — c'est-a-dire
 * qu'un SYN etait reellement construit et emis vers un groupe, vers la
 * diffusion generale et vers la diffusion du sous-reseau. Une poignee de
 * main TCP suppose UN pair ; l'adresser a plusieurs machines n'a pas de
 * sens et, dans le cas de la diffusion, fait repondre tout le segment.
 *
 * La cause n'est pas dans TCP mais dans la resolution de sortie : rien ne
 * jugeait la CLASSE de la destination, si bien qu'une route par defaut —
 * qui correspond a tout — servait aussi les groupes.
 *
 * ── Ce que fait la vraie machine, lu dans le noyau et non de memoire ─
 *
 * `net/ipv4/tcp_ipv4.c`, `tcp_v4_connect()` : apres la recherche de route,
 *
 *     if (rt->rt_flags & (RTCF_MULTICAST | RTCF_BROADCAST)) {
 *             ip_rt_put(rt);
 *             return -ENETUNREACH;
 *     }
 *
 * `RTCF_BROADCAST` couvre les DEUX diffusions, la generale et la dirigee,
 * parce que la route est classee contre les adresses que la machine porte.
 * `net/ipv6/tcp_ipv6.c`, `tcp_v6_connect()`, est plus direct encore — le
 * refus est la PREMIERE chose faite, avant toute recherche de route :
 *
 *     addr_type = ipv6_addr_type(&usin->sin6_addr);
 *     if (addr_type & IPV6_ADDR_MULTICAST)
 *             return -ENETUNREACH;
 *
 * Dans les deux familles l'erreur est ENETUNREACH et elle est rendue par
 * `connect()` LUI-MEME : rien ne part sur le fil, et l'appelant est refuse
 * tout de suite au lieu d'attendre un delai. C'est ce que ce fichier
 * observe — le refus, et l'absence de trame.
 *
 * ── Reutilisation, plutot qu'un quatrieme predicat ──────────────────
 *
 * `classifyIpv4Destination` et `isDirectedBroadcast` portent deja la
 * question, et `isUnicastDestination` ne fait que les composer : c'est la
 * meme regle que le plan de donnees applique deja, lue par un appelant de
 * plus, et non une seconde ecriture qui finirait par en differer.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * QUATRE cas sur six tombent contre l'etat d'avant : les trois classes
 * IPv4 et le groupe IPv6. Les DEUX autres passent des deux cotes et le
 * doivent — le TEMOIN unicast, sans lequel une pile qui refuserait TOUT
 * passerait cette sonde, et le cas de la boucle locale, qui verifie que
 * le refus n'a pas emporte une destination legitime.
 *
 * ── Pourquoi le cas IPv6 est monte sur l'HOTE et non sur le routeur ──
 *
 * Il y etait d'abord, et il passait des DEUX cotes : mesure, le `tcpHost`
 * de `Router` ne declare ni `resolveRoute6` ni `localAddress6`, donc
 * `resolveEgress6` sort par son garde avant meme de regarder l'adresse et
 * un routeur n'ouvre AUCUNE connexion TCP en IPv6, quelle qu'en soit la
 * destination. C'est le jumeau IPv6 du defaut que la sonde voisine ferme
 * pour IPv4, sur le meme objet ; il est inscrit au `TODO.md` plutot que
 * corrige ici, ou il ferait passer deux defauts pour un. Le cas est donc
 * monte sur un hote Linux, qui declare les deux crochets — sans quoi il
 * n'aurait rien discrimine, ce que la mesure a dit avant l'ecriture.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function routeurAvecRouteParDefaut() {
  const routeur = new CiscoRouter('R');
  const poste = new LinuxPC('PC');
  new Cable('c1').connect(routeur.getPort('GigabitEthernet0/0')!, poste.getPort('eth0')!);
  for (const c of ['enable', 'configure terminal',
    'ipv6 unicast-routing', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0',
    'ipv6 address 2001:DB8::1/64', 'no shutdown', 'exit',
    'ip route 0.0.0.0 0.0.0.0 10.0.0.2',
    'ipv6 route ::/0 2001:DB8::2', 'end']) {
    await routeur.executeCommand(c);
  }
  await poste.executeCommand('sudo ip addr add 10.0.0.2/24 dev eth0');
  await poste.executeCommand('sudo ip link set eth0 up');
  return { routeur, poste };
}

describe('TCP refuse une destination non unicast', () => {
  it('un groupe multicast est refuse, et aucune trame ne part', async () => {
    const { routeur } = await routeurAvecRouteParDefaut();
    const emises: unknown[] = [];
    routeur.getPort('GigabitEthernet0/0')!.attachTap(({ direction, frame }) => {
      if (direction === 'out') emises.push(frame);
    });
    const avant = emises.length;
    expect(routeur.getTcpStack().connect('224.0.0.1', 80)).toBeNull();
    expect(emises.length).toBe(avant);
  });

  it('la diffusion generale est refusee', async () => {
    const { routeur } = await routeurAvecRouteParDefaut();
    expect(routeur.getTcpStack().connect('255.255.255.255', 80)).toBeNull();
  });

  it('la diffusion DIRIGEE du sous-reseau est refusee', async () => {
    const { routeur } = await routeurAvecRouteParDefaut();
    expect(routeur.getTcpStack().connect('10.0.0.255', 80)).toBeNull();
  });

  it('un groupe IPv6 est refuse, sur un hote qui sait router en IPv6', async () => {
    const { poste } = await routeurAvecRouteParDefaut();
    await poste.executeCommand('sudo ip -6 addr add 2001:DB8::2/64 dev eth0');
    await poste.executeCommand('sudo ip -6 route add default via 2001:DB8::1');
    expect(poste.getTcpStack().connect('ff02::1', 80)).toBeNull();
  });

  it('TEMOIN : une destination unicast joignable ouvre bien un socket', async () => {
    const { routeur, poste } = await routeurAvecRouteParDefaut();
    poste.getTcpStack().listen(9000, { onAccept: () => undefined });
    const socket = routeur.getTcpStack().connect('10.0.0.2', 9000);
    expect(socket).not.toBeNull();
  });

  it('TEMOIN : la boucle locale reste joignable', async () => {
    const { routeur } = await routeurAvecRouteParDefaut();
    routeur.getTcpStack().listen(9100, { onAccept: () => undefined });
    expect(routeur.getTcpStack().connect('127.0.0.1', 9100)).not.toBeNull();
  });
});
