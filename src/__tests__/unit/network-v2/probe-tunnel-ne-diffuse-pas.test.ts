/**
 * Le paquet EXTERIEUR d'un tunnel est un unicast route, pas une
 * diffusion (BRD-Modele-TCP-IP.md §3.3).
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * `GreAgent` et `VxlanAgent` batissaient leur paquet exterieur puis
 * l'emettaient avec `destinationMac: MACAddress.broadcast()`. Ce paquet
 * est pourtant un unicast IPv4 ordinaire : une vraie machine le route et
 * resout son prochain saut par ARP, vers UNE adresse. Diffuser signifie
 * que TOUTES les stations du segment recoivent la charge encapsulee --
 * un tunnel qui fuit son contenu a tout le LAN, ce qui est exactement ce
 * qu'un tunnel existe pour eviter. Le cas du TEMOIN ci-dessous le montre
 * la ou il se voit : sur une machine tierce, branchee au meme
 * commutateur, qui n'a rien a voir avec le tunnel.
 *
 * Chacun des deux portait de surcroit sa propre copie de `resolveEgress`
 * -- la cinquieme et la sixieme du depot, mot pour mot la meme que celle
 * que le lot 8 venait de retirer de syslog, NetFlow et SNMP, repli
 * compris : « le premier port adresse et up », quelle que soit la
 * direction de la cible.
 *
 * ── L'offre de la couche, et la regle qu'elle applique ──────────────
 *
 * `layers/internet/Ipv4Egress.ts` pose ce que le BRD §3.3 decrit :
 * `sendIpv4Packet({ dst, protocol, payload, ... })`. Elle tranche entre
 * DEUX regimes, et la distinction est celle de la RFC : un multicast
 * LIEN-LOCAL (224.0.0.0/24) ou une diffusion limitee ne se ROUTE pas --
 * elle s'emet sur une interface que l'appelant NOMME -- tandis que tout
 * le reste passe par la table de routage et le chemin ARP. `Router` et
 * `EndHost` la realisent tous deux, et `Router.sendUdpDatagram` est
 * desormais ecrit PAR-DESSUS elle plutot qu'a cote.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * QUATRE cas sur six tombent contre l'etat d'avant : les deux tiers qui
 * recevaient la charge encapsulee, et les deux adresses de destination
 * du paquet exterieur, GRE et VXLAN. Les deux autres passent des deux
 * cotes et le doivent -- le TEMOIN GRE qui verifie que le pair recoit
 * bien le tunnel (sans quoi « le tiers ne recoit rien » serait satisfait
 * par un tunnel qui n'emet pas du tout, et c'est exactement ce que la
 * premiere version de ce fichier faisait), et le cas d'unite de l'offre
 * elle-meme, qui est un module nouveau et purement additif.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { IPv4Packet, UDPPacket } from '@/network/core/types';
import { IP_PROTO_GRE } from '@/network/gre/types';
import {
  requiresNamedInterface, linkDestinationFor,
} from '@/network/layers/internet/Ipv4Egress';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function segment() {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const bystander = new LinuxPC('PC');

  new Cable('c1').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('c3').connect(bystander.getPorts()[0], sw.getPort('FastEthernet0/3')!);

  const monter = async (r: CiscoRouter, ip: string) => {
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', `ip address ${ip} 255.255.255.0`, 'end']) await r.executeCommand(c);
  };
  await monter(r1, '10.0.0.1');
  await monter(r2, '10.0.0.2');
  return { sw, r1, r2, bystander };
}

function inboundIpv4(device: { getPorts(): Array<{ attachTap(t: (f: {
  direction: string; frame: { dstMAC: { toString(): string }; payload: unknown };
}) => void): unknown }> }): Array<{ dstMAC: string; packet: IPv4Packet }> {
  const seen: Array<{ dstMAC: string; packet: IPv4Packet }> = [];
  for (const p of device.getPorts()) {
    p.attachTap(({ direction, frame }) => {
      if (direction !== 'in') return;
      const packet = frame.payload as IPv4Packet | undefined;
      if (packet?.type === 'ipv4') seen.push({ dstMAC: frame.dstMAC.toString(), packet });
    });
  }
  return seen;
}

const isGre = (p: IPv4Packet) => p.protocol === IP_PROTO_GRE;
const isVxlan = (p: IPv4Packet) =>
  (p.payload as UDPPacket | undefined)?.type === 'udp'
  && (p.payload as UDPPacket).destinationPort === 4789;

describe('un tunnel GRE n\'inonde pas son segment', () => {
  it('le tiers du segment ne recoit AUCUN paquet GRE', async () => {
    const { r1, r2, bystander } = await segment();
    const chezLeTiers = inboundIpv4(bystander);

    r1.getGreAgent().setEnabled(true);
    r2.getGreAgent().setEnabled(true);
    r1.getGreAgent().addTunnel('Tunnel0', '10.0.0.1', '10.0.0.2');
    r2.getGreAgent().addTunnel('Tunnel0', '10.0.0.2', '10.0.0.1');
    r1.getGreAgent().encapsulateAndSend('Tunnel0', {
      type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 28,
      identification: 1, flags: 0, fragmentOffset: 0, ttl: 64, protocol: 1,
      headerChecksum: 0,
      sourceIP: new IPAddress('192.168.1.1'),
      destinationIP: new IPAddress('192.168.2.1'),
      payload: null,
    });

    expect(chezLeTiers.filter((f) => isGre(f.packet))).toEqual([]);
  });

  it('TEMOIN — le PAIR du tunnel, lui, le recoit', async () => {
    const { r1, r2 } = await segment();
    const chezLePair = inboundIpv4(r2);

    r1.getGreAgent().setEnabled(true);
    r2.getGreAgent().setEnabled(true);
    r1.getGreAgent().addTunnel('Tunnel0', '10.0.0.1', '10.0.0.2');
    r2.getGreAgent().addTunnel('Tunnel0', '10.0.0.2', '10.0.0.1');
    r1.getGreAgent().encapsulateAndSend('Tunnel0', {
      type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 28,
      identification: 1, flags: 0, fragmentOffset: 0, ttl: 64, protocol: 1,
      headerChecksum: 0,
      sourceIP: new IPAddress('192.168.1.1'),
      destinationIP: new IPAddress('192.168.2.1'),
      payload: null,
    });

    expect(chezLePair.filter((f) => isGre(f.packet)).length).toBeGreaterThan(0);
  });

  it('la trame porte l\'adresse du PAIR et non la diffusion', async () => {
    const { r1, r2 } = await segment();
    const chezLePair = inboundIpv4(r2);
    const macDuPair = r2.getPort('GigabitEthernet0/0')!.getMAC().toString();

    r1.getGreAgent().setEnabled(true);
    r2.getGreAgent().setEnabled(true);
    r1.getGreAgent().addTunnel('Tunnel0', '10.0.0.1', '10.0.0.2');
    r2.getGreAgent().addTunnel('Tunnel0', '10.0.0.2', '10.0.0.1');
    r1.getGreAgent().encapsulateAndSend('Tunnel0', {
      type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 28,
      identification: 1, flags: 0, fragmentOffset: 0, ttl: 64, protocol: 1,
      headerChecksum: 0,
      sourceIP: new IPAddress('192.168.1.1'),
      destinationIP: new IPAddress('192.168.2.1'),
      payload: null,
    });

    const gre = chezLePair.filter((f) => isGre(f.packet));
    expect(gre.length).toBeGreaterThan(0);
    for (const f of gre) {
      expect(f.dstMAC).toBe(macDuPair);
      expect(f.dstMAC).not.toBe(MACAddress.broadcast().toString());
    }
  });
});

describe('un tunnel VXLAN n\'inonde pas son segment', () => {
  it('le tiers du segment ne recoit AUCUN paquet VXLAN', async () => {
    const { r1, r2, bystander } = await segment();
    const chezLeTiers = inboundIpv4(bystander);

    r1.getVxlanAgent().setEnabled(true);
    r1.getVxlanAgent().ensureInterface('nve1', '10.0.0.1');
    r1.getVxlanAgent().bindVni('nve1', 10, '10.0.0.1');
    r1.getVxlanAgent().addRemoteVtep(10, '10.0.0.2');
    r2.getVxlanAgent().setEnabled(true);
    r2.getVxlanAgent().ensureInterface('nve1', '10.0.0.2');
    r2.getVxlanAgent().bindVni('nve1', 10, '10.0.0.2');
    r1.getVxlanAgent().encapsulateAndSend(10, {
      srcMAC: new MACAddress('00:11:22:33:44:55'),
      dstMAC: new MACAddress('00:11:22:33:44:66'),
      etherType: 0x0800, payload: null,
    });

    expect(chezLeTiers.filter((f) => isVxlan(f.packet))).toEqual([]);
  });

  it('TEMOIN — le PAIR du tunnel VXLAN, lui, le recoit, a son adresse', async () => {
    const { r1, r2 } = await segment();
    const chezLePair = inboundIpv4(r2);
    const macDuPair = r2.getPort('GigabitEthernet0/0')!.getMAC().toString();

    r1.getVxlanAgent().setEnabled(true);
    r1.getVxlanAgent().ensureInterface('nve1', '10.0.0.1');
    r1.getVxlanAgent().bindVni('nve1', 10, '10.0.0.1');
    r1.getVxlanAgent().addRemoteVtep(10, '10.0.0.2');
    r2.getVxlanAgent().setEnabled(true);
    r2.getVxlanAgent().ensureInterface('nve1', '10.0.0.2');
    r2.getVxlanAgent().bindVni('nve1', 10, '10.0.0.2');
    r1.getVxlanAgent().encapsulateAndSend(10, {
      srcMAC: new MACAddress('00:11:22:33:44:55'),
      dstMAC: new MACAddress('00:11:22:33:44:66'),
      etherType: 0x0800, payload: null,
    });

    const vxlan = chezLePair.filter((f) => isVxlan(f.packet));
    expect(vxlan.length).toBeGreaterThan(0);
    for (const f of vxlan) expect(f.dstMAC).toBe(macDuPair);
  });
});

describe('l\'offre de la couche internet tranche entre les deux regimes', () => {
  it('un multicast lien-local exige une interface nommee, un unicast est route', () => {
    expect(requiresNamedInterface(new IPAddress('224.0.0.18'))).toBe(true);
    expect(requiresNamedInterface(new IPAddress('255.255.255.255'))).toBe(true);
    expect(requiresNamedInterface(new IPAddress('239.1.1.1'))).toBe(false);
    expect(requiresNamedInterface(new IPAddress('10.0.0.2'))).toBe(false);

    expect(linkDestinationFor(new IPAddress('224.0.0.18')).toString()).toBe('01:00:5e:00:00:12');
    expect(linkDestinationFor(new IPAddress('255.255.255.255')).toString())
      .toBe(MACAddress.broadcast().toString());
  });
});
