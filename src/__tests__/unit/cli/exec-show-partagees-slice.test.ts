/**
 * Les vues d'EXEC PARTAGEES par les deux plateformes passent au socle.
 *
 * `registerCommonShowCommands` est appelee une fois par arbre d'EXEC et
 * sur les deux plateformes : quinze commandes y sont enregistrees
 * QUATRE fois au total. C'est la duplication la plus large que la
 * migration ait rencontree, et une declaration unique la retire.
 *
 * Deux d'entre elles sont GARDEES par le materiel — `show redundancy` et
 * `show mac address-table` ne sont enregistrees que derriere
 * `hasSwitchingHardware()` — donc le commutateur les a et le routeur
 * non. Le collecteur traverse la meme garde, donc la portee est
 * preservee par construction ; un cas l'epingle des deux cotes.
 *
 * Le releve est pris AVANT : les cas d'acceptation sont verts des deux
 * cotes, les cas d'aide sont ce que la migration apporte.
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

type Machine = { executeCommand(c: string): Promise<string>; cliHelp(i: string): string };

const PLATEFORMES: ReadonlyArray<[string, () => Machine]> = [
  ['routeur', () => new CiscoRouter('R1', 0, 0) as unknown as Machine],
  ['commutateur', () => new CiscoSwitch('switch-cisco', 'SW1') as unknown as Machine],
];

async function privilegie(fabrique: () => Machine): Promise<Machine> {
  const d = fabrique();
  await d.executeCommand('enable');
  return d;
}

const refuse = (sortie: string): boolean =>
  /Invalid input|Incomplete command|Unrecognized|Unknown command/.test(sortie);

const motsAides = (aide: string): string[] =>
  aide.split('\n').map(l => l.trim().split(/\s{2,}/)[0])
    .filter(m => m.length > 0 && !m.startsWith('%'));

/** Celles que les DEUX portees d'EXEC servent. */
const PARTAGEES = [
  'show interfaces counters errors',
  'show ntp packets',
  'show cdp',
  'show lldp',
  'show hosts',
  'show ip dns statistics',
  'show ip vrf',
  'show vrf',
  'show adjacency',
  'show aaa',
] as const;

/**
 * Celles que `scopedTrie` retire de l'EXEC utilisateur : elles figurent
 * dans `PRIVILEGED_EXEC_ONLY`, et la declaration doit porter cette
 * portee-la sous peine de les rendre lisibles avant `enable`.
 */
const PRIVILEGIEES = ['show snmp', 'show parser view'] as const;

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`${nom} — les vues partagees repondent`, () => {
    it.each(PARTAGEES)('`%s` n est pas refusee', async (commande) => {
      const out = await (await privilegie(fabrique)).executeCommand(commande);
      expect(refuse(out), out).toBe(false);
    });

    it.each(PARTAGEES)('`%s` repond AUSSI en EXEC utilisateur', async (commande) => {
      const out = await fabrique().executeCommand(commande);
      expect(/Invalid input|Unrecognized/.test(out), out).toBe(false);
    });

    it.each(PRIVILEGIEES)('`%s` repond en privilegie', async (commande) => {
      const out = await (await privilegie(fabrique)).executeCommand(commande);
      expect(refuse(out), out).toBe(false);
    });

    it.each(PRIVILEGIEES)('`%s` est ABSENTE de l EXEC utilisateur', async (commande) => {
      expect(await fabrique().executeCommand(commande)).toContain('Invalid input');
    });

    it('`show cdp neighbors` garde ses sous-commandes', async () => {
      const out = await (await privilegie(fabrique)).executeCommand('show cdp neighbors');
      expect(refuse(out), out).toBe(false);
    });

    it('`show lldp neighbors` aussi', async () => {
      const out = await (await privilegie(fabrique)).executeCommand('show lldp neighbors');
      expect(refuse(out), out).toBe(false);
    });

    it('`show parser view` seul rend la vue COURANTE', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('show parser view'))
        .toBe("Current view is 'root'");
    });

    it('`show parser view zorglub` est REFUSEE — seul `all` suit', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('show parser view zorglub'))
        .toContain('Invalid input');
    });

    it('`show ntp packets mode` seul est INCOMPLET', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('show ntp packets mode'))
        .toContain('Incomplete command');
    });

    it('`show ntp packets zorglub` est REFUSEE', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('show ntp packets zorglub'))
        .toContain('Invalid input');
    });

    it('`show ip vrf detail` et `interfaces` restent des sous-commandes', async () => {
      const d = await privilegie(fabrique);
      for (const c of ['show ip vrf detail', 'show ip vrf interfaces',
        'show vrf detail', 'show vrf interfaces']) {
        expect(refuse(await d.executeCommand(c)), c).toBe(false);
      }
    });

    it('`terminal length 0` est acceptee', async () => {
      const out = await (await privilegie(fabrique)).executeCommand('terminal length 0');
      expect(refuse(out), out).toBe(false);
    });

    it('`terminal` seul est INCOMPLET', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('terminal'))
        .toContain('Incomplete command');
    });
  });

  describe(`${nom} — ce que \`?\` annonce des vues partagees`, () => {
    it('`show cdp ?` annonce ses sous-commandes', async () => {
      const mots = motsAides((await privilegie(fabrique)).cliHelp('show cdp '));
      expect(mots).toContain('neighbors');
    });

    it('`show ip vrf ?` annonce `detail` et `interfaces`', async () => {
      const mots = motsAides((await privilegie(fabrique)).cliHelp('show ip vrf '));
      expect(mots).toContain('detail');
      expect(mots).toContain('interfaces');
    });

    it('`show snmp ?` annonce ses sous-vues', async () => {
      const mots = motsAides((await privilegie(fabrique)).cliHelp('show snmp '));
      expect(mots).toContain('community');
      expect(mots).toContain('<cr>');
    });

    it('`show hosts ?` ne prend rien', async () => {
      expect(motsAides((await privilegie(fabrique)).cliHelp('show hosts ')))
        .toEqual(['<cr>']);
    });

    it('`terminal ?` annonce ses reglages et rien de plus', async () => {
      const mots = motsAides((await privilegie(fabrique)).cliHelp('terminal '));
      expect(mots).toContain('length');
      expect(mots).toContain('width');
      expect(mots).not.toContain('<cr>');
    });
  });
}

describe('la garde du materiel est preservee', () => {
  it('`show redundancy` existe sur le commutateur et pas sur le routeur', async () => {
    const sw = await privilegie(PLATEFORMES[1][1]);
    expect(refuse(await sw.executeCommand('show redundancy'))).toBe(false);

    const r = await privilegie(PLATEFORMES[0][1]);
    expect(await r.executeCommand('show redundancy')).toContain('Invalid input');
  });
});
