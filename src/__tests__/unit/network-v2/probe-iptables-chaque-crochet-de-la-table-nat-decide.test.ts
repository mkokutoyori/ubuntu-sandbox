/**
 * La table nat decide a chacun des crochets qu'elle occupe, et pas seulement a l'entree : la chaine INPUT (`nf_nat_ipv4_local_in`, avant
 * la remise a la socket), la chaine POSTROUTING pour ce qu'une passerelle transmet comme pour ce qu'elle emet elle-meme (la sortie y est
 * vue comme une SORTIE, avec son interface), et `nf_nat_masquerade_ipv4` laisse tel quel un paquet dont la source est 0.0.0.0. Les cibles
 * NAT d'ip6tables sont des adresses IPv6, des plages d'adresses ou une adresse entre crochets avec un port.
 *
 * Mesure de depart (arbre portant le lot precedent, sonde conservee) : une chaine INPUT de la table nat n'etait jamais lue -- un SNAT
 * y laissait voir a la socket l'adresse du client, un DROP la lui laissait atteindre ; un DROP de POSTROUTING ne retenait pas ce que la
 * passerelle emet elle-meme ; un DROP lie a eth0 retenait aussi ce qui sortait par eth1 ; un SNAT lie a l'interface de sortie ne
 * reecrivait pas son datagramme ; et la cible `--to-destination -` d'ip6tables etait acceptee.
 *
 * Ce fichier est ne des mutants que les sondes de bout en bout laissaient vivre : chaque cas tue au moins l'un d'eux (retrait de
 * `ipPkt = delivered` et de la garde nulle de LOCAL_IN, nom du crochet de natLocalIn, direction et interface des faits de
 * POSTROUTING, garde 0.0.0.0, garde nulle de la retransmission, validation des cibles IPv6), ce que la sonde ne voyait pas faute de
 * socket d'ecoute sur la passerelle ou d'appel direct qui laisse monter une exception.
 *
 * Discrimination : contre l'arbre sans le lot, 9 des 19 cas tombent et 10 passent des deux cotes : trois TEMOINS (sans regle la socket
 * voit le client ; une regle pour un autre port ne touche rien ; un SNAT lie a l'autre interface laisse le datagramme), le DROP d'un
 * paquet transmis, par ping puis par un envoi direct qui ne tolere aucune exception (deja dans le lot precedent) et cinq cas
 * d'adresses IPv6 que la validation existante rendait deja (trois acceptees, deux refusees).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { UdpDelivery } from '@/network/devices/EndHost';
import type { LinuxIptablesManager, PacketInfo } from '@/network/devices/linux/LinuxIptablesManager';
import { pingOnSimulatedClock } from '../../support/fastPing';
import { natGateway, sudo, watchSources, type Host } from '../../support/natGateway';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const sendUdp = (host: Host, target: string): Promise<string> => pingOnSimulatedClock(host, `echo hi | nc -u -w 1 ${target} 5000`);

function listenOn(host: { udpBind(port: number, listener: (delivery: UdpDelivery) => void): number | false }): string[] {
  const sources: string[] = [];
  host.udpBind(5000, (delivery) => { sources.push(delivery.sourceIP.toString()); });
  return sources;
}

describe('the nat table decides at the INPUT hook too, before the datagram reaches the socket', () => {
  it('TEMOIN : with no rule the socket sees the address the client has', async () => {
    const { gateway, inside } = await natGateway();
    const sources = listenOn(gateway);
    await sendUdp(inside, '10.0.0.1');
    expect(sources).toEqual(['10.0.0.2']);
  });

  it('an SNAT in the INPUT chain changes the source the socket sees', async () => {
    const { gateway, inside } = await natGateway();
    const sources = listenOn(gateway);
    expect(await sudo(gateway, 'iptables -t nat -A INPUT -p udp --dport 5000 -j SNAT --to-source 10.9.9.9')).toBe('');
    await sendUdp(inside, '10.0.0.1');
    expect(sources).toEqual(['10.9.9.9']);
  });

  it('a DROP in the INPUT chain keeps the datagram from the socket', async () => {
    const { gateway, inside } = await natGateway();
    const sources = listenOn(gateway);
    await sudo(gateway, 'iptables -t nat -A INPUT -p udp --dport 5000 -j DROP');
    await sendUdp(inside, '10.0.0.1');
    expect(sources).toEqual([]);
  });

  it('a rule for another port does not touch it', async () => {
    const { gateway, inside } = await natGateway();
    const sources = listenOn(gateway);
    await sudo(gateway, 'iptables -t nat -A INPUT -p udp --dport 5001 -j SNAT --to-source 10.9.9.9');
    await sendUdp(inside, '10.0.0.1');
    expect(sources).toEqual(['10.0.0.2']);
  });
});

describe('a DROP in POSTROUTING stops what leaves, whether it is forwarded or sent by the gateway itself', () => {
  it('a DROP bound to the other interface stops nothing', async () => {
    const { gateway, inside, outside } = await natGateway();
    await sudo(gateway, 'iptables -t nat -A POSTROUTING -o eth0 -j DROP');
    const seen = await watchSources(outside, 'icmp', '10.0.0.2');
    expect(await pingOnSimulatedClock(inside, 'ping -c 1 -W 1 203.0.113.2')).toContain('1 received');
    expect(await seen()).toEqual({ '10.0.0.2': 1 });
  });

  it('a forwarded packet never reaches the far host', async () => {
    const { gateway, inside, outside } = await natGateway();
    await sudo(gateway, 'iptables -t nat -A POSTROUTING -o eth1 -j DROP');
    const seen = await watchSources(outside, 'icmp', '10.0.0.2');
    expect(await pingOnSimulatedClock(inside, 'ping -c 1 -W 1 203.0.113.2')).toContain('100% packet loss');
    expect(await seen()).toEqual({ '10.0.0.2': 0 });
  });

  it('a forwarded datagram is dropped without a word : the sender is not told and nothing is thrown', async () => {
    const { gateway, inside, outside } = await natGateway();
    await sudo(gateway, 'iptables -t nat -A POSTROUTING -o eth1 -j DROP');
    const received: string[] = [];
    outside.udpBind(5000, (delivery) => { received.push(String(delivery.udp.payload)); });
    expect(inside.sendUdpDatagram(new IPAddress('203.0.113.2'), 5000, 40000, 'x', 1)).toBe(true);
    expect(received).toEqual([]);
  });

  it('a packet the gateway sends itself never reaches the far host', async () => {
    const { gateway, outside } = await natGateway();
    await sudo(gateway, 'iptables -t nat -A POSTROUTING -o eth1 -j DROP');
    const seen = await watchSources(outside, 'icmp', '203.0.113.1');
    expect(await pingOnSimulatedClock(gateway, 'ping -c 1 -W 1 203.0.113.2')).toContain('100% packet loss');
    expect(await seen()).toEqual({ '203.0.113.1': 0 });
  });
});

describe('what the gateway sends itself meets POSTROUTING as an output, with its interface', () => {
  it('an SNAT bound to the interface it leaves by rewrites its datagram', async () => {
    const { gateway, outside } = await natGateway();
    const sources = listenOn(outside);
    await sudo(gateway, 'iptables -t nat -A POSTROUTING -o eth1 -p udp -j SNAT --to-source 203.0.113.50');
    await sendUdp(gateway, '203.0.113.2');
    expect(sources).toEqual(['203.0.113.50']);
  });

  it('TEMOIN : the same SNAT bound to the other interface leaves it alone', async () => {
    const { gateway, outside } = await natGateway();
    const sources = listenOn(outside);
    await sudo(gateway, 'iptables -t nat -A POSTROUTING -o eth0 -p udp -j SNAT --to-source 203.0.113.50');
    await sendUdp(gateway, '203.0.113.2');
    expect(sources).toEqual(['203.0.113.1']);
  });
});

describe('MASQUERADE leaves a 0.0.0.0 source alone, as nf_nat_masquerade_ipv4 does', () => {
  const masquerade = { addresses: null, ports: null, random: false, randomFully: false, persistent: false };
  const facts = (srcIP: string): PacketInfo => ({
    direction: 'forward', iface: 'eth0', outIface: 'eth1', protocol: 17, srcIP, srcPort: 68, dstIP: '203.0.113.2', dstPort: 67,
  });
  const decide = (srcIP: string, manager: LinuxIptablesManager) => manager.natHook(
    () => facts(srcIP), {}, 'POSTROUTING', { masqueradeAddress: '203.0.113.1', redirectAddress: null, outInterface: 'eth1' },
    () => ({ action: 'MASQUERADE', range: masquerade }),
  );

  it('translates an ordinary source', async () => {
    const { gateway } = await natGateway();
    const manager = (gateway as unknown as { executor: { iptables: LinuxIptablesManager } }).executor.iptables;
    expect(decide('10.0.0.2', manager)).toMatchObject({ kind: 'accept', translation: { side: 'source', address: '203.0.113.1' } });
  });

  it('does not touch the unspecified source', async () => {
    const { gateway } = await natGateway();
    const manager = (gateway as unknown as { executor: { iptables: LinuxIptablesManager } }).executor.iptables;
    expect(decide('0.0.0.0', manager)).toMatchObject({ kind: 'accept', translation: null });
  });

  it('but an SNAT does not make that exception', async () => {
    const { gateway } = await natGateway();
    const manager = (gateway as unknown as { executor: { iptables: LinuxIptablesManager } }).executor.iptables;
    const snat = { ...masquerade, addresses: { min: new IPAddress('203.0.113.50'), max: new IPAddress('203.0.113.50') } };
    const outcome = manager.natHook(
      () => facts('0.0.0.0'), {}, 'POSTROUTING', { masqueradeAddress: '203.0.113.1', redirectAddress: null, outInterface: 'eth1' },
      () => ({ action: 'SNAT', range: snat }),
    );
    expect(outcome).toMatchObject({ kind: 'accept', translation: { side: 'source', address: '203.0.113.50' } });
  });
});

describe('an ip6tables nat target is an IPv6 address, a range of them, or a bracketed address with a port', () => {
  const add = (target: string) => `ip6tables -t nat -A PREROUTING -p tcp --dport 80 -j DNAT --to-destination ${target}`;

  it.each(['[fd00::9]:80', 'fd00::9', 'fd00::1-fd00::9'])('%s is accepted', async (target) => {
    const { gateway } = await natGateway();
    expect(await sudo(gateway, add(target))).toBe('');
  });

  it.each(['zzz', 'fd00::1-zzz', '-'])('%s is refused as a bad address', async (target) => {
    const { gateway } = await natGateway();
    expect(await sudo(gateway, add(target))).toContain(`Bad IP address "${target}"`);
  });
});
