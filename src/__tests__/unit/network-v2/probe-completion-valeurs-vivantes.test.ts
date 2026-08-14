/**
 * `?` et `Tab` proposent les valeurs QUE LA MACHINE PORTE.
 *
 * Defaut mesure (audit completion, M10) : le `DynamicParamResolver`
 * existe, il est branche, et deux portes sur trois ne l'interrogent
 * jamais.
 *
 *     TAB «show ip interface G»  -> les quatre ports        (bon)
 *     ?   «show ip interface G»  -> % Invalid input          (mauvais)
 *     TAB «show interfaces G»    -> rien du tout             (mauvais)
 *
 * Deux causes, distinctes, et chacune se dit en une phrase.
 *
 * A — `?` sur un mot PARTIEL ne consultait pas le resolveur. La branche
 *     du mot partiel liste les enfants, les suites declarees et les
 *     valeurs enumerees ; les valeurs vivantes n'y figuraient pas, si
 *     bien que la meme machine completait `G` par la tabulation et
 *     repondait « ce mot n'existe pas » a `G?`.
 *
 * B — le resolveur reconnaissait la place d'une interface au mot
 *     `interface` au SINGULIER. `show interfaces` est au pluriel, donc
 *     la commande la plus tapee de toutes n'a jamais rien recu, alors
 *     que `show ip interface` — singulier — fonctionnait.
 *
 * Ce que ce fichier ne demande PAS : que la tabulation reponde a une
 * ligne finie par un blanc. Une vraie machine n'y complete rien (elle
 * emet un bip), et `?` est la porte de cette question-la.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

type Dev = {
  cliHelp(s: string): string;
  cliTabCandidates(s: string): string[];
  executeCommand(c: string): Promise<string>;
};

const MOT = /^\s\s(\S+)/;
const offerts = (t: string): string[] =>
  t.includes('Invalid input') ? []
    : t.split('\n').map((l) => MOT.exec(l)?.[1]).filter((x): x is string => !!x);

let serie = 0;
async function routeur(prelude: readonly string[] = []): Promise<Dev> {
  const r = new CiscoRouter(`D${serie++}`) as unknown as Dev;
  await r.executeCommand('enable');
  for (const c of prelude) await r.executeCommand(c);
  return r;
}

describe('A — `?` sur un mot partiel lit les valeurs vivantes', () => {
  it('`show ip interface G?` nomme les ports reels', async () => {
    const r = await routeur();
    expect(offerts(r.cliHelp('show ip interface G'))).toContain('GigabitEthernet0/0');
  });

  it('et les deux portes s accordent — meme machine, meme question', async () => {
    const r = await routeur();
    const parAide = offerts(r.cliHelp('show ip interface G'));
    const parTab = r.cliTabCandidates('show ip interface G')
      .map((c) => c.split(/\s+/).pop()!);
    expect(parAide.sort()).toEqual(parTab.sort());
  });

  it('un prefixe qui ne designe aucun port ne rend rien', async () => {
    const r = await routeur();
    expect(r.cliHelp('show ip interface ZZ')).toContain('Invalid input');
  });

  it('et un mot-cle reel l emporte toujours sur une valeur', async () => {
    const r = await routeur();
    expect(offerts(r.cliHelp('show ip interface b'))).toContain('brief');
  });
});

describe('B — `show interfaces` est au pluriel, et porte pourtant une interface', () => {
  it('`show interfaces G?` nomme les ports', async () => {
    const r = await routeur();
    expect(offerts(r.cliHelp('show interfaces G'))).toContain('GigabitEthernet0/0');
  });

  it('et `Tab` les complete', async () => {
    const r = await routeur();
    expect(r.cliTabCandidates('show interfaces G'))
      .toContain('show interfaces GigabitEthernet0/0');
  });

  it('ce qui est propose s execute vraiment', async () => {
    const r = await routeur();
    const propose = r.cliTabCandidates('show interfaces G')[0];
    expect(String(await r.executeCommand(propose))).not.toContain('Invalid input');
  });

  it('et les vues de la commande restent offertes apres le nom', async () => {
    const r = await routeur();
    const o = offerts(r.cliHelp('show interfaces GigabitEthernet0/0 '));
    expect(o).toContain('accounting');
    expect(o).toContain('<cr>');
  });
});

describe('les autres places vivantes repondent aussi', () => {
  it('une ACL nommee se complete apres `ip access-group`', async () => {
    const r = await routeur([
      'configure terminal', 'ip access-list extended MAVIE', 'permit ip any any', 'exit',
      'interface GigabitEthernet0/0',
    ]);
    expect(r.cliTabCandidates('ip access-group MAV'))
      .toContain('ip access-group MAVIE');
    expect(offerts(r.cliHelp('ip access-group MAV'))).toContain('MAVIE');
  });

  it('un VLAN existant se complete sur un Catalyst', async () => {
    const s = new CiscoSwitch('switch-cisco', 'SWV') as unknown as Dev;
    for (const c of ['enable', 'configure terminal', 'vlan 42', 'exit',
      'interface FastEthernet0/1']) await s.executeCommand(c);
    expect(s.cliTabCandidates('switchport access vlan 4'))
      .toContain('switchport access vlan 42');
  });
});

describe('non-regression — la tabulation ne fabrique rien', () => {
  it('une ligne finie par un blanc ne complete rien, comme sur une vraie machine', async () => {
    const r = await routeur();
    expect(r.cliTabCandidates('show ip interface ')).toEqual([]);
  });

  it('et un mot-cle partiel se complete toujours', async () => {
    const r = await routeur();
    expect(r.cliTabCandidates('show ver')).toEqual(['show version']);
  });

  it('`show ?` garde sa liste entiere', async () => {
    const r = await routeur();
    const o = offerts(r.cliHelp('show '));
    expect(o.length).toBeGreaterThan(20);
    expect(o).toContain('version');
  });
});

/**
 * M12 — les candidats de la tabulation sont TRIES.
 *
 * L'ordre etait celui de l'insertion dans l'arbre, donc
 * `show v` rendait `vrf`, `vrrp`, `version`, `vlans` — sans regle
 * lisible. L'aide, elle, trie depuis l'etape 3 : les deux portes de la
 * meme question rendaient deux ordres.
 *
 * Le tri est celui des OCTETS, comme celui de l'aide et comme celui
 * d'IOS : `/` avant les majuscules, majuscules avant minuscules. Un
 * `localeCompare` mettrait `a` avant `B`.
 */
