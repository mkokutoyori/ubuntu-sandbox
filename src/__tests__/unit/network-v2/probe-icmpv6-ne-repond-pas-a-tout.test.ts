/**
 * Une erreur ICMPv6 ne repond ni a un groupe, ni a une source qui ne
 * nomme personne (audit de la pile TCP/IP, lot 13).
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * `IcmpErrors.mayGenerateICMPError` porte depuis longtemps les regles de
 * la RFC 1122 §3.2.2 pour IPv4 — jamais d'erreur en reponse a une erreur,
 * a un fragment non initial, a une diffusion ou a une source qui n'est
 * pas unicast — et `Router`, `EndHost` et le pare-feu la lisent tous.
 *
 * `IPv6DataPlane.sendICMPv6Error` n'avait AUCUNE regle equivalente. Son
 * seul controle etait l'existence du port d'arrivee. C'est la meme
 * asymetrie v4/v6 que cet audit a deja rencontree, et le lot 9 venait de
 * la rendre plus atteignable en ouvrant la remise UDP en IPv6 : un
 * datagramme adresse a un GROUPE sur un port ferme faisait repondre le
 * routeur a la source, ce qui est a la fois interdit et un amplificateur.
 *
 * ── L'autorite, lue et non citee de memoire ─────────────────────────
 *
 * RFC 4443 §2.4 (e), telle que `icmp6_send` (net/ipv6/icmp.c) l'applique.
 * Contrôle de la DESTINATION :
 *
 *     if (addr_type & IPV6_ADDR_MULTICAST || skb->pkt_type != PACKET_HOST) {
 *             if (type != ICMPV6_PKT_TOOBIG && …)
 *                     goto out;
 *
 * puis de la SOURCE :
 *
 *     Must not send error if the source does not uniquely
 *     identify a single node (RFC2463 Section 2.4).
 *     if ((addr_type == IPV6_ADDR_ANY) || (addr_type & IPV6_ADDR_MULTICAST))
 *             goto out;
 *
 * et `is_ineligible()` ecarte enfin ce qui repondrait a une erreur ICMPv6.
 *
 * **`packet-too-big` est l'EXCEPTION que le noyau code explicitement**, et
 * la rater aurait casse la decouverte de MTU de chemin sur un trajet
 * multicast : c'est le seul message d'erreur qu'un groupe peut declencher.
 *
 * ── Discrimination : UN seul cas tombe, et c'est mesure ─────────────
 *
 * J'avais annonce TROIS. La mesure en donne UN — le datagramme adresse
 * au GROUPE — et l'ecart est instructif, donc il est ecrit ici plutot
 * que corrige en silence.
 *
 * Les deux cas de SOURCE passaient deja AVANT le correctif, mais **par
 * accident et non par regle** : `sendICMPv6Error` termine par
 * `resolveEgress(offendingPkt.sourceIP, …)` et rend la main si elle
 * echoue. Or on ne route rien vers `::`, et un voisin multicast n'est pas
 * dans le cache. Le silence venait donc de l'incapacite a ACHEMINER
 * l'erreur, pas d'un refus de l'EMETTRE — une difference qui compte,
 * parce qu'un cache chaud ou une table plus complaisante le ferait
 * disparaitre. La regle rend ce silence intentionnel et independant de
 * l'etat du cache ; c'est bien un correctif, mais ces deux cas-la le
 * GARDENT au lieu de le prouver.
 *
 * Les deux derniers sont des TEMOINS : l'unicast, dont c'est l'objet de
 * continuer a repondre — sans lui une regle qui supprimerait TOUT
 * passerait la sonde — et le refus du checksum nul, qui est la regle de
 * la RFC 8200 §8.1 et n'a rien a voir avec ce lot.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPv6Address,
  createIPv6Packet, ETHERTYPE_IPV6, IP_PROTO_UDP, type UDPPacket,
} from '@/network/core/types';
import { stampUdpChecksum } from '@/network/layers/transport/UdpChecksum';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function maquette() {
  const routeur = new CiscoRouter('R');
  const poste = new LinuxPC('PC');
  new Cable('c1').connect(routeur.getPort('GigabitEthernet0/0')!, poste.getPorts()[0]);
  for (const c of ['enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:DB8::1/64', 'no shutdown', 'end']) {
    await routeur.executeCommand(c);
  }
  await poste.executeCommand('sudo ip -6 addr add 2001:DB8::2/64 dev eth0');
  await poste.executeCommand('sudo ip link set eth0 up');

  const erreurs: string[] = [];
  poste.getPorts()[0].attachTap(({ direction, frame }) => {
    const pkt = frame.payload as { type?: string; nextHeader?: number; payload?: unknown } | undefined;
    if (direction !== 'in' || pkt?.type !== 'ipv6' || pkt.nextHeader !== 58) return;
    const icmp = (pkt.payload as { icmpType?: string } | undefined)?.icmpType;
    if (icmp === 'destination-unreachable' || icmp === 'time-exceeded') erreurs.push(icmp);
  });

  const injecter = (source: string, destination: string, checksumNul = false) => {
    const base = {
      type: 'udp', sourcePort: 1, destinationPort: 9999, length: 8, payload: '',
    } as unknown as UDPPacket;
    const udp = checksumNul
      ? { ...base, checksum: 0 }
      : stampUdpChecksum(base, source, destination);
    routeur.getPort('GigabitEthernet0/0')!.receiveFrame({
      srcMAC: poste.getPorts()[0].getMAC(),
      dstMAC: routeur.getPort('GigabitEthernet0/0')!.getMAC(),
      etherType: ETHERTYPE_IPV6,
      payload: createIPv6Packet(
        new IPv6Address(source), new IPv6Address(destination), IP_PROTO_UDP, 64, udp, 8),
    } as never);
  };

  return { erreurs, injecter };
}

describe('une erreur ICMPv6 ne repond pas a tout', () => {
  it('un datagramme adresse a un GROUPE n\'obtient pas d\'erreur', async () => {
    const { erreurs, injecter } = await maquette();
    injecter('2001:db8::2', 'ff02::1');
    await new Promise((r) => setTimeout(r, 25));
    expect(erreurs).toEqual([]);
  });

  it('une source NON SPECIFIEE n\'obtient pas d\'erreur', async () => {
    const { erreurs, injecter } = await maquette();
    injecter('::', '2001:db8::1');
    await new Promise((r) => setTimeout(r, 25));
    expect(erreurs).toEqual([]);
  });

  it('une source MULTICAST n\'obtient pas d\'erreur', async () => {
    const { erreurs, injecter } = await maquette();
    injecter('ff02::5', '2001:db8::1');
    await new Promise((r) => setTimeout(r, 25));
    expect(erreurs).toEqual([]);
  });

  it('TEMOIN : un unicast ordinaire obtient bien son port injoignable', async () => {
    const { erreurs, injecter } = await maquette();
    injecter('2001:db8::2', '2001:db8::1');
    await new Promise((r) => setTimeout(r, 25));
    expect(erreurs).toContain('destination-unreachable');
  });

  it('un HOTE applique la meme regle, et par le meme predicat', async () => {
    const client = new LinuxPC('A2');
    const serveur = new LinuxServer('linux-server', 'B2', 0, 0);
    new Cable('c2').connect(client.getPorts()[0], serveur.getPorts()[0]);
    await client.executeCommand('sudo ip -6 addr add 2001:DB8:9::1/64 dev eth0');
    await client.executeCommand('sudo ip link set eth0 up');
    await serveur.executeCommand('sudo ip -6 addr add 2001:DB8:9::2/64 dev eth0');
    await serveur.executeCommand('sudo ip link set eth0 up');

    const erreurs: string[] = [];
    client.getPorts()[0].attachTap(({ direction, frame }) => {
      const pkt = frame.payload as { type?: string; nextHeader?: number; payload?: unknown } | undefined;
      if (direction !== 'in' || pkt?.type !== 'ipv6' || pkt.nextHeader !== 58) return;
      const icmp = (pkt.payload as { icmpType?: string } | undefined)?.icmpType;
      if (icmp === 'destination-unreachable') erreurs.push(icmp);
    });
    const versLeServeur = (source: string) => {
      const base = {
        type: 'udp', sourcePort: 1, destinationPort: 9999, length: 8, payload: '',
      } as unknown as UDPPacket;
      serveur.getPorts()[0].receiveFrame({
        srcMAC: client.getPorts()[0].getMAC(), dstMAC: serveur.getPorts()[0].getMAC(),
        etherType: ETHERTYPE_IPV6,
        payload: createIPv6Packet(
          new IPv6Address(source), new IPv6Address('2001:DB8:9::2'), IP_PROTO_UDP, 64,
          stampUdpChecksum(base, source, '2001:DB8:9::2'), 8),
      } as never);
    };

    versLeServeur('2001:db8:9::1');
    await new Promise((r) => setTimeout(r, 25));
    expect(erreurs).toContain('destination-unreachable');

    erreurs.length = 0;
    versLeServeur('::');
    await new Promise((r) => setTimeout(r, 25));
    expect(erreurs).toEqual([]);
  });

  it('TEMOIN : un checksum NUL est ecarte avant tout (RFC 8200 §8.1)', async () => {
    const { erreurs, injecter } = await maquette();
    injecter('2001:db8::2', '2001:db8::1', true);
    await new Promise((r) => setTimeout(r, 25));
    expect(erreurs).toEqual([]);
  });
});
