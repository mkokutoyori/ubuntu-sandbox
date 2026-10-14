import { simulationNowMs } from '@/network/core/SystemClock';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import type { OptionSpec } from '@/cli/OptionBag';
import type { CiscoSecurityConfig } from '../../router/security/CiscoSecurityConfig';
import { DEFAULT_INTERCEPT_SETTINGS, type TcpInterceptSettings, type InterceptConnection } from '../../router/security/TcpIntercept';

export interface TcpInterceptHost {
  security(): CiscoSecurityConfig;
}

const CONFIG = Object.freeze(['config']);
const EXEC = Object.freeze(['user', 'privileged']);

const ACL_NUMBER: ArgumentSpec = {
  name: 'acl', type: 'INT', range: [100, 199], description: 'Extended access list number',
};

const SECONDS: ArgumentSpec = {
  name: 'seconds', type: 'INT', range: [1, 2147483], description: 'Time in seconds',
};

const COUNT: ArgumentSpec = {
  name: 'number', type: 'INT', range: [1, 2147483647], description: 'Number of connections',
};

const MODE: ArgumentSpec = {
  name: 'mode', type: 'ENUM',
  values: [
    { keyword: 'intercept', description: 'Intercept connections' },
    { keyword: 'watch', description: 'Watch connections' },
  ],
};

const DROP_MODE: ArgumentSpec = {
  name: 'drop', type: 'ENUM', optional: true,
  values: [
    { keyword: 'oldest', description: 'Drop the oldest partial connection' },
    { keyword: 'random', description: 'Drop a randomly selected partial connection' },
  ],
};

function thresholds(what: string): OptionSpec[] {
  return [
    { keyword: 'low', description: `${what} below which aggressive mode ends`, argument: { ...COUNT, name: 'low' } },
    { keyword: 'high', description: `${what} above which aggressive mode begins`, argument: { ...COUNT, name: 'high' } },
  ];
}

