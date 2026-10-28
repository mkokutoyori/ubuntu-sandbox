/*
 * `?` and Tab can never disagree about the candidates of a place.
 *
 * The defect this closes: `clock timezone C` completed to CAT / CET / CST on
 * Tab while `?` answered nothing, because the two triggers read their
 * candidates from two different places in the engine. Candidates now come
 * from one declaration (`argumentSuggestions` / `argumentCompletableValues`
 * both read `tabSuggestions`), and this guard states the invariant: every
 * argument candidate Tab can complete is also listed by `?` for the same
 * input — on a synthetic table covering every way a place declares
 * candidates, and on EVERY place of the real Cisco router and switch tables
 * that sits behind plain keywords.
 *
 * Discriminated against the engine as it was before the fix: 5 of the 12
 * cases fall (the `?`-lists-Tab-candidates check, the tabonly and mixed
 * synthetic places, and the sweep of both real tables); the other 7 are
 * witnesses or places that never had the defect.
 */
import { describe, it, expect } from 'vitest';
import { CommandTable, type CommandSpec } from '@/cli/CommandTable';
import { newSession } from '@/cli/CliSession';
import { isArgumentSpec, type ArgumentSpec } from '@/cli/ArgumentTypes';
import { complete } from '@/cli/CompletionEngine';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

const run = () => '';

function argumentValues(
  table: CommandTable, line: string, mode: string, trigger: 'TAB' | 'QUESTION_MARK',
): string[] {
  const session = newSession('R1', {}, { privilegeLevel: 15, initialMode: mode });
  return complete(table, line, session, trigger).suggestions
    .filter((s) => s.isArgument && (trigger === 'QUESTION_MARK' || s.completable === true))
    .map((s) => s.value);
}

function prefixesOf(word: string): string[] {
  return Array.from({ length: word.length + 1 }, (_, n) => word.slice(0, n));
}

function assertAgreement(
  table: CommandTable, head: string, mode: string, candidates: readonly string[],
): void {
  for (const candidate of candidates) {
    for (const prefix of prefixesOf(candidate)) {
      const line = `${head}${prefix}`;
      const tab = argumentValues(table, line, mode, 'TAB');
      const help = argumentValues(table, line, mode, 'QUESTION_MARK');
      for (const value of tab) expect(help, `${line} → Tab offers ${value}`).toContain(value);
    }
  }
}

describe('help and Tab agree on a synthetic table', () => {
  const table = new CommandTable();
  const place = (extra: Partial<ArgumentSpec>): ArgumentSpec => ({
    name: 'x', type: 'WORD', description: 'a place', ...extra,
  });
  const declare = (id: string, extra: Partial<ArgumentSpec>): void => {
    table.declare({
      id, path: [id, place(extra)], description: id, modes: ['config'], minPrivilege: 15, run,
    } as CommandSpec);
  };
  declare('tabonly', { tabSuggestions: ['CET', 'CEST', 'PST'] });
  declare('forms', { alternatives: [{ keyword: 'infinity', description: 'never' }] });
  declare('values', { type: 'ENUM', values: [{ keyword: 'alerts', description: 'severity 1' }] });
  declare('mixed', {
    tabSuggestions: ['BST'], alternatives: [{ keyword: 'infinity', description: 'never' }],
  });

  it('witness: Tab offers the tab suggestions', () => {
    expect(argumentValues(table, 'tabonly C', 'config', 'TAB')).toEqual(['CEST', 'CET']);
  });

  it('`?` lists the candidates Tab completes', () => {
    expect(argumentValues(table, 'tabonly C', 'config', 'QUESTION_MARK'))
      .toEqual(expect.arrayContaining(['CEST', 'CET']));
  });

  for (const [id, candidates] of [
    ['tabonly', ['CET', 'CEST', 'PST']], ['forms', ['infinity']],
    ['values', ['alerts']], ['mixed', ['BST', 'infinity']],
  ] as const) {
    it(`${id}: every Tab candidate is listed by ?`, () => {
      assertAgreement(table, `${id} `, 'config', candidates);
    });
  }
});

function placesBehindKeywords(table: CommandTable): Array<{ head: string; mode: string; place: ArgumentSpec }> {
  const found: Array<{ head: string; mode: string; place: ArgumentSpec }> = [];
  for (const spec of table.specs()) {
    const words: string[] = [];
    for (const step of spec.path) {
      if (typeof step === 'string') { words.push(step); continue; }
      if (isArgumentSpec(step)
        && (step.tabSuggestions || step.alternatives || step.values)) {
        found.push({ head: `${words.join(' ')} `, mode: spec.modes[0], place: step });
      }
      break;
    }
  }
  return found;
}

describe.each([
  ['router', () => new CiscoRouter('R1', 0, 0)],
  ['switch', () => new CiscoSwitch('SW1', 0, 0)],
])('help and Tab agree on every place of the real %s table', (_name, make) => {
  const device = make() as unknown as { getShell(): { socleTable(): CommandTable | null } };
  const table = device.getShell().socleTable();

  it('the table is reachable and exposes declared places', () => {
    expect(table).not.toBeNull();
    expect(placesBehindKeywords(table as CommandTable).length).toBeGreaterThan(20);
  });

  it('witness: the time zone place is among them', () => {
    const places = placesBehindKeywords(table as CommandTable);
    expect(places.some((p) => p.head === 'clock timezone ' && p.place.tabSuggestions)).toBe(true);
  });

  it('no declared place lets Tab offer what ? hides', () => {
    for (const { head, mode, place } of placesBehindKeywords(table as CommandTable)) {
      const words = [
        ...(place.tabSuggestions ?? []),
        ...(place.alternatives ?? []).map((a) => a.keyword),
        ...(place.values ?? []).map((v) => v.keyword),
      ].filter((w) => /^[A-Za-z0-9][A-Za-z0-9:._+-]*$/.test(w)).slice(0, 6);
      assertAgreement(table as CommandTable, head, mode, words);
    }
  });
});
