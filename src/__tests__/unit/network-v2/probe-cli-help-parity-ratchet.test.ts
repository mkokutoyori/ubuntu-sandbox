import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

type Machine = CiscoSwitch | CiscoRouter;

interface Device {
  cliCommandPaths(): string[];
  cliDerivedContinuations(): string[];
  cliExecutablePaths(): string[];
  cliUndescribedContinuations(): string[];
  cliHelp(input: string): string;
  cliTabCandidates(input: string): string[];
  executeCommand(cmd: string): Promise<string>;
}

const PROBES = 'abcdefghijklmnopqrstuvwxyz0123456789*'.split('');

/**
 * Les budgets sont les nombres MESURES, jamais un plafond confortable.
 *
 * Ils valaient 56/55/72/59 pour des listes qui en comptent 8/27/6/20 :
 * la campagne qui a fait descendre les continuations derivees n'avait
 * pas resserre le cliquet derriere elle, si bien qu'on pouvait en
 * reintroduire quarante-huit d'un coup sans qu'aucun test ne bronche.
 * Un cliquet a du jeu ne cliquete pas — c'est la regle que ce depot
 * s'est donnee pour ses trois autres garde-fous, dont chacun exige
 * l'egalite exacte, et celui-ci ne la suivait pas.
 *
 * Baisser un budget en meme temps qu'on migre une famille est le geste
 * attendu ; l'augmenter demande de dire pourquoi.
 */
const RECORDED_GAPS: Readonly<Record<string, {
  unsuggested: number; uncompletable: number; undescribed: number; derived: number;
}>> = {
  'switch/privileged': { unsuggested: 0, uncompletable: 0, undescribed: 0, derived: 0 },
  'switch/config': { unsuggested: 0, uncompletable: 0, undescribed: 0, derived: 27 },
  'routeur/privileged': { unsuggested: 0, uncompletable: 0, undescribed: 0, derived: 6 },
  'routeur/config': { unsuggested: 0, uncompletable: 0, undescribed: 0, derived: 20 },
};

const MODES: ReadonlyArray<{ name: string; enter: string[] }> = [
  { name: 'privileged', enter: ['enable'] },
  { name: 'config', enter: ['enable', 'configure terminal'] },
];

function isPlaceholder(word: string): boolean {
  return /[A-Z<]/.test(word)
    || /^[0-9]/.test(word)
    || (word.includes(':') && !word.endsWith(':'));
}

function suggestedAfter(d: Device, prefix: string): Set<string> {
  return new Set(
    d.cliHelp(prefix ? `${prefix} ` : '')
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((w) => w && w !== '<cr>' && !w.startsWith('%') && !isPlaceholder(w)),
  );
}

function completableAfter(d: Device, prefix: string): Set<string> {
  const found = new Set<string>();
  for (const probe of PROBES) {
    const typed = prefix ? `${prefix} ${probe}` : probe;
    for (const candidate of d.cliTabCandidates(typed)) {
      const word = candidate.slice(typed.length - probe.length).trim().split(/\s+/)[0];
      if (word) found.add(word);
    }
  }
  return found;
}

interface Survey {
  paths: number;
  unsuggested: string[];
  uncompletable: string[];
  undescribed: string[];
}

function survey(d: Device): Survey {
  const unsuggested: string[] = [];
  const uncompletable: string[] = [];

  for (const path of d.cliExecutablePaths()) {
    const words = path.split(' ');
    const parent = words.slice(0, -1).join(' ');
    const leaf = words[words.length - 1];
    if (!isPlaceholder(leaf) && !suggestedAfter(d, parent).has(leaf)) unsuggested.push(path);
  }

  for (const prefix of d.cliCommandPaths()) {
    const offered = suggestedAfter(d, prefix);
    if (offered.size === 0) continue;
    const completable = completableAfter(d, prefix);
    for (const word of offered) {
      if (!completable.has(word)) uncompletable.push(`${prefix ? `${prefix} ` : ''}${word}`);
    }
  }

  return {
    paths: d.cliCommandPaths().length,
    unsuggested,
    uncompletable,
    undescribed: d.cliUndescribedContinuations(),
  };
}

