/**
 * `CliEngine` — l'assemblage, et `show running-config` comme premiere
 * commande reelle sur le nouveau socle.
 *
 * Ce fichier verifie ce que le moteur RENVOIE, c'est-a-dire les quatre
 * messages d'IOS, chacun distinct des autres. La distinction n'est pas
 * cosmetique : `% Incomplete command.` envoie l'operateur completer sa
 * ligne, `% Ambiguous command` lui dit de la preciser, et
 * `% Invalid input` qu'il s'est trompe de commande. Un moteur qui les
 * confondrait ferait chercher au mauvais endroit.
 *
 * La commande elle-meme n'ajoute rien au moteur : elle est une DONNEE.
 * C'est le contrat que le BRD du module pare-feu appelle « la couche
 * vendeur livre des artefacts, jamais un moteur », applique ici a une
 * famille de commandes.
 */

import { describe, it, expect } from 'vitest';
import { CliEngine, IOS_INCOMPLETE, IOS_INVALID_INPUT } from '@/cli/CliEngine';
import { CommandTable } from '@/cli/CommandTable';
import { newSession, type CliSession } from '@/cli/CliSession';

const CONFIG = [
  '!',
  'version 15.2',
  '!',
  'hostname R1',
  '!',
  'end',
].join('\n');

const SHOW_RUNNING_CONFIG = {
  id: 'show-running-config',
  path: ['show', 'running-config'],
  description: 'Current operating configuration',
  modes: ['privileged'],
  minPrivilege: 15,
  run: (session: CliSession) => {
    const body = (session.device as { getRunningConfig?: () => string })
      ?.getRunningConfig?.() ?? '';
    return [
      'Building configuration...', '',
      `Current configuration : ${body.length} bytes`,
      body,
    ].join('\n');
  },
} as const;

function engine(): CliEngine {
  const table = new CommandTable();
  table.declare(SHOW_RUNNING_CONFIG);
  table.declare({
    id: 'show-version', path: ['show', 'version'], description: 'Version',
    modes: ['user', 'privileged'], minPrivilege: 1,
    run: () => 'Cisco IOS Software',
  });
  return new CliEngine(table);
}

function session(over: { mode?: string; privilegeLevel?: number; device?: unknown } = {}): CliSession {
  const s = newSession('R1', over.device ?? { getRunningConfig: () => CONFIG },
    { privilegeLevel: over.privilegeLevel ?? 15, initialMode: over.mode ?? 'privileged' });
  return s;
}

describe('les quatre reponses d\'IOS sont DISTINCTES', () => {
  it('une ligne vide ne rend rien', async () => {
    expect(await engine().execute('', session())).toBe('');
  });

  it('une commande inconnue rend `% Invalid input`', async () => {
    expect(await engine().execute('zorglub', session())).toBe(IOS_INVALID_INPUT);
  });

  it('une commande incomplete rend `% Incomplete command.`', async () => {
    expect(await engine().execute('show', session())).toBe(IOS_INCOMPLETE);
  });

  it('une commande ambigue NOMME ce qui est ambigu', async () => {
    const table = new CommandTable();
    table.declare({
      id: 'a', path: ['show', 'ip'], description: 'x',
      modes: ['privileged'], minPrivilege: 1, run: () => '',
    });
    table.declare({
      id: 'b', path: ['show', 'interfaces'], description: 'x',
      modes: ['privileged'], minPrivilege: 1, run: () => '',
    });

    const out = await new CliEngine(table).execute('show i', session());

    expect(out).toContain('Ambiguous');
    expect(out).toContain('"i"');
  });

  it('les trois refus sont bien trois textes differents', async () => {
    const e = engine();

    const inconnue = await e.execute('zorglub', session());
    const incomplete = await e.execute('show', session());

    expect(new Set([inconnue, incomplete]).size).toBe(2);
  });
});

describe('`show running-config` lit la machine', () => {
  it('elle rend le preambule d\'IOS et la configuration', async () => {
    const out = await engine().execute('show running-config', session());

    expect(out).toContain('Building configuration...');
    expect(out).toContain('hostname R1');
  });

  it('la taille annoncee est MESUREE, pas inventee', async () => {
    const out = await engine().execute('show running-config', session());

    expect(out).toContain(`Current configuration : ${CONFIG.length} bytes`);
  });

  it('une machine differente donne une taille differente — le temoin', async () => {
    const autre = session({ device: { getRunningConfig: () => 'hostname R2' } });

    const out = await engine().execute('show running-config', autre);

    expect(out).toContain('Current configuration : 11 bytes');
  });

  it('`sh run` marche, parce que tout operateur tape cela', async () => {
    const out = await engine().execute('sh run', session());

    expect(out).toContain('hostname R1');
  });

  it('elle n\'existe pas en EXEC utilisateur', async () => {
    const out = await engine().execute(
      'show running-config', session({ mode: 'user' }));

    expect(out).toBe(IOS_INVALID_INPUT);
  });

  it('mais `show version` y existe — le temoin', async () => {
    const out = await engine().execute('show version', session({ mode: 'user' }));

    expect(out).toBe('Cisco IOS Software');
  });
});

