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

export function lineSettingsFamily(host: () => LineSettingsHost): CommandSpec[] {
  const base = { modes: MODES, minPrivilege: 15 };
  return [
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
