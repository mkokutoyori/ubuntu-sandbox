import type { ArgumentSpec } from '../../ArgumentTypes';
import type { CommandSpec } from '../../CommandTable';

export interface LineSettingsHost {
  guard(keyword: string): void;
  setExecTimeout(minutes: number, seconds: number): void;
  clearExecTimeout(): void;
  setLoginTimeout(seconds: number): void;
  clearLoginTimeout(): void;
  setAccessClass(list: string, direction: 'in' | 'out'): void;
  clearAccessClass(direction: 'in' | 'out' | null): void;
  setLoggingSynchronous(on: boolean): void;
  patch(fields: Record<string, unknown>): void;
  unset(names: readonly string[]): void;
  setHistorySize(size: number): void;
  disableHistory(): void;
  setPrivilege(level: number): void;
  clearPrivilege(): void;
}

const MODES = ['config-line'];

const MINUTES: ArgumentSpec = {
  name: 'minutes', type: 'INT', range: [0, 35791], description: 'Timeout in minutes',
};

const SECONDS: ArgumentSpec = {
  name: 'seconds', type: 'INT', range: [0, 2147483], optional: true,
  description: 'Timeout in seconds',
};

const LOGIN_SECONDS: ArgumentSpec = {
  name: 'seconds', type: 'INT', range: [1, 300], description: 'Timeout in seconds',
};

const ACCESS_LIST: ArgumentSpec = {
  name: 'access-list', type: 'WORD', description: 'Access-list name',
  alternatives: [
    { keyword: '<1-199>', description: 'IP access list (standard or extended)' },
    { keyword: 'WORD', description: 'Access-list name' },
  ],
};

const DIRECTION: ArgumentSpec = {
  name: 'direction', type: 'ENUM', description: 'Filter direction',
  values: [
    { keyword: 'in', description: 'Inbound packets' },
    { keyword: 'out', description: 'Outbound packets' },
  ],
};

const ESCAPE_WORDS = ['break', 'default', 'none', 'soft'];

function minutesFor(name: string, description: string): ArgumentSpec {
  return { name, type: 'INT', range: [0, 35791], description };
}

function numbered(
  name: string, range: readonly [number, number], description: string,
): ArgumentSpec {
  return { name, type: 'INT', range: [range[0], range[1]], description };
}

const ESCAPE: ArgumentSpec = {
  name: 'character', type: 'INT', range: [0, 255],
  description: 'ASCII decimal value of the escape character',
  values: [
    { keyword: 'break', description: 'Use the BREAK signal as the escape character' },
    { keyword: 'default', description: 'Restore the default escape character' },
    { keyword: 'none', description: 'Disable the escape character' },
    { keyword: 'soft', description: 'Use a soft escape character' },
  ],
};

function undoOf(
  base: { modes: string[]; minPrivilege: number }, id: string, path: string[],
  description: string, undo: () => string,
): CommandSpec {
  return {
    ...base, id: `${id}-undo`, path, description, existsOnlyNegated: true,
    run: () => '% Incomplete command.', undo,
  };
}

