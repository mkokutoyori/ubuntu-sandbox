/**
 * Revue itération 2, §3.5 — ce que les vues affichent.
 *
 * Six défauts sans rapport entre eux sauf leur effet : une sortie qui ne
 * dit pas la vérité sur l'état de la machine, ou qui ne se relit pas.
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

async function lab(extra: readonly string[] = []): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  r.powerOn?.();
  for (const c of ['enable', 'configure terminal', 'hostname R-ROUTE',
    'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown',
    'standby 1 ip 10.0.12.254', 'standby 1 priority 110', 'standby 1 preempt', 'exit',
    'route-map PBR permit 10', 'exit',
    'interface GigabitEthernet0/0', 'ip policy route-map PBR', 'exit',
    'router bgp 65001', 'neighbor 10.0.12.2 remote-as 65002', 'exit',
    ...extra, 'end']) {
    await r.executeCommand(c);
  }
  return r;
}

describe('show standby brief', () => {
  it("abrège le nom d'interface au lieu de le couper", async () => {
    const r = await lab();
    const out = await r.executeCommand('show standby brief');
    // `GigabitEthe` ne désigne aucune interface et ne se retape pas.
    expect(out).not.toContain('GigabitEthe ');
    expect(out).toMatch(/^Gi0\/0\s+1\s+110/m);
  }, 30_000);
});

describe('show ip policy', () => {
  it("aligne ses colonnes sur l'en-tête qu'il annonce", async () => {
    const r = await lab();
    const lines = (await r.executeCommand('show ip policy')).split('\n');
    const head = lines[0];
    const row = lines.find((l) => l.startsWith('Gi0/0'));
    expect(row).toBeDefined();
    // La colonne « Route map » commence à la même position dans les deux.
    expect(row!.indexOf('PBR')).toBe(head.indexOf('Route map'));
    // Et plus aucune ligne ne commence par une espace parasite.
    for (const l of lines) expect(l.startsWith(' ')).toBe(false);
  }, 30_000);
});

describe('show ip rip database', () => {
  it("n'annonce pas auto-summary quand `no auto-summary` est configuré", async () => {
    const r = await lab(['router rip', 'version 2', 'network 10.0.0.0', 'no auto-summary', 'exit']);
    const out = await r.executeCommand('show ip rip database');
    // La vue contredisait la configuration affichée sur la même machine.
    expect(out).not.toContain('auto-summary');
    expect(out).toContain('directly connected, via configured network');
  }, 30_000);

  it("l'annonce quand auto-summary est actif", async () => {
    const r = await lab(['router rip', 'version 2', 'network 10.0.0.0', 'exit']);
    expect(await r.executeCommand('show ip rip database')).toContain('auto-summary');
  }, 30_000);
});

describe('show ip bgp — les arguments sont lus', () => {
  it('un préfixe absent est dit absent, pas remplacé par la table', async () => {
    const r = await lab();
    expect(await r.executeCommand('show ip bgp 172.16.99.0'))
      .toBe('% Network not in table');
  }, 30_000);

  it('`advertised-routes` rend ce qui est annoncé, pas le détail du voisin', async () => {
    const r = await lab();
    const out = await r.executeCommand('show ip bgp neighbors 10.0.12.2 advertised-routes');
    expect(out).not.toContain('BGP neighbor is');
    expect(out).toContain('Total number of prefixes');
  }, 30_000);

  it('un voisin inconnu est refusé plutôt que de rendre tous les autres', async () => {
    const r = await lab();
    const out = await r.executeCommand('show ip bgp neighbors 9.9.9.9');
    expect(out).toContain('% No such neighbor');
    expect(out).not.toContain('10.0.12.2');
  }, 30_000);

  it('sans argument, le détail de tous les voisins reste rendu', async () => {
    const r = await lab();
    expect(await r.executeCommand('show ip bgp neighbors'))
      .toContain('BGP neighbor is 10.0.12.2');
  }, 30_000);
});

describe('show ip route <vue>', () => {
  it("ne prétend pas qu'un préfixe manque là où on demandait une vue", async () => {
    const r = await lab();
    for (const vue of ['repair-paths', 'track-table', 'profile']) {
      const out = await r.executeCommand(`show ip route ${vue}`);
      // `% Network not in table` envoie chercher une adresse que
      // personne n'a demandée.
      expect(out, vue).not.toContain('Network not in table');
      expect(out, vue).toContain('Codes:');
    }
  }, 30_000);
});
