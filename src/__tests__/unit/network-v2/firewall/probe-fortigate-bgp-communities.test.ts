/**
 * Communautes BGP (RFC 1997) : l'attribut COMMUNITIES voyage dans les UPDATE du moteur BGP (il ne le faisait pas : les entrees de la table portaient `communities: []`),
 * `no-export` retient la route a la frontiere d'un AS et `no-advertise` chez soi (RFC 1997 §3). Cote FortiGate (FortiOS CLI Reference 7.4.12) : `config router community-list`
 * (type standard : `match` liste les communautes toutes requises ; expanded : `regexp`), `match-community`, `set-community` et `set-community-additive` dans une route-map.
 * Deux FortiGate se pairent sur le cable : A marque 172.16.0.0/16 de 65001:100, B ne retient que ce qui porte 65001:100.
 * Mesure de depart : « unknown configuration path router community-list » ; 3 des 5 cas tombent avant (liste standard, liste etendue, no-export) ; le temoin (sans route-map B recoit les deux reseaux) et le refus d'une liste inconnue passent des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<void> {
  for (const command of commands) await device.executeCommand(command);
}

interface BgpRow { network: { toString(): string } }
const learnedBy = (firewall: FortiGate): string[] =>
  (firewall as unknown as { getRouting(): { getBgp(): { getEngine(): { getBgpTable(): BgpRow[] } } } })
    .getRouting().getBgp().getEngine().getBgpTable().map((row) => row.network.toString()).filter((network) => network.startsWith('172.'));

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

const SIXTEEN = ['config router prefix-list', 'edit "p16"', 'config rule', 'edit 1', 'set prefix 172.16.0.0 255.255.0.0', 'set action permit', 'next', 'end', 'next', 'end'];
const SEVENTEEN = ['config router prefix-list', 'edit "p17"', 'config rule', 'edit 1', 'set prefix 172.17.0.0 255.255.0.0', 'set action permit', 'next', 'end', 'next', 'end'];
const mapOut = (name: string, rule1: readonly string[], rule2: readonly string[] = []) =>
  ['config router route-map', `edit "${name}"`, 'config rule', 'edit 1', ...rule1, 'next', 'edit 2', ...rule2, 'next', 'end', 'next', 'end'];

async function pair(aOutMap: string, aNeighbour: readonly string[], bBefore: readonly string[], bNeighbour: readonly string[]) {
  const a = new FortiGate('firewall-fortinet', 'A', 0, 0);
  const b = new FortiGate('firewall-fortinet', 'B', 200, 0);
  new Cable('ab').connect(a.getPort('port2')!, b.getPort('port2')!);
  await type(a, [...SIXTEEN, ...SEVENTEEN,
    ...mapOut('tagA', ['set match-ip-address "p16"', 'set set-community "65001:100"'], ['set action permit']),
    ...mapOut('noexp', ['set match-ip-address "p17"', 'set set-community "no-export"'], ['set action permit']),
    'config system interface', 'edit port1', 'set ip 172.16.0.1 255.255.0.0', 'next', 'edit port3', 'set ip 172.17.0.1 255.255.0.0', 'next',
    'edit port2', 'set ip 10.9.0.1 255.255.255.0', 'next', 'end',
    'config router bgp', 'set as 65001', 'set router-id 1.1.1.1',
    'config network', 'edit 1', 'set prefix 172.16.0.0 255.255.0.0', 'next', 'edit 2', 'set prefix 172.17.0.0 255.255.0.0', 'next', 'end',
    'config neighbor', 'edit "10.9.0.2"', 'set remote-as 65002', ...aNeighbour, 'next', 'end', 'end']);
  await type(b, [...bBefore,
    'config system interface', 'edit port2', 'set ip 10.9.0.2 255.255.255.0', 'next', 'end',
    'config router bgp', 'set as 65002', 'set router-id 2.2.2.2',
    'config neighbor', 'edit "10.9.0.1"', 'set remote-as 65001', ...bNeighbour, 'next', 'end', 'end']);
  clock.advance(240_000);
  return { a, b };
}

const COMMUNITY_LIST = ['config router community-list', 'edit "has100"', 'set type standard', 'config rule', 'edit 1', 'set action permit', 'set match "65001:100"', 'next', 'end', 'next', 'end'];
const EXPANDED_LIST = ['config router community-list', 'edit "re100"', 'set type expanded', 'config rule', 'edit 1', 'set action permit', 'set regexp "^65001:1"', 'next', 'end', 'next', 'end'];
const MAP_IN = (list: string) => ['config router route-map', 'edit "wanted"', 'config rule', 'edit 1', `set match-community "${list}"`, 'next', 'end', 'next', 'end'];

describe('communautes BGP', () => {
  it('TEMOIN : sans route-map B recoit les deux reseaux', async () => {
    const { b } = await pair('tagA', [], [], []);
    expect(learnedBy(b).sort()).toEqual(['172.16.0.0', '172.17.0.0']);
  });

  it('set-community en sortie puis match-community en entree (liste standard)', async () => {
    const { b } = await pair('tagA', ['set route-map-out "tagA"'], [...COMMUNITY_LIST, ...MAP_IN('has100')], ['set route-map-in "wanted"']);
    expect(learnedBy(b)).toEqual(['172.16.0.0']);
  });

  it('une liste etendue (expression reguliere) correspond aussi', async () => {
    const { b } = await pair('tagA', ['set route-map-out "tagA"'], [...EXPANDED_LIST, ...MAP_IN('re100')], ['set route-map-in "wanted"']);
    expect(learnedBy(b)).toEqual(['172.16.0.0']);
  });

  it('no-export retient la route a la frontiere de l AS', async () => {
    const { b } = await pair('noexp', ['set route-map-out "noexp"'], [], []);
    expect(learnedBy(b)).toEqual(['172.16.0.0']);
  });

  it('une community-list inconnue est refusee dans une regle', async () => {
    const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    await type(firewall, ['config router route-map', 'edit "x"', 'config rule', 'edit 1']);
    const reply = await firewall.executeCommand('set match-community "ghost"');
    await type(firewall, ['next', 'end', 'next', 'end']);
    expect(reply).toMatch(/entry not found|not found|parse error/i);
  });
});
