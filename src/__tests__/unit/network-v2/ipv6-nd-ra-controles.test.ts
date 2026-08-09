/**
 * Les commandes qui gouvernent l'annonce de routeur.
 *
 * Elles n'avaient de sens que depuis que l'annonce a lieu pour de bon
 * (voir `slaac-ra-vrais-paquets.test.ts`), et la mesure faite juste
 * apres a montre que la moitie d'entre elles etait un decor :
 *
 *   - `ipv6 nd managed-config-flag` et `other-config-flag` etaient
 *     ranges sur une propriete ad hoc du port (`ipv6NdManagedFlag`) que
 *     PERSONNE ne lisait — l'annonce se construit depuis `raConfig`, un
 *     autre magasin —, donc les deux bits partaient toujours a zero,
 *     quelle que soit la configuration.
 *   - `ipv6 nd ra suppress`, la commande qui coupe l'annonce, n'existait
 *     pas : `% Invalid input detected`.
 *   - La duree de vie du routeur etait figee a 1800 s, sans commande
 *     pour la regler, alors que la valeur zero a un sens precis.
 *
 * Discrimination par `git stash` : 5 cas sur 11 tombent avant
 * correctif. Les 6 autres passent des deux cotes, et c'est attendu
 * plutot que satisfaisant — les cas de refus passaient parce que la
 * commande entiere etait refusee, et les cas en `no` parce que rien
 * n'etait pose de toute facon. Ils gardent le parseur, ils ne prouvent
 * pas la fonction.
 */

import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPv6Packet, ICMPv6Packet, NDPRouterAdvertisement } from '@/network/core/types';
import { getDefaultEventBus } from '@/events/EventBus';

/** Les annonces reellement emises, lues sur le bus. */
function observerAnnonces(): NDPRouterAdvertisement[] {
  const vues: NDPRouterAdvertisement[] = [];
  getDefaultEventBus().subscribe('port.frame.tx-requested', (e) => {
    const p = e.payload as { frame: { payload: unknown } };
    const ip = p.frame?.payload as IPv6Packet | undefined;
    const icmp = ip?.payload as ICMPv6Packet | undefined;
    if (icmp?.icmpType === 'router-advertisement') {
      vues.push(icmp.ndp as NDPRouterAdvertisement);
    }
  });
  return vues;
}

const cfg = async (r: CiscoRouter, lignes: string[]): Promise<string[]> => {
  const out: string[] = [];
  for (const l of lignes) out.push(await r.executeCommand(l));
  return out;
};

/** Un routeur configure, puis cable a un hote. */
async function labo(commandesNd: string[]): Promise<{
  r: CiscoRouter; h: LinuxPC; annonces: NDPRouterAdvertisement[]; sorties: string[];
}> {
  const r = new CiscoRouter('R1');
  const h = new LinuxPC('H');
  h.powerOn();
  const annonces = observerAnnonces();
  const sorties = await cfg(r, [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8::1/64',
    ...commandesNd,
    'no shutdown', 'end',
  ]);
  new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, h.getPort('eth0')!);
  return { r, h, annonces, sorties };
}

const refuses = (sorties: string[]): string[] => sorties.filter((s) => s.includes('%'));

describe('les drapeaux M et O arrivent sur le fil', () => {
  it('par defaut ils valent zero', async () => {
    const { annonces } = await labo([]);
    expect(annonces.length).toBeGreaterThan(0);
    expect(annonces.every((a) => a.managedFlag === false)).toBe(true);
    expect(annonces.every((a) => a.otherConfigFlag === false)).toBe(true);
  });

  it('configures, ils valent un', async () => {
    const { annonces, sorties } = await labo([
      'ipv6 nd managed-config-flag', 'ipv6 nd other-config-flag',
    ]);
    expect(refuses(sorties)).toEqual([]);
    expect(annonces.length).toBeGreaterThan(0);
    expect(annonces.every((a) => a.managedFlag === true)).toBe(true);
    expect(annonces.every((a) => a.otherConfigFlag === true)).toBe(true);
  });

  it('le `no` les repose a zero', async () => {
    const { annonces } = await labo([
      'ipv6 nd managed-config-flag', 'no ipv6 nd managed-config-flag',
    ]);
    expect(annonces.length).toBeGreaterThan(0);
    expect(annonces.every((a) => a.managedFlag === false)).toBe(true);
  });
});

describe('supprimer l\'annonce la supprime', () => {
  it('`suppress` tait l\'annonce spontanee', async () => {
    const { annonces, sorties } = await labo(['ipv6 nd ra suppress']);
    expect(refuses(sorties)).toEqual([]);
    // Ce qui reste ne peut etre qu'une reponse a une sollicitation.
    expect(annonces.length).toBeLessThanOrEqual(1);
  });

  it('mais l\'hote s\'autoconfigure quand meme, parce qu\'il sollicite', async () => {
    const { h } = await labo(['ipv6 nd ra suppress']);
    const sortie = await h.executeCommand('ip -6 addr show');
    expect(sortie).toMatch(/inet6 2001:db8::[0-9a-f:]+\/64 scope global/);
  });

  it('`suppress all` tait aussi la reponse, et l\'hote reste sans adresse', async () => {
    const { h, annonces, sorties } = await labo(['ipv6 nd ra suppress all']);
    expect(refuses(sorties)).toEqual([]);
    expect(annonces).toEqual([]);
    const sortie = await h.executeCommand('ip -6 addr show');
    expect(sortie).not.toMatch(/inet6 2001:db8::[0-9a-f:]+\/64 scope global/);
  });

  it('le `no` rend la parole au routeur', async () => {
    const { h } = await labo(['ipv6 nd ra suppress all', 'no ipv6 nd ra suppress']);
    const sortie = await h.executeCommand('ip -6 addr show');
    expect(sortie).toMatch(/inet6 2001:db8::[0-9a-f:]+\/64 scope global/);
  });

  it('un mot-cle inconnu derriere `suppress` est refuse', async () => {
    const { sorties } = await labo(['ipv6 nd ra suppress nimportequoi']);
    expect(refuses(sorties).length).toBe(1);
  });
});

describe('une duree de vie nulle n\'est pas un routeur par defaut', () => {
  it('la valeur reglee est celle qui part', async () => {
    const { annonces } = await labo(['ipv6 nd ra lifetime 600']);
    expect(annonces.length).toBeGreaterThan(0);
    expect(annonces.every((a) => a.routerLifetime === 600)).toBe(true);
  });

  it('a zero, l\'hote garde son adresse et ne pose PAS de route par defaut', async () => {
    // RFC 4861 §4.2 : la duree de vie ne concerne que le role de
    // routeur par defaut, pas l'autoconfiguration par le prefixe.
    const { h } = await labo(['ipv6 nd ra lifetime 0']);
    const adr = await h.executeCommand('ip -6 addr show');
    const routes = await h.executeCommand('ip -6 route show');
    expect(adr).toMatch(/inet6 2001:db8::[0-9a-f:]+\/64 scope global/);
    expect(routes).toContain('2001:db8::/64 dev eth0');
    expect(routes).not.toMatch(/^default via/m);
  });

  it('une valeur hors bornes est refusee, et une valeur absente aussi', async () => {
    const { sorties } = await labo(['ipv6 nd ra lifetime 99999', 'ipv6 nd ra lifetime']);
    expect(refuses(sorties).length).toBe(2);
  });
});
