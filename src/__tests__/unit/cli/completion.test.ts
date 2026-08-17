/**
 * La completion — UN seul chemin pour TAB et pour `?`.
 *
 * Le depot en a deux aujourd'hui (`tabComplete` et `getCompletions`), qui
 * peuvent donc se contredire : un mot que TAB accepte et que `?` ne
 * decrit pas est exactement ce que le garde-fou
 * `cisco-help-every-keyword-described` passe son temps a rattraper. Ici les
 * deux declencheurs traversent `locateCursor()` puis `suggestionsAt()` ;
 * ce qui differe est ce qu'ils RENDENT, pas ce qu'ils trouvent.
 *
 * Trois faits d'IOS que ce fichier fixe :
 *   — `?` decrit, TAB complete : `?` liste `<cr>` et les types d'argument,
 *     TAB ne complete que sur un mot-cle unique ;
 *   — la completion ne propose QUE ce que la session peut atteindre —
 *     sinon `?` enseigne des commandes qui repondront `% Invalid input` ;
 *   — un noeud intermediaire herite de la description de ce qu'il ouvre,
 *     plutot que de paraitre sans explication.
 */

import { describe, it, expect } from 'vitest';
import { CommandTable } from '@/cli/CommandTable';
import { newSession, type CliSession } from '@/cli/CliSession';
import { complete, locateCursor } from '@/cli/CompletionEngine';

function session(over: { mode?: string; privilegeLevel?: number; device?: unknown } = {}): CliSession {
  const s = newSession('R1', over.device ?? {},
    { privilegeLevel: over.privilegeLevel ?? 15, initialMode: over.mode ?? 'privileged' });
  return s;
}

function table(): CommandTable {
  const t = new CommandTable();
  t.declare({
    id: 'show-version', path: ['show', 'version'],
    description: 'System hardware and software status',
    modes: ['user', 'privileged'], minPrivilege: 1,
    run: () => '',
  });
  t.declare({
    id: 'show-run', path: ['show', 'running-config'],
    description: 'Current operating configuration',
    modes: ['privileged'], minPrivilege: 15,
    run: () => '',
  });
  t.declare({
    id: 'show-ip-route', path: ['show', 'ip', 'route'],
    description: 'IP routing table',
    modes: ['privileged'], minPrivilege: 1,
    run: () => '',
  });
  t.declare({
    id: 'ping', path: ['ping', { name: 'target', type: 'IP_ADDR' }],
    description: 'Send echo messages',
    modes: ['privileged'], minPrivilege: 1,
    run: () => '',
  });
  return t;
}

describe('le curseur situe la frappe dans l\'arbre', () => {
  it('`show ` place le curseur SUR `show`', () => {
    const cursor = locateCursor(table(), 'show ', session());

    expect(cursor.node.keyword).toBe('show');
    expect(cursor.prefix).toBe('');
  });

  it('`show ver` laisse `ver` comme prefixe a completer', () => {
    const cursor = locateCursor(table(), 'show ver', session());

    expect(cursor.node.keyword).toBe('show');
    expect(cursor.prefix).toBe('ver');
  });

  it('il traverse un ARGUMENT deja tape', () => {
    const cursor = locateCursor(table(), 'ping 10.0.0.1 ', session());

    expect(cursor.resolved).toBe(true);
    expect(cursor.node.argument?.name).toBe('target');
  });

  it('un chemin qui ne mene nulle part n\'est pas resolu', () => {
    expect(locateCursor(table(), 'zorglub ', session()).resolved).toBe(false);
  });
});