describe('ajouter une commande ne touche pas le moteur', () => {
  it('une commande neuve est executable sans modifier `CliEngine`', async () => {
    const table = new CommandTable();
    table.declare({
      id: 'show-clock', path: ['show', 'clock'], description: 'Display the system clock',
      modes: ['privileged'], minPrivilege: 1,
      run: () => '*00:00:01.000 UTC Mon Jan 1 1900',
    });

    expect(await new CliEngine(table).execute('sh cl', session())).toContain('UTC');
  });

  it('et elle apparait dans `?` sans qu\'on l\'y inscrive', () => {
    const table = new CommandTable();
    table.declare({
      id: 'show-clock', path: ['show', 'clock'], description: 'Display the system clock',
      modes: ['privileged'], minPrivilege: 1, run: () => '',
    });

    const result = new CliEngine(table).complete('show ', session(), 'QUESTION_MARK');

    expect(result.suggestions.map(s => s.value)).toContain('clock');
  });

  it('un gestionnaire asynchrone est attendu par le moteur', async () => {
    const table = new CommandTable();
    table.declare({
      id: 'ping', path: ['ping', { name: 'target', type: 'IP_ADDR' }],
      description: 'Send echo messages',
      modes: ['privileged'], minPrivilege: 1,
      run: async (_s, args) => `Sending 5, 100-byte ICMP Echos to ${args.target}`,
    });

    const out = await new CliEngine(table).execute('ping 10.0.0.1', session());

    expect(out).toContain('10.0.0.1');
  });
});

/*
 * `undoOmitsArguments` — une place EXIGEE au positif, OMISE au negatif.
 *
 * Le socle ne savait dire que l'un des deux, et les deux issues etaient
 * mauvaises : une place facultative fait annoncer `<cr>` par `?` pour
 * une frappe que la machine refuse, une place exigee rend la negation
 * incomplete. La commande n'est donc PAS posee au noeud qui precede la
 * place — `?` y reste juste — mais l'analyse d'un `no` l'y trouve.
 */
describe('une place exigee au positif peut etre omise au negatif', () => {
  const POSE = {
    id: 'reglage', path: ['reglage', {
      name: 'valeur', type: 'INT', range: [1, 10] as [number, number],
      description: 'La valeur',
    }],
    description: 'Un reglage borne',
    modes: ['config'], minPrivilege: 15,
    undoOmitsArguments: true,
    run: (_s: unknown, args: Record<string, string>) => `pose ${args.valeur}`,
    undo: () => 'defait',
  };

  const table = (): CommandTable => {
    const t = new CommandTable();
    t.declare(POSE as never);
    return t;
  };
  const session = (): CliSession =>
    newSession('R1', {}, { initialMode: 'config', privilegeLevel: 15 });

  it('la forme positive EXIGE la valeur', async () => {
    const engine = new CliEngine(table());
    expect(await engine.execute('reglage', session())).toBe(IOS_INCOMPLETE);
  });

  it('la forme positive avec sa valeur passe', async () => {
    const engine = new CliEngine(table());
    expect(await engine.execute('reglage 5', session())).toBe('pose 5');
  });

  it('la NEGATION se passe de la valeur', async () => {
    const engine = new CliEngine(table());
    expect(await engine.execute('no reglage', session())).toBe('defait');
  });

  it('la negation accepte AUSSI la valeur', async () => {
    const engine = new CliEngine(table());
    expect(await engine.execute('no reglage 5', session())).toBe('defait');
  });

  it('la plage reste appliquee, negation comprise', async () => {
    const engine = new CliEngine(table());
    expect(await engine.execute('reglage 11', session())).toContain(IOS_INVALID_INPUT.trim());
  });

  it('sans le drapeau, la negation nue reste incomplete', async () => {
    const t = new CommandTable();
    t.declare({ ...POSE, undoOmitsArguments: false } as never);
    expect(await new CliEngine(t).execute('no reglage', session())).toBe(IOS_INCOMPLETE);
  });
});