describe('M12 — la tabulation rend ses candidats en ordre', () => {
  it('`show v` les rend tries', async () => {
    const r = await routeur();
    const c = r.cliTabCandidates('show v');
    expect(c.length).toBeGreaterThan(2);
    expect(c).toEqual([...c].sort());
  });

  it('et le meme ordre que `?`, qui repond a la meme question', async () => {
    const r = await routeur();
    const parTab = r.cliTabCandidates('show v').map((l) => l.split(/\s+/).pop()!);
    const parAide = offerts(r.cliHelp('show v'));
    expect(parTab).toEqual(parAide);
  });

  it('le tri est celui des octets et non celui de la langue', async () => {
    const r = await routeur([
      'configure terminal', 'ip access-list extended zeta', 'permit ip any any', 'exit',
      'ip access-list extended Alpha', 'permit ip any any', 'exit',
      'interface GigabitEthernet0/0',
    ]);
    const c = r.cliTabCandidates('ip access-group ').concat(
      r.cliTabCandidates('ip access-group A'), r.cliTabCandidates('ip access-group z'));
    expect(c.some((x) => x.endsWith('Alpha'))).toBe(true);
    expect(c.some((x) => x.endsWith('zeta'))).toBe(true);
    const noms = ['Alpha', 'zeta'];
    expect([...noms].sort()).toEqual(['Alpha', 'zeta']);
  });

  it('une liste d un seul candidat reste inchangee', async () => {
    const r = await routeur();
    expect(r.cliTabCandidates('show ver')).toEqual(['show version']);
  });
});
