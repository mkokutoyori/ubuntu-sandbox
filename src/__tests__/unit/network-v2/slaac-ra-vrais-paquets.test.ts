/**
 * L'autoconfiguration IPv6 sans etat (SLAAC, RFC 4862) a lieu.
 *
 * Toute la chaine etait ecrite et aucun de ses deux declencheurs ne
 * l'etait, de sorte qu'elle n'etait jamais atteinte :
 *
 *   - `EndHost.sendRouterSolicitation` est complet et correct, et son
 *     seul appelant dans tout le depot etait `ipconfig /renew6` sous
 *     Windows. Aucun hote ne sollicitait donc jamais de lui-meme
 *     (RFC 4861 section 6.3.7).
 *   - Le routeur n'emettait aucune annonce non sollicitee : le minuteur
 *     de `configureRA` n'etait arme par personne, et rien n'annoncait a
 *     la configuration d'un prefixe (RFC 4861 section 6.2.4).
 *
 * `handleRouterSolicitation`, `sendRouterAdvertisement` et la reception
 * SLAAC de `handleRouterAdvertisement` existaient tous et fonctionnent :
 * ce lot n'ecrit aucune logique de protocole, il branche les deux
 * declencheurs qui manquaient.
 *
 * La mesure de depart : un hote cable a un routeur portant
 * `ipv6 address 2001:db8::1/64` n'obtenait QUE son adresse de
 * lien-local, et une seule trame traversait le fil — un CDP.
 */

import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPv6Packet, ICMPv6Packet } from '@/network/core/types';
import { getDefaultEventBus } from '@/events/EventBus';

/** Les messages NDP reellement emis, lus sur le bus. */
function observerNdp(): Array<{ deviceId: string; type: string; dst: string }> {
  const vus: Array<{ deviceId: string; type: string; dst: string }> = [];
  getDefaultEventBus().subscribe('port.frame.tx-requested', (e) => {
    const p = e.payload as { deviceId: string; frame: { payload: unknown } };
    const ip = p.frame?.payload as IPv6Packet | undefined;
    if (!ip || ip.type !== 'ipv6') return;
    const icmp = ip.payload as ICMPv6Packet | undefined;
    if (!icmp?.icmpType) return;
    vus.push({
      deviceId: p.deviceId,
      type: String(icmp.icmpType),
      dst: ip.destinationIP.toString(),
    });
  });
  return vus;
}

const cfg = async (r: CiscoRouter, lignes: string[]): Promise<void> => {
  for (const l of lignes) await r.executeCommand(l);
};

async function labo(options: { cablerAvant?: boolean } = {}): Promise<{
  r: CiscoRouter; h: LinuxPC; ndp: ReturnType<typeof observerNdp>;
}> {
  const r = new CiscoRouter('R1');
  const h = new LinuxPC('H');
  h.powerOn();
  const ndp = observerNdp();
  const cabler = (): void => {
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, h.getPort('eth0')!);
  };
  if (options.cablerAvant) cabler();
  await cfg(r, [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8::1/64',
    'no shutdown', 'end',
  ]);
  if (!options.cablerAvant) cabler();
  return { r, h, ndp };
}

describe('l\'hote s\'autoconfigure', () => {
  it('il obtient une adresse globale tiree du prefixe annonce', async () => {
    const { h } = await labo();
    const sortie = await h.executeCommand('ip -6 addr show');
    expect(sortie).toMatch(/inet6 2001:db8::[0-9a-f:]+\/64 scope global/);
  });

  it('il garde son adresse de lien-local, qui ne vient pas du routeur', async () => {
    const { h } = await labo();
    const sortie = await h.executeCommand('ip -6 addr show');
    expect(sortie).toMatch(/inet6 fe80::[0-9a-f:]+\/64 scope link/);
  });

  it('il pose la route du prefixe et une route par defaut', async () => {
    const { h } = await labo();
    const routes = await h.executeCommand('ip -6 route show');
    expect(routes).toContain('2001:db8::/64 dev eth0');
    expect(routes).toMatch(/^default via fe80::/m);
  });

  it('et il joint vraiment le routeur', async () => {
    const { h } = await labo();
    const ping = await h.executeCommand('ping6 -c 1 2001:db8::1');
    expect(ping).toMatch(/, 0% packet loss/);
  });
});

describe('ce sont de vrais messages NDP', () => {
  it('l\'hote sollicite les routeurs a l\'activation du lien', async () => {
    const { h, ndp } = await labo();
    const rs = ndp.filter((m) => m.type === 'router-solicitation');
    expect(rs.length).toBeGreaterThan(0);
    expect(rs.every((m) => m.deviceId === h.getId())).toBe(true);
    // RFC 4861 section 6.3.7 : la sollicitation va au groupe des routeurs.
    expect(rs.every((m) => m.dst === 'ff02::2')).toBe(true);
  });

  it('le routeur annonce, et vers le groupe de tous les noeuds', async () => {
    const { r, ndp } = await labo();
    const ra = ndp.filter((m) => m.type === 'router-advertisement');
    expect(ra.length).toBeGreaterThan(0);
    expect(ra.every((m) => m.deviceId === r.getId())).toBe(true);
    expect(ra.some((m) => m.dst === 'ff02::1')).toBe(true);
  });
});

describe('l\'ordre des operations ne change pas le resultat', () => {
  it('cable d\'abord, adresse ensuite : l\'annonce suit la configuration', async () => {
    const { h } = await labo({ cablerAvant: true });
    const sortie = await h.executeCommand('ip -6 addr show');
    expect(sortie).toMatch(/inet6 2001:db8::[0-9a-f:]+\/64 scope global/);
  });
});

describe('ce que le routeur n\'annonce pas', () => {
  it('sans routage IPv6, rien n\'est annonce et l\'hote reste en lien-local', async () => {
    const r = new CiscoRouter('R1');
    const h = new LinuxPC('H');
    h.powerOn();
    const ndp = observerNdp();
    // Pas de `ipv6 unicast-routing` : la machine n'est pas un routeur.
    await cfg(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ipv6 address 2001:db8::1/64', 'no shutdown', 'end']);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, h.getPort('eth0')!);

    expect(ndp.filter((m) => m.type === 'router-advertisement')).toEqual([]);
    const sortie = await h.executeCommand('ip -6 addr show');
    expect(sortie).not.toMatch(/inet6 2001:db8::[0-9a-f:]+\/64 scope global/);
  });
});

describe('l\'indice de zone n\'est pas sur le fil', () => {
  it('la route par defaut designe l\'interface de l\'HOTE, pas celle du routeur', async () => {
    const { h } = await labo();
    const routes = await h.executeCommand('ip -6 route show');
    const ligne = routes.split('\n').find((l) => l.startsWith('default via'));
    expect(ligne).toBeDefined();
    // L'indice de zone ne fait pas partie des 128 bits et ne veut rien
    // dire chez le voisin : adopter celui du routeur donnait a l'hote
    // une route designant une interface qu'il n'a pas.
    expect(ligne).toContain('%eth0');
    expect(ligne).not.toContain('GigabitEthernet');
  });
});
