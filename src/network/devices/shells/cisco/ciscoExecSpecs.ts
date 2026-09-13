import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import { CliInvalidInput } from '../cli/CliDiagnostic';

export type SendTarget = 'all' | number;

export interface CiscoExecHost {
  privilegeLevel(): number;
  descendToPrivilege(level: number): void;
  cancelReload(): string;
  scheduleReloadIn(minutes: number): string;
  scheduleReloadAt(time: string): string;
  reloadNow(): string;
}

const PRIVILEGE_LEVEL: ArgumentSpec = {
  name: 'level', type: 'INT', optional: true, range: [0, 15],
  description: 'Privilege level to go to',
};

const RELOAD_DELAY: ArgumentSpec = {
  name: 'delay', type: 'INT', literal: 'mmm',
  description: 'Delay before reload in minutes',
};

const RELOAD_TIME: ArgumentSpec = {
  name: 'time', type: 'TIME',
  description: 'Time to reload',
};

const RELOAD_REASON: ArgumentSpec = {
  name: 'reason', type: 'REST', optional: true, literal: 'LINE',
  description: 'Reload reason',
};

const LINE_NUMBER: ArgumentSpec = {
  name: 'line', type: 'INT', description: 'Line number',
};

const NAMED_LINES: ReadonlyArray<readonly [string, string]> = [
  ['aux', 'Auxiliary line'],
  ['console', 'Primary terminal line'],
  ['tty', 'Terminal controller'],
  ['vty', 'Virtual terminal'],
];

export function sendTargetOf(
  path: readonly string[],
): SendTarget | 'incomplete' | null {
  const head = path[1]?.toLowerCase();
  if (head === undefined) return 'incomplete';
  if (head === '*') return path.length === 2 ? 'all' : null;
  if (NAMED_LINES.some(([keyword]) => keyword === head)) {
    if (path.length < 3) return 'incomplete';
    const named = Number.parseInt(path[2], 10);
    if (!Number.isInteger(named) || named < 0 || path.length > 3) return null;
    return head === 'console' ? 0 : named;
  }
  const number = Number.parseInt(head, 10);
  if (!Number.isInteger(number) || number < 0 || path.length > 2) return null;
  return number;
}

export function ciscoExecSpecs(ctx: () => CiscoExecHost): CommandSpec[] {
  const specs: CommandSpec[] = [
    {
      id: 'disable',
      path: ['disable', PRIVILEGE_LEVEL],
      description: 'Turn off privileged commands',
      modes: ['user', 'privileged'], minPrivilege: 1,
      run: (_session, args) => {
        const target = args.level === undefined ? 1 : Number.parseInt(args.level, 10);
        if (target > ctx().privilegeLevel()) throw new CliInvalidInput({ token: args.level });
        ctx().descendToPrivilege(target);
        return '';
      },
    },
    {
      id: 'reload',
      path: ['reload', RELOAD_REASON],
      description: 'Halt and perform a cold restart',
      modes: ['privileged'], minPrivilege: 15,
      run: () => ctx().reloadNow(),
    },
    {
      id: 'reload-cancel',
      path: ['reload', 'cancel'],
      description: 'Cancel pending reload',
      modes: ['privileged'], minPrivilege: 15,
      run: () => ctx().cancelReload(),
    },
    {
      id: 'reload-in',
      path: ['reload', 'in', RELOAD_DELAY],
      description: 'Reload after a time interval',
      modes: ['privileged'], minPrivilege: 15,
      run: (_session, args) => ctx().scheduleReloadIn(Number.parseInt(args.delay, 10)),
    },
    {
      id: 'reload-at',
      path: ['reload', 'at', RELOAD_TIME],
      description: 'Reload at a specific time/date',
      modes: ['privileged'], minPrivilege: 15,
      run: (_session, args) => ctx().scheduleReloadAt(args.time),
    },
    {
      id: 'send-all',
      path: ['send', '*'],
      description: 'All tty lines',
      modes: ['privileged'], minPrivilege: 15,
      run: () => '',
    },
    {
      id: 'send-line',
      path: ['send', LINE_NUMBER],
      description: 'Send a message to a specific line',
      modes: ['privileged'], minPrivilege: 15,
      run: () => '',
    },
  ];

  for (const [keyword, description] of NAMED_LINES) {
    specs.push({
      id: `send-${keyword}`,
      path: ['send', keyword, LINE_NUMBER],
      description,
      modes: ['privileged'], minPrivilege: 15,
      run: () => '',
    });
  }

  return specs;
}
