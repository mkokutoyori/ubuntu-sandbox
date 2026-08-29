/**
 * VRRP, HSRP, GLBP et PIM descendent par la couche internet, et
 * l'adresse de couche lien se DERIVE du groupe (BRD §3.3, phase 7).
 *
 * ── Ce que la mesure a trouve, et ce qu'elle n'a PAS trouve ─────────
 *
 * Les quatre moteurs emettaient DEJA correctement : bon groupe, bonne
 * interface, bonne adresse de couche lien, bon TTL. Ce lot ne corrige
 * donc aucun defaut de comportement -- il retire la DUPLICATION. Le dire
 * franchement importe : la plupart des cas ci-dessous passent des deux
 * cotes, et c'est ce qu'on attend d'une descente reussie.
 *
 * Ce que la duplication coutait, elle, est mesurable. Chaque moteur
 * batissait sa trame et portait EN DUR l'adresse de couche lien de son
 * groupe -- `VRRP_MULTICAST_MAC`, `GLBP_MULTICAST_MAC`,
 * `PIM_ALL_ROUTERS_MAC` -- c'est-a-dire un second fait qui doit
 * s'accorder avec le premier, l'adresse de groupe, sans que rien ne
 * l'y oblige. HSRP, lui, portait `multicastMacFor`, une SECONDE
 * implantation de la derivation que `ipv4MulticastToMac` fait deja.
 * Desormais `linkDestinationFor` la derive de l'adresse du groupe : les
 * deux faits n'en font plus qu'un, et ne peuvent plus se contredire.
 *
 * ── Sur quelle autorite ces valeurs sont verifiees ──────────────────
 *
 * Pas sur une RFC recitee, mais sur ce qui a ete retenu officiellement,
 * et ce n'est pas la meme chose pour les quatre :
 *
 * - **VRRP** est une norme ouverte (RFC 5798, Standards Track) et
 *   224.0.0.18 est une affectation IANA.
 * - **PIM-SM** de meme (RFC 7761), 224.0.0.13 etant l'affectation IANA
 *   « All PIM Routers ».
 * - **HSRP** est PROPRIETAIRE Cisco. La RFC 2281 existe mais elle est
 *   INFORMATIVE, pas Standards Track, et ne decrit que la version 1 ;
 *   la version 2 (224.0.0.102, UDP 1985) n'a aucune RFC. L'autorite est
 *   la documentation de Cisco.
 * - **GLBP** est proprietaire Cisco et n'a AUCUNE RFC. Meme autorite.
 *
 * Citer une RFC pour HSRP ou GLBP serait donc invoquer un texte qui ne
 * fait pas foi. La derivation de l'adresse de couche lien, elle, tient a
 * l'affectation par l'IANA du bloc OUI 01:00:5E aux adresses multicast
 * IPv4 -- ce que ce depot applique en un seul endroit.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * DEUX cas sur sept tombent contre l'etat d'avant, et ce sont les deux
 * seuls qui le peuvent : le cas de STRUCTURE (aucun des quatre moteurs
 * ne batit plus de trame ni ne nomme d'adresse de couche lien en dur) et
 * le REFUS d'une destination unicast dans le regime « interface
 * nommee », qui est un comportement neuf -- avant, le helper rendait la
 * DIFFUSION pour un unicast, c'est-a-dire exactement le defaut que la
 * phase 7 venait de fermer, laisse latent dans le helper qui le ferme.
 * Les cinq autres observent sur le fil que rien n'a change, et c'est
 * leur role : une descente qui modifierait ce qui part serait ratee.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress, SubnetMask,
  type IPv4Packet, type UDPPacket,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { IP_PROTO_VRRP } from '@/network/vrrp/types';
import { IP_PROTO_PIM } from '@/network/pim/types';
import { linkDestinationFor } from '@/network/layers/internet/Ipv4Egress';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Vu { dstMAC: string; packet: IPv4Packet }

function wireOf(r: CiscoRouter, iface: string): Vu[] {
  const seen: Vu[] = [];
  r.getPort(iface)!.attachTap(({ direction, frame }) => {
    if (direction !== 'out') return;
    const packet = frame.payload as IPv4Packet | undefined;
    if (packet?.type === 'ipv4') seen.push({ dstMAC: frame.dstMAC.toString(), packet });
  });
  return seen;
}

async function pair() {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  new Cable('c1').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  for (const [r, ip] of [[r1, '10.0.0.1'], [r2, '10.0.0.2']] as const) {
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress(ip), new SubnetMask('255.255.255.0'));
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'no shutdown', 'end']) await r.executeCommand(c);
  }
  return { sw, r1, r2 };
}

const udpTo = (p: IPv4Packet, port: number) =>
  (p.payload as UDPPacket | undefined)?.type === 'udp'
  && (p.payload as UDPPacket).destinationPort === port;

describe('ce qui part sur le fil est inchange', () => {
  it('VRRP part vers 224.0.0.18, TTL 255, TOS 0xc0, MAC derivee', async () => {
    const { r1 } = await pair();
    const wire = wireOf(r1, 'GigabitEthernet0/0');
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'vrrp 1 ip 10.0.0.254', 'vrrp 1 priority 200', 'end']) await r1.executeCommand(c);

    const vrrp = wire.filter((f) => f.packet.protocol === IP_PROTO_VRRP);
    expect(vrrp.length).toBeGreaterThan(0);
    for (const f of vrrp) {
      expect(f.packet.destinationIP.toString()).toBe('224.0.0.18');
      expect(f.packet.ttl).toBe(255);
      expect(f.packet.tos).toBe(0xc0);
      expect(f.packet.flags).toBe(0);
      expect(f.dstMAC).toBe('01:00:5e:00:00:12');
    }
  });

  it('HSRP v1 part vers 224.0.0.2 en UDP/1985, TTL 1, MAC derivee', async () => {
    const { r1 } = await pair();
    const wire = wireOf(r1, 'GigabitEthernet0/0');
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'standby 1 ip 10.0.0.254', 'standby 1 priority 200', 'end']) await r1.executeCommand(c);

    const hsrp = wire.filter((f) => udpTo(f.packet, 1985));
    expect(hsrp.length).toBeGreaterThan(0);
    for (const f of hsrp) {
      expect(f.packet.destinationIP.toString()).toBe('224.0.0.2');
      expect(f.packet.ttl).toBe(1);
      expect(f.dstMAC).toBe('01:00:5e:00:00:02');
    }
  });

  it('GLBP part vers 224.0.0.102 en UDP/3222, TTL 255, MAC derivee', async () => {
    const { r1 } = await pair();
    const wire = wireOf(r1, 'GigabitEthernet0/0');
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'glbp 1 ip 10.0.0.254', 'glbp 1 priority 200', 'end']) await r1.executeCommand(c);

    const glbp = wire.filter((f) => udpTo(f.packet, 3222));
    expect(glbp.length).toBeGreaterThan(0);
    for (const f of glbp) {
      expect(f.packet.destinationIP.toString()).toBe('224.0.0.102');
      expect(f.packet.ttl).toBe(255);
      expect(f.packet.tos).toBe(0xc0);
      expect(f.dstMAC).toBe('01:00:5e:00:00:66');
    }
  });

  it('PIM part vers 224.0.0.13, TTL 1, TOS 0xc0, MAC derivee', async () => {
    const { r1 } = await pair();
    const wire = wireOf(r1, 'GigabitEthernet0/0');
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');

    const pim = wire.filter((f) => f.packet.protocol === IP_PROTO_PIM);
    expect(pim.length).toBeGreaterThan(0);
    for (const f of pim) {
      expect(f.packet.destinationIP.toString()).toBe('224.0.0.13');
      expect(f.packet.ttl).toBe(1);
      expect(f.packet.tos).toBe(0xc0);
      expect(f.dstMAC).toBe('01:00:5e:00:00:0d');
    }
  });

  it('TEMOIN — le VOISIN entend bien l\'annonce VRRP', async () => {
    const { r1, r2 } = await pair();
    const recu: Vu[] = [];
    r2.getPort('GigabitEthernet0/0')!.attachTap(({ direction, frame }) => {
      if (direction !== 'in') return;
      const packet = frame.payload as IPv4Packet | undefined;
      if (packet?.type === 'ipv4' && packet.protocol === IP_PROTO_VRRP) {
        recu.push({ dstMAC: frame.dstMAC.toString(), packet });
      }
    });
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'vrrp 1 ip 10.0.0.254', 'vrrp 1 priority 200', 'end']) await r1.executeCommand(c);

    expect(recu.length).toBeGreaterThan(0);
  });
});

describe('la duplication a disparu', () => {
  it('aucun des quatre moteurs ne batit de trame ni ne nomme une MAC en dur', () => {
    const fautifs: string[] = [];
    const moteurs = [
      ['src/network/vrrp/VrrpAgent.ts', 'VRRP_MULTICAST_MAC'],
      ['src/network/glbp/GlbpAgent.ts', 'GLBP_MULTICAST_MAC'],
      ['src/network/pim/PimAgent.ts', 'PIM_ALL_ROUTERS_MAC'],
      ['src/network/hsrp/HsrpAgent.ts', 'multicastMacFor'],
    ] as const;
    for (const [path, macEnDur] of moteurs) {
      const texte = readFileSync(path, 'utf8');
      if (texte.includes('buildIpv4Frame')) fautifs.push(`${path}: buildIpv4Frame`);
      if (texte.includes(macEnDur)) fautifs.push(`${path}: ${macEnDur}`);
    }
    expect(fautifs).toEqual([]);
  });
});

describe('le regime « interface nommee » refuse un unicast', () => {
  it('linkDestinationFor rend null pour un unicast, et la MAC du groupe sinon', () => {
    expect(linkDestinationFor(new IPAddress('10.0.0.2'))).toBeNull();
    expect(linkDestinationFor(new IPAddress('224.0.0.13'))?.toString()).toBe('01:00:5e:00:00:0d');
    expect(linkDestinationFor(new IPAddress('224.0.0.102'))?.toString()).toBe('01:00:5e:00:00:66');
    expect(linkDestinationFor(new IPAddress('255.255.255.255'))?.toString())
      .toBe(MACAddress.broadcast().toString());
  });
});
