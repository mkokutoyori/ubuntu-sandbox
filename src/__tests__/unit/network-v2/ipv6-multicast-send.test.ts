/**
 * Le chemin d'émission multicast IPv6.
 *
 * Il n'existait pas, et c'est le blocage que ce dépôt avait déjà
 * rencontré deux fois sans le lever : mDNS a dû renoncer à ses groupes
 * IPv6 (`FF02::1:3`/`FF02::FB`) « faute d'un chemin d'envoi vers un
 * groupe quelconque », et OSPFv3 forme ses adjacences hors bande pour
 * la même raison.
 *
 * La cause était précise : `sendUdpDatagram6` passait par
 * `resolveIPv6Route` puis résolvait le prochain saut par NDP. Pour
 * `ff02::5` cela ne peut PAS aboutir — un groupe n'a pas de voisin à
 * solliciter — donc tout envoi multicast échouait en silence.
 *
 * Ce qui manquait n'était pas la conversion d'adresse : `toMulticastMAC()`
 * (RFC 2464 §7) existait depuis toujours, sans un seul appelant.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPv6Address } from '@/network/core/types';

let a: LinuxPC;
let b: LinuxPC;
/** Ce que B a réellement reçu sur le port d'écoute. */
let recu: string[];

function ecoute(hote: LinuxPC, port: number): void {
  (hote as unknown as { udpListeners: Map<number, (d: unknown) => void> })
    .udpListeners.set(port, (d) => {
      const dgram = d as { udp?: { payload?: unknown } };
      recu.push(String(dgram.udp?.payload));
    });
}

function cfg(hote: LinuxPC, iface: string, adresse: string): void {
  (hote as unknown as {
    configureIPv6Interface(i: string, a: IPv6Address, p: number): boolean;
  }).configureIPv6Interface(iface, new IPv6Address(adresse), 64);
}

beforeEach(() => {
  recu = [];
  a = new LinuxPC('A');
  b = new LinuxPC('B');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  a.powerOn(); b.powerOn(); sw.powerOn();
  new Cable('x').connect(a.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('y').connect(b.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  // `configureIPv6Interface` et non `Port.configureIPv6` : c'est le
  // chemin que prend `ip -6 addr add`, et lui seul inscrit la route
  // connectée sans laquelle l'unicast n'a aucune route à résoudre.
  cfg(a, 'eth0', '2001:db8::1');
  cfg(b, 'eth0', '2001:db8::2');
  ecoute(b, 4242);
});

const h = (d: LinuxPC) => d as unknown as {
  joinIPv6Group(i: string, g: string): boolean;
  leaveIPv6Group(i: string, g: string): boolean;
  listIPv6Groups(i?: string): Array<{ iface: string; group: string }>;
  sendUdpDatagram6(dst: IPv6Address, dp: number, sp: number, p: unknown, n: number): boolean;
};

describe('un datagramme atteint un groupe IPv6', () => {
  it('l\'hôte abonné le reçoit', () => {
    expect(h(b).joinIPv6Group('eth0', 'ff02::99')).toBe(true);
    expect(h(a).sendUdpDatagram6(new IPv6Address('ff02::99'), 4242, 5000, 'coucou', 6)).toBe(true);
    expect(recu).toEqual(['coucou']);
  });

  it('un hôte NON abonné ne le reçoit pas', () => {
    // Le garde-fou du lot : sans lui, « tout livrer » passerait le cas
    // précédent sans qu'aucun filtre n'existe.
    expect(h(a).sendUdpDatagram6(new IPv6Address('ff02::77'), 4242, 5000, 'x', 1)).toBe(true);
    expect(recu).toEqual([]);
  });

  it('quitter le groupe suffit à ne plus rien recevoir', () => {
    h(b).joinIPv6Group('eth0', 'ff02::99');
    h(a).sendUdpDatagram6(new IPv6Address('ff02::99'), 4242, 5000, 'un', 2);
    expect(h(b).leaveIPv6Group('eth0', 'ff02::99')).toBe(true);
    h(a).sendUdpDatagram6(new IPv6Address('ff02::99'), 4242, 5000, 'deux', 4);
    expect(recu).toEqual(['un']);
  });

  it('l\'appartenance se lit', () => {
    h(b).joinIPv6Group('eth0', 'ff02::99');
    // Pas d'égalité stricte : la machine est aussi membre des groupes
    // de LLMNR et mDNS, que systemd-resolved rejoint au démarrage sur
    // chaque interface.
    expect(h(b).listIPv6Groups()).toContainEqual({ iface: 'eth0', group: 'ff02::99' });
    expect(h(b).listIPv6Groups('eth1')).not.toContainEqual({ iface: 'eth1', group: 'ff02::99' });
  });

  it('un groupe mal formé, ou une adresse unicast, est refusé', () => {
    expect(h(b).joinIPv6Group('eth0', 'pas-une-adresse')).toBe(false);
    // `2001:db8::2` est SON adresse, et ce n'est pas un groupe.
    expect(h(b).joinIPv6Group('eth0', '2001:db8::2')).toBe(false);
  });

  it('une interface qui n\'existe pas est refusée', () => {
    expect(h(b).joinIPv6Group('eth9', 'ff02::99')).toBe(false);
  });
});

describe('ce qui distingue un envoi multicast d\'un envoi ordinaire', () => {
  it('l\'unicast IPv6 continue de fonctionner', async () => {
    // La non-régression : le chemin ajouté ne doit pas détourner
    // l'unicast, qui lui a bien une route et un voisin. L'attente est
    // celle du voisinage — le premier paquet vers un voisin inconnu part
    // APRÈS la sollicitation NDP, comme sur une vraie pile.
    ecoute(b, 4243);
    expect(h(a).sendUdpDatagram6(new IPv6Address('2001:db8::2'), 4243, 5000, 'direct', 6)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(recu).toEqual(['direct']);
  });

  it('l\'envoi réussit même sans voisin à solliciter', () => {
    // C'était le défaut : NDP ne peut pas résoudre un groupe, donc
    // l'envoi échouait. Personne n'écoute ici, et l'émission doit
    // néanmoins avoir lieu.
    expect(h(a).sendUdpDatagram6(new IPv6Address('ff02::1'), 9999, 5000, 'x', 1)).toBe(true);
  });
});