function clock(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function row(connection: InterceptConnection, now: number): string {
  const deadline = connection.finrstMs ?? connection.deadlineMs;
  return [
    `${connection.client}:${connection.clientPort}`.padEnd(24), `${connection.server}:${connection.serverPort}`.padEnd(24),
    connection.state.padEnd(10), clock(now - connection.createdMs).padEnd(10), clock(deadline - now).padEnd(10), connection.mode,
  ].join('').trimEnd();
}

export function renderInterceptConnections(sec: CiscoSecurityConfig): string {
  const now = simulationNowMs();
  const all = sec.tcpIntercept.list();
  const header = ['Client'.padEnd(24), 'Server'.padEnd(24), 'State'.padEnd(10), 'Create'.padEnd(10), 'Timeout'.padEnd(10), 'Mode'].join('');
  const incomplete = all.filter((c) => c.state !== 'ESTAB');
  const established = all.filter((c) => c.state === 'ESTAB');
  return ['Incomplete:', header, ...incomplete.map((c) => row(c, now)), '',
    'Established:', header, ...established.map((c) => row(c, now))].join('\n');
}

export function renderInterceptStatistics(sec: CiscoSecurityConfig): string {
  const settings = sec.tcpInterceptSettings;
  if (settings.list === null) return '';
  const stats = sec.tcpIntercept.statistics();
  return [
    `${settings.mode === 'intercept' ? 'intercepting' : 'monitoring'} new connections using access-list ${settings.list}`,
    `${stats.incomplete} incomplete, ${stats.established} established connections (total ${stats.incomplete + stats.established})`,
    `1 minute connection request rate ${stats.rate} requests/sec`,
  ].join('\n');
}

export function tcpInterceptSpecs(host: () => TcpInterceptHost): CommandSpec[] {
  const settings = (): TcpInterceptSettings => host().security().tcpInterceptSettings;
  const timeout = (
    id: string, word: string, key: 'connectionTimeoutSec' | 'finrstTimeoutSec' | 'watchTimeoutSec',
    description: string, undoDescription: string,
  ): CommandSpec => ({
    id, path: ['ip', 'tcp', 'intercept', word, SECONDS], description, undoDescription,
    modes: CONFIG, minPrivilege: 15,
    run: (_session, args) => { settings()[key] = Number(args.seconds); return ''; },
    undo: () => { settings()[key] = DEFAULT_INTERCEPT_SETTINGS[key]; return ''; },
    undoOmitsArguments: true,
  });
  const range = (
    id: string, word: string, lowKey: 'maxIncompleteLow' | 'oneMinuteLow', highKey: 'maxIncompleteHigh' | 'oneMinuteHigh',
    description: string, what: string,
  ): CommandSpec => ({
    id, path: ['ip', 'tcp', 'intercept', word], description,
    undoDescription: 'Restore the default thresholds',
    modes: CONFIG, minPrivilege: 15,
    options: thresholds(what),
    run: (_session, args) => {
      if (args.low === undefined && args.high === undefined) return '% Incomplete command.';
      if (args.low !== undefined) settings()[lowKey] = Number(args.low);
      if (args.high !== undefined) settings()[highKey] = Number(args.high);
      return '';
    },
    undo: (_session, args) => {
      const both = args.low === undefined && args.high === undefined;
      if (both || args.low !== undefined) settings()[lowKey] = DEFAULT_INTERCEPT_SETTINGS[lowKey];
      if (both || args.high !== undefined) settings()[highKey] = DEFAULT_INTERCEPT_SETTINGS[highKey];
      return '';
    },
  });
  return [
    {
      id: 'ip-tcp-intercept-list',
      path: ['ip', 'tcp', 'intercept', 'list', ACL_NUMBER],
      description: 'Enable TCP intercept for the connections an access list matches',
      undoDescription: 'Disable TCP intercept',
      modes: CONFIG, minPrivilege: 15,
      run: (_session, args) => { settings().list = Number(args.acl); return ''; },
      undo: () => { settings().list = null; return ''; },
      undoOmitsArguments: true,
    },
    {
      id: 'ip-tcp-intercept-mode',
      path: ['ip', 'tcp', 'intercept', 'mode', MODE],
      description: 'Change the TCP intercept mode',
      undoDescription: 'Restore the intercept mode',
      modes: CONFIG, minPrivilege: 15,
      run: (_session, args) => { settings().mode = args.mode as TcpInterceptSettings['mode']; return ''; },
      undo: () => { settings().mode = DEFAULT_INTERCEPT_SETTINGS.mode; return ''; },
      undoOmitsArguments: true,
    },
    {
      id: 'ip-tcp-intercept-drop-mode',
      path: ['ip', 'tcp', 'intercept', 'drop-mode', DROP_MODE],
      description: 'Set the strategy for dropping partial connections',
      undoDescription: 'Restore dropping the oldest partial connection',
      modes: CONFIG, minPrivilege: 15,
      run: (_session, args) => { settings().dropMode = (args.drop ?? 'oldest') as TcpInterceptSettings['dropMode']; return ''; },
      undo: () => { settings().dropMode = DEFAULT_INTERCEPT_SETTINGS.dropMode; return ''; },
    },
    timeout('ip-tcp-intercept-connection-timeout', 'connection-timeout', 'connectionTimeoutSec',
      'Change how long an idle connection is managed', 'Restore 86400 seconds'),
    timeout('ip-tcp-intercept-finrst-timeout', 'finrst-timeout', 'finrstTimeoutSec',
      'Change how long a connection is managed after a reset or FIN exchange', 'Restore 5 seconds'),
    timeout('ip-tcp-intercept-watch-timeout', 'watch-timeout', 'watchTimeoutSec',
      'Change how long a watched connection may stay incomplete', 'Restore 30 seconds'),
    range('ip-tcp-intercept-max-incomplete', 'max-incomplete', 'maxIncompleteLow', 'maxIncompleteHigh',
      'Set the incomplete connection thresholds of aggressive mode', 'Incomplete connections'),
    range('ip-tcp-intercept-one-minute', 'one-minute', 'oneMinuteLow', 'oneMinuteHigh',
      'Set the connection request thresholds of aggressive mode', 'Connection requests per minute'),
    {
      id: 'show-tcp-intercept-connections',
      path: ['show', 'tcp', 'intercept', 'connections'],
      description: 'Display TCP incomplete and established connections',
      modes: EXEC, minPrivilege: 1,
      run: () => renderInterceptConnections(host().security()),
    },
    {
      id: 'show-tcp-intercept-statistics',
      path: ['show', 'tcp', 'intercept', 'statistics'],
      description: 'Display TCP intercept statistics',
      modes: EXEC, minPrivilege: 1,
      run: () => renderInterceptStatistics(host().security()),
    },
  ];
}
