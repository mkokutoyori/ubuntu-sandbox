import { describe, it, expect } from 'vitest';
import { CommandTable, type CommandSpec } from '@/cli/CommandTable';
import { complete } from '@/cli/CompletionEngine';
import { parseCommand } from '@/cli/CommandParser';
import { newSession } from '@/cli/CliSession';
import { specsFromTrieRegistrations, type SpecCollector }
  from '@/cli/commands/trieAdapter';

function table(specs: readonly CommandSpec[]): CommandTable {
  const t = new CommandTable();
  for (const spec of specs) t.declare(spec);
  return t;
}

const session = () => newSession('R1', {}, {
  initialMode: 'privileged', privilegeLevel: 15,
});

const vue = (
  keyword: string, hidden: boolean,
): CommandSpec => ({
  id: `show-${keyword}`,
  path: ['show', keyword],
  description: `Display ${keyword}`,
  modes: ['privileged'],
  minPrivilege: 1,
  ...(hidden ? { hidden: true } : {}),
  run: () => keyword,
});

describe('une commande CACHEE s\'execute et ne se propose pas', () => {
  const t = table([vue('parity', true), vue('users', false)]);

  it('`?` ne l\'annonce pas', () => {
    const mots = complete(t, 'show ', session(), 'QUESTION_MARK')
      .suggestions.map(s => s.value);
    expect(mots).toContain('users');
    expect(mots).not.toContain('parity');
  });

  it('la tabulation ne l\'ecrit pas non plus', () => {
    expect(complete(t, 'show par', session(), 'TAB').completion).toBeUndefined();
  });

  it('mais la commande EXISTE et s\'analyse', () => {
    const parsed = parseCommand(t, 'show parity', session());
    expect(parsed.status).toBe('ok');
  });

  it('un noeud dont TOUTE la descendance est cachee disparait de l\'aide', () => {
    const cache = table([
      {
        id: 'line-parity', path: ['line', 'parity'], description: 'Parity',
        modes: ['privileged'], minPrivilege: 1, hidden: true, run: () => '',
      },
      vue('users', false),
    ]);
    const mots = complete(cache, '', session(), 'QUESTION_MARK')
      .suggestions.map(s => s.value);
    expect(mots).toContain('show');
    expect(mots).not.toContain('line');
  });
});

describe('l\'adaptateur porte les mecanismes du trie', () => {
  const registrations = (collector: SpecCollector): void => {
    collector.registerGreedy('line privilege', 'line privilege', (args) =>
      `privilege:${args.join(' ')}`);
    collector.registerGreedy('line motd-banner', 'line motd-banner', () => 'banner');
    collector.registerGreedy('line parity', 'line parity', (args) =>
      `parity:${args.join(' ')}`);
  };

  const specs = specsFromTrieRegistrations(registrations, {
    modes: ['privileged'], minPrivilege: 1,
    argumentFor: (path) => path === 'line motd-banner' ? null : undefined,
    hiddenFor: (path) => path === 'line parity',
    keywordsFor: (path) => path === 'line privilege'
      ? [{ keyword: 'level', description: 'Set exec level password' }]
      : undefined,
  });

  const t = table(specs);

  it('`argumentFor` rendant `null` ote la place d\'argument', () => {
    const aide = complete(t, 'line motd-banner ', session(), 'QUESTION_MARK')
      .suggestions.map(s => s.value);
    expect(aide).toEqual(['<cr>']);
  });

  it('`keywordsFor` declare la suite d\'un mot-cle glouton', () => {
    const aide = complete(t, 'line privilege ', session(), 'QUESTION_MARK')
      .suggestions.map(s => s.value);
    expect(aide).toContain('level');
  });

  it('la suite declaree atteint le gestionnaire avec son mot', () => {
    const parsed = parseCommand(t, 'line privilege level 15', session());
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    expect(parsed.spec.run(session(), parsed.args)).toBe('privilege:level 15');
  });

  it('`hiddenFor` cache la commande sans la supprimer', () => {
    const aide = complete(t, 'line ', session(), 'QUESTION_MARK')
      .suggestions.map(s => s.value);
    expect(aide).toContain('privilege');
    expect(aide).not.toContain('parity');

    const parsed = parseCommand(t, 'line parity even', session());
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    expect(parsed.spec.run(session(), parsed.args)).toBe('parity:even');
  });
});

describe('`reachableWhen` decrit ce que le CONTEXTE autorise', () => {
  let surVty = true;

  const specs = specsFromTrieRegistrations(
    (collector) => {
      collector.registerGreedy('line parity', 'line parity', (args) =>
        `parity:${args.join(' ')}`);
      collector.registerGreedy('line login', 'line login', () => 'login');
    },
    {
      modes: ['privileged'], minPrivilege: 1,
      reachableWhenFor: (path) =>
        path === 'line parity' ? () => !surVty : undefined,
    },
  );
  const t = table(specs);

  it('sur une vty, `parity` n\'est ni proposee ni executable', () => {
    surVty = true;
    const aide = complete(t, 'line ', session(), 'QUESTION_MARK')
      .suggestions.map(s => s.value);
    expect(aide).toContain('login');
    expect(aide).not.toContain('parity');
    expect(parseCommand(t, 'line parity even', session()).status).toBe('invalid');
  });

  it('sur une console, la MEME declaration la rend des deux cotes', () => {
    surVty = false;
    const aide = complete(t, 'line ', session(), 'QUESTION_MARK')
      .suggestions.map(s => s.value);
    expect(aide).toContain('parity');
    expect(parseCommand(t, 'line parity even', session()).status).toBe('ok');
  });
});