describe('`?` decrit', () => {
  it('il liste les suites possibles avec leur description', () => {
    const result = complete(table(), 'show ', session(), 'QUESTION_MARK');

    expect(result.suggestions.map(s => s.value))
      .toEqual(['ip', 'running-config', 'version']);
  });

  it('chaque suite porte une description, jamais du vide', () => {
    const result = complete(table(), 'show ', session(), 'QUESTION_MARK');

    expect(result.suggestions.every(s => s.description.length > 0)).toBe(true);
  });

  it('un noeud intermediaire herite de la description de ce qu\'il ouvre', () => {
    const result = complete(table(), 'show ', session(), 'QUESTION_MARK');
    const ip = result.suggestions.find(s => s.value === 'ip');

    expect(ip?.description).toBe('IP routing table');
  });

  it('un noeud dont la suite est un ARGUMENT herite aussi sa description', () => {
    const t = new CommandTable();
    t.declare({
      id: 'tunnel-source', path: ['tunnel', 'source', { name: 'iface', type: 'INTERFACE' }],
      description: 'Source of tunnel packets',
      modes: ['privileged'], minPrivilege: 1, run: () => '',
    });

    const result = complete(t, 'tunnel ', session(), 'QUESTION_MARK');
    const source = result.suggestions.find(s => s.value === 'source');

    expect(source?.description).toBe('Source of tunnel packets');
  });

  it('il annonce le TYPE attendu quand la suite est un argument', () => {
    const result = complete(table(), 'ping ', session(), 'QUESTION_MARK');

    expect(result.suggestions.map(s => s.value)).toContain('A.B.C.D');
  });

  it('il annonce `<cr>` quand la commande est complete telle quelle', () => {
    const result = complete(table(), 'show version ', session(), 'QUESTION_MARK');

    expect(result.suggestions.map(s => s.value)).toContain('<cr>');
  });

  it('il ne l\'annonce PAS quand la commande est incomplete — le temoin', () => {
    const result = complete(table(), 'show ', session(), 'QUESTION_MARK');

    expect(result.suggestions.map(s => s.value)).not.toContain('<cr>');
  });

  it('un prefixe reduit la liste', () => {
    const result = complete(table(), 'show r', session(), 'QUESTION_MARK');

    expect(result.suggestions.map(s => s.value)).toEqual(['running-config']);
  });
});

describe('TAB complete', () => {
  it('un prefixe unique est complete', () => {
    const result = complete(table(), 'show ver', session(), 'TAB');

    expect(result.completion).toBe('version');
  });

  it('un prefixe ambigu ne complete RIEN — IOS reste muet', () => {
    const t = new CommandTable();
    t.declare({
      id: 'a', path: ['show', 'ip'], description: 'x',
      modes: ['privileged'], minPrivilege: 1, run: () => '',
    });
    t.declare({
      id: 'b', path: ['show', 'interfaces'], description: 'x',
      modes: ['privileged'], minPrivilege: 1, run: () => '',
    });

    expect(complete(t, 'show i', session(), 'TAB').completion).toBeUndefined();
  });

  it('TAB ne complete pas sur un ARGUMENT — il n\'y a rien a deviner', () => {
    const result = complete(table(), 'ping ', session(), 'TAB');

    expect(result.completion).toBeUndefined();
  });
});

describe('la completion ne montre que l\'ATTEIGNABLE', () => {
  it('un privilege faible ne voit pas `running-config`', () => {
    const result = complete(table(), 'show ', session({ privilegeLevel: 1 }), 'QUESTION_MARK');

    expect(result.suggestions.map(s => s.value)).not.toContain('running-config');
  });

  it('mais il voit ce qui lui est permis — le temoin', () => {
    const result = complete(table(), 'show ', session({ privilegeLevel: 1 }), 'QUESTION_MARK');

    expect(result.suggestions.map(s => s.value)).toContain('version');
  });

  it('un mode qui ne convient a rien ne propose rien', () => {
    const result = complete(
      table(), 'show ', session({ mode: 'config-line' }), 'QUESTION_MARK');

    expect(result.suggestions).toHaveLength(0);
  });

  it('`privilege exec level` deplace ce qui est visible', () => {
    const t = table();
    t.setPrivilegeOverride(['show', 'running-config'], 1);

    const result = complete(t, 'show ', session({ privilegeLevel: 1 }), 'QUESTION_MARK');

    expect(result.suggestions.map(s => s.value)).toContain('running-config');
  });
});