export function lineSettingsFamily(host: () => LineSettingsHost): CommandSpec[] {
  const base = { modes: [...MODES], minPrivilege: 15 };
  const guarded = (keyword: string, body: () => void): string => {
    host().guard(keyword);
    body();
    return '';
  };
  const valued = (
    id: string, keyword: string, place: ArgumentSpec, description: string,
    field: string, clearing: { unset: string } | { patch: unknown },
  ): CommandSpec[] => {
    const clear = (): string => guarded(keyword, () => {
      if ('unset' in clearing) host().unset([clearing.unset]);
      else host().patch({ [field]: clearing.patch });
    });
    return [
      {
        ...base, id, path: [keyword, place], description,
        run: (_session, args) => guarded(keyword, () => host().patch({
          [field]: Number(args[place.name]),
        })),
        undo: clear,
      },
      undoOf(base, id, [keyword], description, clear),
    ];
  };
  return [
    ...valued('line-session-timeout', 'session-timeout',
      minutesFor('minutes', 'Timeout in minutes'), 'Set the interval for closing a connection when there is no input traffic',
      'sessionTimeoutMinutes', { unset: 'sessionTimeoutMinutes' }),
    ...valued('line-absolute-timeout', 'absolute-timeout',
      minutesFor('minutes', 'Absolute session lifetime in minutes'),
      'Set absolute timeout for line disconnection', 'absoluteTimeoutMinutes', { patch: 0 }),
    ...valued('line-rotary', 'rotary', numbered('group', [1, 100], 'Rotary group number'),
      'Add line to a rotary group', 'rotaryGroup', { unset: 'rotaryGroup' }),
    ...valued('line-length', 'length', numbered('lines', [0, 512], 'Number of lines on a screen'),
      'Set number of lines on a screen', 'terminalLength', { unset: 'terminalLength' }),
    ...valued('line-width', 'width',
      numbered('characters', [0, 512], 'Width of the display terminal'),
      'Set width of the display terminal', 'terminalWidth', { unset: 'terminalWidth' }),
    {
      ...base, id: 'line-autocommand', path: ['autocommand', {
        name: 'command', type: 'REST', description: 'Command to execute on connection',
      }],
      description: 'Automatically execute an EXEC command on connection',
      run: (_session, args) => guarded('autocommand', () => host().patch({
        autocommand: args.command.trim(),
      })),
      undo: () => guarded('autocommand', () => host().patch({ autocommand: '' })),
    },
    undoOf(base, 'line-autocommand', ['autocommand'],
      'Automatically execute an EXEC command on connection',
      () => guarded('autocommand', () => host().patch({ autocommand: '' }))),
    {
      ...base, id: 'line-escape-character', path: ['escape-character', ESCAPE],
      description: 'Change the current line\'s escape character',
      run: (_session, args) => guarded('escape-character', () => host().patch({
        escapeCharacter: ESCAPE_WORDS.includes(args.character.toLowerCase())
          ? args.character.toLowerCase() : String(Number(args.character)),
      })),
      undo: () => guarded('escape-character', () => host().patch({ escapeCharacter: 'default' })),
    },
    undoOf(base, 'line-escape-character', ['escape-character'],
      'Restore the default escape character',
      () => guarded('escape-character', () => host().patch({ escapeCharacter: 'default' }))),
    {
      ...base, id: 'line-history-size',
      path: ['history', 'size', numbered('size', [0, 256], 'Size of history buffer')],
      description: 'Set history buffer size',
      run: (_session, args) => guarded('history', () => host().setHistorySize(Number(args.size))),
    },
    {
      ...base, id: 'line-history', path: ['history'],
      description: 'Enable and control the command history function',
      existsOnlyNegated: true, run: () => '% Incomplete command.',
      undo: () => guarded('history', () => host().disableHistory()),
    },
    {
      ...base, id: 'line-privilege-level',
      path: ['privilege', 'level', numbered('level', [0, 15], 'Privilege level')],
      description: 'Set the privilege level of the line',
      run: (_session, args) => guarded('privilege', () => host().setPrivilege(Number(args.level))),
      undo: () => guarded('privilege', () => host().clearPrivilege()),
    },
    undoOf(base, 'line-privilege-level', ['privilege', 'level'],
      'Set the privilege level of the line',
      () => guarded('privilege', () => host().clearPrivilege())),
    {
      ...base, id: 'line-privilege', path: ['privilege'],
      description: 'Clear the privilege level', existsOnlyNegated: true,
      run: () => '% Incomplete command.',
      undo: () => guarded('privilege', () => host().clearPrivilege()),
    },
    {
      ...base, id: 'line-exec-timeout', path: ['exec-timeout', MINUTES, SECONDS],
      description: 'Set the EXEC timeout',
      run: (_session, args) => {
        host().guard('exec-timeout');
        host().setExecTimeout(Number(args.minutes), Number(args.seconds ?? 0));
        return '';
      },
      undo: () => { host().clearExecTimeout(); return ''; },
    },
    {
      ...base, id: 'line-exec-timeout-undo', path: ['exec-timeout'],
      description: 'Set the EXEC timeout', existsOnlyNegated: true,
      run: () => '% Incomplete command.',
      undo: () => { host().clearExecTimeout(); return ''; },
    },
    {
      ...base, id: 'line-login-timeout', path: ['login-timeout', LOGIN_SECONDS],
      description: 'Set the login timeout',
      run: (_session, args) => {
        host().guard('login-timeout');
        host().setLoginTimeout(Number(args.seconds));
        return '';
      },
      undo: () => { host().clearLoginTimeout(); return ''; },
    },
    {
      ...base, id: 'line-login-timeout-undo', path: ['login-timeout'],
      description: 'Set the login timeout', existsOnlyNegated: true,
      run: () => '% Incomplete command.',
      undo: () => { host().clearLoginTimeout(); return ''; },
    },
    {
      ...base, id: 'line-access-class', path: ['access-class', ACCESS_LIST, DIRECTION],
      description: 'Restrict access by access-class',
      run: (_session, args) => {
        host().guard('access-class');
        host().setAccessClass(args['access-list'], args.direction as 'in' | 'out');
        return '';
      },
      undo: (_session, args) => {
        host().guard('access-class');
        host().clearAccessClass(args.direction as 'in' | 'out');
        return '';
      },
    },
    {
      ...base, id: 'line-logging-synchronous', path: ['logging', 'synchronous'],
      description: 'Synchronize logging output with EXEC output',
      run: () => { host().guard('logging'); host().setLoggingSynchronous(true); return ''; },
      undo: () => { host().guard('logging'); host().setLoggingSynchronous(false); return ''; },
    },
  ];
}
