/**
 * Un argument porte son DOMAINE, pas seulement sa forme.
 *
 * C'est le verrou qui empechait deux grosses familles de migrer, et la
 * mesure l'a dit plutot qu'une intuition : `ntp` a ete migre puis annule
 * parce que `ntp access-group ?` cessait de nommer ses quatre familles,
 * et `logging` a ete ecarte au cadrage pour la meme raison — ses
 * arguments portent des PLAGES (`logging buffered <4096-2147483647>`) et
 * des VALEURS ENUMEREES (les huit severites AVEC leur numero, ce que le
 * fichier de cette famille appelle son point d'ergonomie le plus
 * rentable). Le socle ne savait exprimer ni l'une ni l'autre.
 *
 * Sans la plage, un reglage borne se declare `INT` et son gestionnaire
 * refait le controle a la main : l'aide annonce alors `<0-4294967295>`,
 * un intervalle que la commande n'accepte pas, et la valeur hors plage
 * traverse toute l'analyse pour n'etre refusee qu'au fond. C'est le
 * critere range et jamais evalue que ce depot passe son temps a
 * refermer, retourne — ici le critere etait evalue, mais ailleurs que la
 * ou il est declare.
 */

import { describe, it, expect } from 'vitest';
import { CommandTable } from '@/cli/CommandTable';
import { newSession, type CliSession } from '@/cli/CliSession';
import { parseCommand } from '@/cli/CommandParser';
import { complete } from '@/cli/CompletionEngine';
import { argumentAccepts, argumentPlaceholder } from '@/cli/ArgumentTypes';

function session(): CliSession {
  return newSession('R1', {}, { initialMode: 'config', privilegeLevel: 15 });
}

const SEVERITIES = [
  { keyword: 'emergencies', description: 'System is unusable (severity=0)' },
  { keyword: 'errors', description: 'Error conditions (severity=3)' },
  { keyword: 'debugging', description: 'Debugging messages (severity=7)' },
];

function table(): CommandTable {
  const t = new CommandTable();
  t.declare({
    id: 'cdp-timer',
    path: ['cdp', 'timer', { name: 'seconds', type: 'INT', range: [5, 254] }],
    description: 'Advertisement period (sec)',
    modes: ['config'], minPrivilege: 15, run: (_s, a) => `timer=${a.seconds}`,
  });
  t.declare({
    id: 'logging-console',
    path: ['logging', 'console', { name: 'severity', type: 'ENUM', values: SEVERITIES }],
    description: 'Set console logging parameters',
    modes: ['config'], minPrivilege: 15, run: (_s, a) => `severity=${a.severity}`,
  });
  return t;
}

describe('une PLAGE est portee par la declaration', () => {
  it('une valeur dedans est acceptee', () => {
    const parsed = parseCommand(table(), 'cdp timer 30', session());

    expect(parsed.status).toBe('ok');
  });

  it('une valeur HORS plage est refusee par l\'analyse, pas par le gestionnaire', () => {
    const parsed = parseCommand(table(), 'cdp timer 3', session());

    expect(parsed.status).toBe('invalid');
  });

  it('les bornes elles-memes passent', () => {
    for (const value of ['5', '254']) {
      expect(parseCommand(table(), `cdp timer ${value}`, session()).status).toBe('ok');
    }
  });

  it('l\'aide annonce la VRAIE plage, pas celle du type', () => {
    const result = complete(table(), 'cdp timer ', session(), 'QUESTION_MARK');

    expect(result.suggestions.map(s => s.value)).toContain('<5-254>');
    expect(result.suggestions.map(s => s.value)).not.toContain('<0-4294967295>');
  });

  it('un INT sans plage garde l\'intervalle du type — le temoin', () => {
    expect(argumentPlaceholder({ name: 'n', type: 'INT' })).toBe('<0-4294967295>');
  });

  it('un mot qui n\'est pas un nombre reste refuse', () => {
    expect(argumentAccepts({ name: 'n', type: 'INT', range: [5, 254] }, 'zorglub')).toBe(false);
  });
});

describe('un argument ENUMERE decrit son domaine', () => {
  it('une valeur du domaine est acceptee', () => {
    const parsed = parseCommand(table(), 'logging console errors', session());

    expect(parsed.status).toBe('ok');
    if (parsed.status === 'ok') expect(parsed.args.severity).toBe('errors');
  });

  it('une valeur HORS domaine est refusee', () => {
    expect(parseCommand(table(), 'logging console zorglub', session()).status).toBe('invalid');
  });

  it('l\'aide liste les valeurs AVEC leur description', () => {
    const result = complete(table(), 'logging console ', session(), 'QUESTION_MARK');

    expect(result.suggestions.map(s => s.value))
      .toEqual(expect.arrayContaining(['emergencies', 'errors', 'debugging']));
    expect(result.suggestions.find(s => s.value === 'errors')?.description)
      .toContain('severity=3');
  });

  it('elle n\'annonce PAS un type muet a la place — c\'est tout l\'interet', () => {
    const result = complete(table(), 'logging console ', session(), 'QUESTION_MARK');

    expect(result.suggestions.map(s => s.value)).not.toContain('WORD');
  });

  it('un prefixe reduit la liste', () => {
    const result = complete(table(), 'logging console e', session(), 'QUESTION_MARK');

    expect(result.suggestions.map(s => s.value)).toEqual(['emergencies', 'errors']);
  });

  it('la casse ne decide pas de l\'acceptation', () => {
    expect(parseCommand(table(), 'logging console ERRORS', session()).status).toBe('ok');
  });
});

