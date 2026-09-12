import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';

export interface TerminalHost {
  applyTerminal(words: readonly string[]): string;
}

const EXEC = Object.freeze(['user', 'privileged']);

export const TERMINAL_LENGTH_RANGE: readonly [number, number] = [0, 512];
export const TERMINAL_WIDTH_RANGE: readonly [number, number] = [40, 512];
export const TERMINAL_HISTORY_RANGE: readonly [number, number] = [0, 256];

const LIGNES: ArgumentSpec = {
  name: 'lignes', type: 'INT', range: TERMINAL_LENGTH_RANGE,
  description: 'Number of lines on screen (0 for no pausing)',
};

const COLONNES: ArgumentSpec = {
  name: 'colonnes', type: 'INT', range: TERMINAL_WIDTH_RANGE,
  description: 'Number of characters on a screen line',
};

const ENTREES: ArgumentSpec = {
  name: 'entrees', type: 'INT', range: TERMINAL_HISTORY_RANGE,
  description: 'Size of history buffer',
};

const RESTE_EXEC: ArgumentSpec = {
  name: 'reste', type: 'REST', optional: true, literal: 'LINE',
  description: 'EXEC process characteristics',
};

const DEFAITS: ReadonlyArray<readonly [string, string]> = [
  ['history', 'Enable and control the command history function'],
  ['length', 'Set number of lines on a screen'],
  ['monitor', 'Copy debug output to the current terminal line'],
  ['width', 'Set width of the display terminal'],
];

export function terminalSpecs(ctx: () => TerminalHost): CommandSpec[] {
  const executer = (...mots: string[]) => ctx().applyTerminal(mots);

  return [
    {
      id: 'terminal-length',
      path: ['terminal', 'length', LIGNES],
      description: 'Set number of lines on a screen',
      modes: EXEC, minPrivilege: 1,
      run: (_session, args) => executer('length', args.lignes),
    },
    {
      id: 'terminal-width',
      path: ['terminal', 'width', COLONNES],
      description: 'Set width of the display terminal',
      modes: EXEC, minPrivilege: 1,
      run: (_session, args) => executer('width', args.colonnes),
    },
    {
      id: 'terminal-monitor',
      path: ['terminal', 'monitor'],
      description: 'Copy debug output to the current terminal line',
      modes: EXEC, minPrivilege: 1,
      run: () => executer('monitor'),
    },
    {
      id: 'terminal-history',
      path: ['terminal', 'history'],
      description: 'Enable and control the command history function',
      modes: EXEC, minPrivilege: 1,
      run: () => executer('history'),
    },
    {
      id: 'terminal-history-size',
      path: ['terminal', 'history', 'size', ENTREES],
      description: 'Set history buffer size',
      modes: EXEC, minPrivilege: 1,
      run: (_session, args) => executer('history', 'size', args.entrees),
    },
    /*
     * `terminal exec` est ACCEPTE et n'est pas ANNONCE. Un vrai IOS le
     * prend (`terminal exec prompt timestamp`), ce simulateur n'en fait
     * rien, et l'annoncer promettrait un effet qui n'existe pas.
     */
    {
      id: 'terminal-exec',
      path: ['terminal', 'exec', RESTE_EXEC],
      description: 'EXEC process characteristics',
      modes: EXEC, minPrivilege: 1,
      hidden: true,
      run: (_session, args) =>
        executer('exec', ...(args.reste ?? '').split(/\s+/).filter(Boolean)),
    },
    ...DEFAITS.map(([mot, description]): CommandSpec => ({
      id: `terminal-no-${mot}`,
      path: ['terminal', 'no', mot],
      description,
      modes: EXEC, minPrivilege: 1,
      run: () => executer('no', mot),
    })),
  ];
}
