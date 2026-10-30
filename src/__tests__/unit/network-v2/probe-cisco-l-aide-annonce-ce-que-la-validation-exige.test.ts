/*
 * Deux defauts, un meme motif : la validation exigeait un mot que l'aide ne
 * disait pas.
 *
 * (1) Des commandes durcies (`clear ip bgp`, `default-information`, `bgp default
 * local-preference`, `negotiation`, `ip tcp adjust-mss`, `ip hello-interval
 * eigrp`, `ip hold-time eigrp`, `ip nhrp map|nhs`, `bfd interval`, `ntp
 * broadcast destination`) repondaient `% Incomplete command.` alors que `?`
 * annoncait `<cr>`; le garde-fou probe-aide-cr-tient-sa-promesse les nommait.
 * (2) `show cdp interface ?` offrait `entry`, `neighbors`, `traffic`, que la
 * machine refuse apres `interface`: les alternatives d'une place `REST`
 * se repetent a chaque rang. Les sous-commandes de `show cdp` / `show lldp`,
 * de `ntp broadcast|multicast` et de `bfd interval` sont maintenant declarees
 * chacune avec ses places.
 *
 * Mesure avant le changement : 18 cas, 15 tombent; 3 passent des deux cotes (les 2 temoins
 * ou la forme complete s'execute, et `ntp multicast client` sans groupe). Limite connue : apres `bgp default
 * local-preference` l'aide annonce encore `<cr>` (TODO.md).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); EquipmentRegistry.resetInstance(); Logger.clear();
});

type Dev = { cliHelp(s: string): string; executeCommand(c: string): Promise<string> };

async function neuf(prelude: readonly string[]): Promise<Dev> {
  const r = new CiscoRouter('R1') as unknown as Dev;
  await r.executeCommand('enable');
  for (const c of prelude) await r.executeCommand(c);
  return r;
}

const IFACE = ['configure terminal', 'interface GigabitEthernet0/0'];
const BGP = ['configure terminal', 'router bgp 65000'];
const EIGRP = ['configure terminal', 'router eigrp 1'];

const INCOMPLETE = 'Incomplete';
const sansCr = (aide: string): boolean => !/^\s\s<cr>\s*$/m.test(aide);

describe('la validation et l\'aide disent la meme chose', () => {
  it.each<[string, readonly string[], string]>([
    ['clear ip bgp', [], 'LINE'],
    ['default-information', BGP, 'originate'],
    ['default-information', EIGRP, 'originate'],
    ['negotiation', IFACE, 'auto'],
    ['ip tcp adjust-mss', IFACE, '<500-1460>'],
    ['ip hello-interval eigrp', IFACE, '<1-65535>'],
    ['ip hold-time eigrp', IFACE, '<1-65535>'],
    ['ip nhrp map', IFACE, 'A.B.C.D'],
    ['ip nhrp nhs', IFACE, 'A.B.C.D'],
    ['ntp broadcast destination', IFACE, 'A.B.C.D'],
  ])('`%s` exige un mot : l\'aide ne promet pas <cr> et la validation le confirme', async (commande, prelude, mot) => {
    const aide = (await neuf(prelude)).cliHelp(`${commande} `);
    expect(aide).toContain(mot);
    expect(sansCr(aide), aide).toBe(true);
    expect(await (await neuf(prelude)).executeCommand(commande)).toContain(INCOMPLETE);
  });

  it('`show cdp interface ?` n\'offre plus les mots d\'un autre rang', async () => {
    const aide = (await neuf([])).cliHelp('show cdp interface ');
    expect(aide).not.toMatch(/\bentry\b|\bneighbors\b|\btraffic\b/);
  });

  it('`show lldp interface ?` non plus', async () => {
    const aide = (await neuf([])).cliHelp('show lldp interface ');
    expect(aide).not.toMatch(/\bentry\b|\bneighbors\b|\berrors\b/);
  });

  it('`bfd interval ?` demande la valeur, puis propose min_rx et multiplier', async () => {
    const dev = await neuf(IFACE);
    expect(dev.cliHelp('bfd interval ')).not.toContain('min_rx');
    expect(dev.cliHelp('bfd interval 50 ')).toContain('min_rx');
  });

  it('`bgp default ?` propose les deux reglages', async () => {
    const aide = (await neuf(BGP)).cliHelp('bgp default ');
    expect(aide).toContain('ipv4-unicast');
    expect(aide).toContain('local-preference');
    expect(aide).not.toContain('log-neighbor-changes');
  });

  it('`bgp default local-preference` sans valeur est incomplete, et l\'aide nomme la plage', async () => {
    expect((await neuf(BGP)).cliHelp('bgp default local-preference ')).toContain('<0-4294967295>');
    expect(await (await neuf(BGP)).executeCommand('bgp default local-preference')).toContain(INCOMPLETE);
  });

  it('`ntp multicast client` sans groupe se valide encore', async () => {
    expect(await (await neuf(IFACE)).executeCommand('ntp multicast client')).toBe('');
  });
});

describe('temoins : les formes completes s\'executent', () => {
  it.each([
    ['ip nhrp map 10.0.0.1 1.2.3.4', IFACE],
    ['ip hello-interval eigrp 1 5', IFACE],
  ] as const)('`%s`', async (commande, prelude) => {
    expect(await (await neuf(prelude)).executeCommand(commande)).toBe('');
  });
});