describe('une severite IOS s\'ecrit par NOM ou par NUMERO', () => {
  function severite(): CommandTable {
    const t = new CommandTable();
    t.declare({
      id: 'logging-trap',
      path: ['logging', 'trap', {
        name: 'severity', type: 'INT', range: [0, 7], values: SEVERITIES,
      }],
      description: 'Set syslog server logging level',
      modes: ['config'], minPrivilege: 15, run: (_s, a) => `trap=${a.severity}`,
    });
    return t;
  }

  it('le NOM est accepte', () => {
    expect(parseCommand(severite(), 'logging trap errors', session()).status).toBe('ok');
  });

  it('le NUMERO aussi — porter les deux veut dire l\'un ou l\'autre', () => {
    expect(parseCommand(severite(), 'logging trap 3', session()).status).toBe('ok');
  });

  it('un numero HORS plage reste refuse', () => {
    expect(parseCommand(severite(), 'logging trap 9', session()).status).toBe('invalid');
  });

  it('un nom inconnu reste refuse', () => {
    expect(parseCommand(severite(), 'logging trap zorglub', session()).status).toBe('invalid');
  });

  it('l\'aide annonce la plage ET les noms — c\'est ce qui dispense de la table', () => {
    const values = complete(severite(), 'logging trap ', session(), 'QUESTION_MARK')
      .suggestions.map(s => s.value);

    expect(values).toContain('<0-7>');
    expect(values).toContain('errors');
  });

  it('un ENUM SANS plage refuse toujours un nombre — le temoin', () => {
    expect(argumentAccepts(
      { name: 's', type: 'WORD', values: SEVERITIES }, '3')).toBe(false);
  });
});

describe('une place peut avoir plusieurs FORMES', () => {
  function accessGroup(): CommandTable {
    const t = new CommandTable();
    t.declare({
      id: 'ip-access-group',
      path: ['ip', 'access-group', {
        name: 'list', type: 'WORD',
        alternatives: [
          { keyword: '<1-199>', description: 'Access list number' },
          { keyword: '<1300-2699>', description: 'Access list number (expanded range)' },
          { keyword: 'WORD', description: 'Access-list name' },
        ],
      }],
      description: 'Specify access control for packets',
      modes: ['config-if'], minPrivilege: 15, run: (_s, a) => `list=${a.list}`,
    });
    return t;
  }

  function session2() {
    return newSession('R1', {}, { initialMode: 'config-if', privilegeLevel: 15 });
  }

  it('l\'aide rend les TROIS formes, chacune avec sa description', () => {
    const values = complete(accessGroup(), 'ip access-group ', session2(), 'QUESTION_MARK')
      .suggestions.map(s => s.value);

    expect(values).toEqual(expect.arrayContaining(['<1-199>', '<1300-2699>', 'WORD']));
  });

  it('c\'est la FORME qui decide, jamais l\'intitule', () => {
    expect(parseCommand(accessGroup(), 'ip access-group 101', session2()).status).toBe('ok');
    expect(parseCommand(accessGroup(), 'ip access-group BUREAU', session2()).status).toBe('ok');
  });

  it('un rendu LITTERAL remplace le placeholder du type', () => {
    expect(argumentPlaceholder({ name: 'heure', type: 'WORD', literal: 'hh:mm' })).toBe('hh:mm');
  });
});

describe('un mot-cle peut suivre un ARGUMENT', () => {
  function hote(): CommandTable {
    const t = new CommandTable();
    t.declare({
      id: 'logging-host',
      path: ['logging', 'host', { name: 'ip', type: 'IP_ADDR' }],
      description: 'Set syslog server IP address',
      modes: ['config'], minPrivilege: 15, run: (_s, a) => `host=${a.ip}`,
    });
    t.declare({
      id: 'logging-host-transport',
      path: ['logging', 'host', { name: 'ip', type: 'IP_ADDR' }, 'transport', {
        name: 'protocole', type: 'ENUM',
        values: [
          { keyword: 'tcp', description: 'TCP transport' },
          { keyword: 'udp', description: 'UDP transport' },
        ],
      }],
      description: 'Specify the transport protocol',
      modes: ['config'], minPrivilege: 15, run: (_s, a) => `${a.ip}/${a.protocole}`,
    });
    return t;
  }

  function config() {
    return newSession('R1', {}, { initialMode: 'config', privilegeLevel: 15 });
  }

  it('la forme courte s\'arrete a l\'argument', () => {
    const parsed = parseCommand(hote(), 'logging host 10.0.0.1', config());

    expect(parsed.status).toBe('ok');
    if (parsed.status === 'ok') expect(parsed.spec.run(config(), parsed.args)).toBe('host=10.0.0.1');
  });

  it('la forme longue traverse l\'argument pour atteindre le mot-cle', () => {
    const parsed = parseCommand(hote(), 'logging host 10.0.0.1 transport tcp', config());

    expect(parsed.status).toBe('ok');
    if (parsed.status === 'ok') expect(parsed.spec.run(config(), parsed.args)).toBe('10.0.0.1/tcp');
  });

  it('l\'aide APRES l\'argument annonce le mot-cle qui suit', () => {
    const values = complete(hote(), 'logging host 10.0.0.1 ', config(), 'QUESTION_MARK')
      .suggestions.map(s => s.value);

    expect(values).toContain('transport');
    expect(values).toContain('<cr>');
  });

  it('un transport inconnu reste refuse', () => {
    expect(parseCommand(hote(), 'logging host 10.0.0.1 transport sctp', config()).status)
      .toBe('invalid');
  });
});
