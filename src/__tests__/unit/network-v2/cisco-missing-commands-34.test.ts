/**
 * Revue itération 2, §3.4 — les commandes que la CLI refusait au caret.
 *
 * Deux familles distinctes. Celles qui pilotent un état que la machine
 * tient déjà (CEF IPv6, multicast, Auto-RP, VRF, listes AS-path et
 * community) : elles agissent et leurs vues lisent ce même état. Et
 * EIGRP pour IPv6, dont ce moteur n'a AUCUN plan de données v6 : la
 * configuration est retenue et rendue pour qu'un collage se rejoue, et
 * `show ipv6 eigrp neighbors` ne montre aucun voisin — ce qui est la
 * vérité, faute de transport.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const CARET = "% Invalid input detected at '^' marker.";

async function router(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  r.powerOn?.();
  for (const c of ['enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.0',
    'no shutdown', 'exit']) {
    await r.executeCommand(c);
  }
  return r;
}

describe('commandes de configuration §3.4', () => {
  it('ipv6 cef et ip multicast-routing sont acceptés et rendus', async () => {
    const r = await router();
    expect(await r.executeCommand('ipv6 cef')).toBe('');
    expect(await r.executeCommand('ip multicast-routing')).toBe('');
    await r.executeCommand('end');
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain('ipv6 cef');
    expect(cfg).toContain('ip multicast-routing');
  }, 30_000);

  it('leur forme `no` les retire de la configuration', async () => {
    const r = await router();
    await r.executeCommand('ipv6 cef');
    await r.executeCommand('ip multicast-routing');
    await r.executeCommand('no ipv6 cef');
    await r.executeCommand('no ip multicast-routing');
    await r.executeCommand('end');
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).not.toContain('ipv6 cef');
    expect(cfg).not.toContain('ip multicast-routing');
  }, 30_000);

  it('ip pim send-rp-announce prend son adresse sur l\'interface nommée', async () => {
    const r = await router();
    expect(await r.executeCommand('ip pim send-rp-announce Loopback0 scope 10')).toBe('');
    await r.executeCommand('end');
    expect(await r.executeCommand('show running-config'))
      .toContain('ip pim send-rp-announce Loopback0 scope 10');
  }, 30_000);

  it('ip pim send-rp-announce refuse une interface sans adresse', async () => {
    const r = await router();
    expect(await r.executeCommand('ip pim send-rp-announce GigabitEthernet0/3 scope 10'))
      .toContain('has no IP address');
  }, 30_000);

  it('distribute-list est retenu sous RIP comme sous EIGRP', async () => {
    const r = await router();
    await r.executeCommand('router rip');
    expect(await r.executeCommand('distribute-list 1 in')).toBe('');
    await r.executeCommand('exit');
    await r.executeCommand('router eigrp 100');
    expect(await r.executeCommand('distribute-list prefix PL1 out GigabitEthernet0/0')).toBe('');
    await r.executeCommand('end');
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain(' distribute-list 1 in');
    expect(cfg).toContain(' distribute-list prefix PL1 out GigabitEthernet0/0');
  }, 30_000);
});

describe('vues §3.4 adossées à un état réel', () => {
  async function withVrfAndLists(): Promise<CiscoRouter> {
    const r = await router();
    await r.executeCommand('ip vrf CLIENT-A');
    await r.executeCommand('rd 65001:100');
    await r.executeCommand('exit');
    await r.executeCommand('ip as-path access-list 1 permit ^65002$');
    await r.executeCommand('ip as-path access-list 1 deny .*');
    await r.executeCommand('ip community-list standard CL1 permit 65001:100');
    await r.executeCommand('end');
    return r;
  }

  it('show ip vrf detail décrit le VRF configuré', async () => {
    const r = await withVrfAndLists();
    const out = await r.executeCommand('show ip vrf detail');
    expect(out).not.toContain(CARET);
    expect(out).toContain('VRF CLIENT-A');
    expect(out).toContain('65001:100');
  }, 30_000);

  it('show ip vrf detail refuse un VRF qui n\'existe pas', async () => {
    const r = await withVrfAndLists();
    expect(await r.executeCommand('show ip vrf detail ABSENT'))
      .toContain('does not exist');
  }, 30_000);

  it('show ip vrf interfaces répond sans erreur', async () => {
    const r = await withVrfAndLists();
    expect(await r.executeCommand('show ip vrf interfaces')).not.toContain(CARET);
  }, 30_000);

  it('show ip as-path-access-list rend les règles telles que saisies', async () => {
    const r = await withVrfAndLists();
    const out = await r.executeCommand('show ip as-path-access-list');
    expect(out).toContain('AS path access list 1');
    expect(out).toContain('permit ^65002$');
    expect(out).toContain('deny .*');
  }, 30_000);

  it('show ip community-list nomme le type déclaré', async () => {
    const r = await withVrfAndLists();
    const out = await r.executeCommand('show ip community-list');
    expect(out).toContain('Community standard list CL1');
    expect(out).toContain('permit 65001:100');
  }, 30_000);

  it('show ip protocols vrf refuse un VRF absent et décrit celui qui existe', async () => {
    const r = await withVrfAndLists();
    expect(await r.executeCommand('show ip protocols vrf CLIENT-A')).toContain('CLIENT-A');
    expect(await r.executeCommand('show ip protocols vrf ABSENT')).toContain('does not exist');
  }, 30_000);

  it('show adjacency lit la table ARP réelle', async () => {
    const r = await withVrfAndLists();
    const out = await r.executeCommand('show adjacency');
    expect(out).not.toContain(CARET);
    expect(out).toContain('Protocol Interface');
  }, 30_000);
});

describe('EIGRP pour IPv6 — configuré, et honnête sur ce qu\'il fait', () => {
  it('les deux commandes sont acceptées', async () => {
    const r = await router();
    expect(await r.executeCommand('ipv6 router eigrp 100')).toBe('');
    await r.executeCommand('exit');
    await r.executeCommand('interface GigabitEthernet0/0');
    expect(await r.executeCommand('ipv6 eigrp 100')).toBe('');
  }, 30_000);

  it('un numéro hors bornes est refusé', async () => {
    const r = await router();
    expect(await r.executeCommand('ipv6 router eigrp 99999')).toContain(CARET);
  }, 30_000);

  it('show ipv6 eigrp neighbors ne montre aucun voisin, faute de transport v6', async () => {
    const r = await router();
    await r.executeCommand('ipv6 router eigrp 100');
    await r.executeCommand('exit');
    await r.executeCommand('end');
    const out = await r.executeCommand('show ipv6 eigrp neighbors');
    expect(out).toContain('EIGRP-IPv6 Neighbors for AS(100)');
    expect(out.split('\n').filter((l) => /^H\s+\d/.test(l))).toEqual([]);
  }, 30_000);

  it('show ipv6 protocols liste les processus v6 réellement configurés', async () => {
    const r = await router();
    await r.executeCommand('ipv6 router ospf 1');
    await r.executeCommand('exit');
    await r.executeCommand('ipv6 router eigrp 100');
    await r.executeCommand('exit');
    await r.executeCommand('end');
    const out = await r.executeCommand('show ipv6 protocols');
    expect(out).not.toContain(CARET);
    expect(out).toContain('"ospf 1"');
    expect(out).toContain('"eigrp 100"');
  }, 30_000);
});
