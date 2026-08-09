/**
 * mDNS et LLMNR parlent aussi sur leur groupe IPv6.
 *
 * Les deux RFC en demandent un — `ff02::fb` pour mDNS (RFC 6762 §3),
 * `ff02::1:3` pour LLMNR (RFC 4795 §2) — et les deux constantes
 * existaient dans ce depot, declarees « pour memoire », avec une raison
 * exacte ecrite a cote : la pile v6 ne portait pas l'emission vers un
 * groupe quelconque. Ce chemin existe desormais
 * (`EndHost.sendIPv6ToGroup`), donc le motif du renoncement est tombe.
 *
 * Ce qui se verifie ici est le FIL, pas le resolveur : qu'un datagramme
 * parte reellement vers le groupe v6, et que ce qu'il porte serve a
 * quelque chose — sans AAAA, un lien purement IPv6 verrait passer la
 * question et la reponse sans jamais apprendre d'adresse.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPv6Address, IPv6Packet } from '@/network/core/types';
import { getDefaultEventBus } from '@/events/EventBus';
import { MDNS_IPV6_GROUP, MDNS_BINDING, MDNS_PORT } from '@/network/mdns/types';
import { LLMNR_IPV6_GROUP, LLMNR_BINDING, LLMNR_PORT } from '@/network/llmnr/types';

interface DatagrammeV6 {
  deviceId: string;
  dstMAC: string;
  destinationIP: string;
  destinationPort: number;
}

/** Les datagrammes UDP v6 reellement demandes a un port. */
function observerLeFil(): DatagrammeV6[] {
  const vus: DatagrammeV6[] = [];
  getDefaultEventBus().subscribe('port.frame.tx-requested', (e) => {
    const p = e.payload as {
      deviceId: string;
      frame: { dstMAC: { toString(): string }; payload: unknown };
    };
    const ip = p.frame?.payload as IPv6Packet | undefined;
    if (!ip || ip.type !== 'ipv6') return;
    const udp = ip.payload as { type?: string; destinationPort?: number } | undefined;
    if (udp?.type !== 'udp') return;
    vus.push({
      deviceId: p.deviceId,
      dstMAC: p.frame.dstMAC.toString().toLowerCase(),
      destinationIP: ip.destinationIP.toString(),
      destinationPort: udp.destinationPort ?? -1,
    });
  });
  return vus;
}

const cfg6 = (h: LinuxPC, iface: string, adresse: string): void => {
  (h as unknown as {
    configureIPv6Interface(i: string, a: IPv6Address, p: number): boolean;
  }).configureIPv6Interface(iface, new IPv6Address(adresse), 64);
};

let a: LinuxPC;
let b: LinuxPC;

beforeEach(() => {
  a = new LinuxPC('A');
  b = new LinuxPC('B');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  a.powerOn(); b.powerOn(); sw.powerOn();
  new Cable('x').connect(a.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('y').connect(b.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  // Deux LinuxPC neufs portent le MEME hostname (`LinuxPC`) : sans les
  // distinguer, chacun repondrait pour le nom de l'autre et le
  // laboratoire ne prouverait rien.
  a.setHostname('alpha');
  b.setHostname('beta');
  cfg6(a, 'eth0', '2001:db8::1');
  cfg6(b, 'eth0', '2001:db8::2');
});

describe('la declaration du groupe v6', () => {
  it('les deux liaisons le portent maintenant, au lieu de le declarer pour memoire', () => {
    expect(MDNS_BINDING.group6).toBe(MDNS_IPV6_GROUP);
    expect(LLMNR_BINDING.group6).toBe(LLMNR_IPV6_GROUP);
  });
});

describe('mDNS emet sur ff02::fb', () => {
  it('une annonce part vers le groupe v6, et vers la bonne adresse Ethernet', async () => {
    const agent = a.getMdnsAgent();
    expect(agent).toBeTruthy();
    agent!.start();
    await agent!.whenReady();

    const fil = observerLeFil();
    expect(agent!.announce()).toBe(true);

    const versGroupe = fil.filter((d) => d.destinationIP === MDNS_IPV6_GROUP);
    expect(versGroupe.length).toBeGreaterThan(0);
    expect(versGroupe.every((d) => d.destinationPort === MDNS_PORT)).toBe(true);
    // RFC 2464 §7 : les 32 bits de poids faible du groupe.
    expect(new Set(versGroupe.map((d) => d.dstMAC))).toEqual(new Set(['33:33:00:00:00:fb']));
  });
});

describe('LLMNR emet sur ff02::1:3', () => {
  it('une question part vers le groupe v6', async () => {
    const agent = a.getLlmnrAgent();
    expect(agent).toBeTruthy();
    agent!.start();

    const fil = observerLeFil();
    await agent!.resolve('beta');

    const versGroupe = fil.filter((d) => d.destinationIP === LLMNR_IPV6_GROUP);
    expect(versGroupe.length).toBeGreaterThan(0);
    expect(versGroupe.every((d) => d.destinationPort === LLMNR_PORT)).toBe(true);
    expect(new Set(versGroupe.map((d) => d.dstMAC))).toEqual(new Set(['33:33:00:01:00:03']));
  });
});

describe('ce que le paquet porte sert a quelque chose', () => {
  it('LLMNR repond une adresse IPv6 a une question AAAA', async () => {
    const cible = b.getLlmnrAgent();
    expect(cible).toBeTruthy();
    cible!.start();
    const demandeur = a.getLlmnrAgent();
    demandeur!.start();

    const adresses = await demandeur!.resolveAaaa('beta');
    expect(adresses).toContain('2001:db8::2');
  });

  it('l\'adresse de lien-local n\'est jamais annoncee', async () => {
    const cible = b.getLlmnrAgent();
    cible!.start();
    const demandeur = a.getLlmnrAgent();
    demandeur!.start();

    const adresses = await demandeur!.resolveAaaa('beta');
    // Une liste vide satisferait la ligne suivante sans rien prouver.
    expect(adresses.length).toBeGreaterThan(0);
    // Elle est ambigue hors de son lien, et l'enregistrement ne porte
    // pas l'indice de zone qui la desambiguiserait.
    expect(adresses.some((ip) => ip.toLowerCase().startsWith('fe80'))).toBe(false);
  });
});

describe('non-regression', () => {
  it('la resolution IPv4 par LLMNR continue de fonctionner', async () => {
    a.getPort('eth0')!.configureIP(
      new (await import('@/network/core/types')).IPAddress('10.0.0.1'),
      new (await import('@/network/core/types')).SubnetMask('255.255.255.0'));
    b.getPort('eth0')!.configureIP(
      new (await import('@/network/core/types')).IPAddress('10.0.0.2'),
      new (await import('@/network/core/types')).SubnetMask('255.255.255.0'));

    b.getLlmnrAgent()!.start();
    a.getLlmnrAgent()!.start();
    const adresses = await a.getLlmnrAgent()!.resolve('beta');
    expect(adresses).toContain('10.0.0.2');
  });
});