async function inMode(fabrique: () => Machine, enter: string[]): Promise<Device> {
  const d = fabrique();
  d.powerOn();
  for (const c of enter) await d.executeCommand(c);
  return d as unknown as Device;
}

const PLATEFORMES: Array<[string, () => Machine]> = [
  ['switch', () => new CiscoSwitch('SW1')],
  ['routeur', () => new CiscoRouter('R1', 0, 0)],
];

for (const [nom, fabrique] of PLATEFORMES) {
  for (const mode of MODES) {
    const cle = `${nom}/${mode.name}`;
    const budget = RECORDED_GAPS[cle];

    describe(`${cle} — parité \`?\` / Tab`, () => {
      it('l\'arbre parcouru est non vide', async () => {
        const r = survey(await inMode(fabrique, mode.enter));
        expect(r.paths).toBeGreaterThan(100);
      }, 120_000);

      it(`au plus ${budget.unsuggested} commande(s) exécutable(s) que \`?\` ne propose pas`, async () => {
        const { unsuggested } = survey(await inMode(fabrique, mode.enter));
        if (unsuggested.length > budget.unsuggested) {
          console.log(`[${cle}] non proposées (${unsuggested.length}) :\n  `
            + unsuggested.slice(0, 40).join('\n  '));
        }
        expect(unsuggested.length).toBeLessThanOrEqual(budget.unsuggested);
      }, 120_000);

      it(`au plus ${budget.uncompletable} mot(s) proposé(s) par \`?\` que Tab ne complète pas`, async () => {
        const { uncompletable } = survey(await inMode(fabrique, mode.enter));
        if (uncompletable.length > budget.uncompletable) {
          console.log(`[${cle}] non complétables (${uncompletable.length}) :\n  `
            + uncompletable.slice(0, 40).join('\n  '));
        }
        expect(uncompletable.length).toBeLessThanOrEqual(budget.uncompletable);
      }, 120_000);

      it(`au plus ${budget.derived} continuation(s) DÉRIVÉE(S) du texte source`, async () => {
        const d = await inMode(fabrique, mode.enter);
        const derives = d.cliDerivedContinuations();
        if (derives.length > budget.derived) {
          console.log(`[${cle}] dérivées (${derives.length}) :\n  `
            + derives.slice(0, 40).join('\n  '));
        }
        expect(derives.length).toBeLessThanOrEqual(budget.derived);
      }, 120_000);

      it(`au plus ${budget.undescribed} continuation(s) que Tab accepte et que \`?\` tait`, async () => {
        const { undescribed } = survey(await inMode(fabrique, mode.enter));
        if (undescribed.length > budget.undescribed) {
          console.log(`[${cle}] muettes (${undescribed.length}) :\n  `
            + undescribed.slice(0, 40).join('\n  '));
        }
        expect(undescribed.length).toBeLessThanOrEqual(budget.undescribed);
      }, 120_000);
    });
  }
}

describe('le cliquet mesure quelque chose', () => {
  it('un mot-clé sans description est compté, pas ignoré', async () => {
    const d = await inMode(() => new CiscoRouter('R9', 0, 0), ['enable', 'configure terminal']);
    const trie = (d as unknown as {
      cliUndescribedContinuations(): string[];
    });
    expect(trie.cliUndescribedContinuations()).toHaveLength(0);
    expect(survey(d).uncompletable).toHaveLength(0);
  }, 120_000);

  it('`?` et Tab traversent le même chemin sous une commande gloutonne', async () => {
    const d = await inMode(() => new CiscoRouter('R8', 0, 0), ['enable', 'configure terminal']);
    expect(d.cliHelp('router ')).toContain('ospf');
    expect(d.cliTabCandidates('router os')).toContain('router ospf');
  }, 120_000);

  it('un commutateur ne propose pas les commandes qu\'il refuse', async () => {
    const d = await inMode(() => new CiscoSwitch('SW9'), ['enable', 'configure terminal']);
    for (const absente of ['router', 'flow', 'zone', 'key']) {
      expect(d.cliHelp(`${absente} `)).toContain('% Invalid input');
      expect(await d.executeCommand(`${absente} x`)).toContain('% Invalid input');
    }
  }, 120_000);
});
