import type { CommandSpec } from '../../CommandTable';

export interface ShowSliceDevice {
  getRunningConfig?(): string;
  getStartupConfig?(): string;
  showVersionText?(): string;
  showIpRouteText?(): string;
  showInterfacesText?(): string;
}

function ask(device: unknown, method: keyof ShowSliceDevice): string {
  const source = device as ShowSliceDevice | null;
  const fn = source?.[method];
  return typeof fn === 'function' ? fn.call(source) : '';
}

export const SHOW_VERSION: CommandSpec = {
  id: 'show-version',
  path: ['show', 'version'],
  description: 'System hardware and software status',
  modes: ['user', 'privileged'],
  minPrivilege: 1,
  run: (session) => ask(session.device, 'showVersionText'),
};

export const SHOW_RUNNING_CONFIG: CommandSpec = {
  id: 'show-running-config',
  path: ['show', 'running-config'],
  description: 'Current operating configuration',
  modes: ['privileged'],
  minPrivilege: 15,
  run: (session) => {
    const body = ask(session.device, 'getRunningConfig');
    return [
      'Building configuration...', '',
      `Current configuration : ${body.length} bytes`,
      body,
    ].join('\n');
  },
};

export const SHOW_IP_ROUTE: CommandSpec = {
  id: 'show-ip-route',
  path: ['show', 'ip', 'route'],
  description: 'IP routing table',
  modes: ['user', 'privileged'],
  minPrivilege: 1,
  run: (session) => ask(session.device, 'showIpRouteText'),
};

export const SHOW_INTERFACES: CommandSpec = {
  id: 'show-interfaces',
  path: ['show', 'interfaces'],
  description: 'Interface status and configuration',
  modes: ['user', 'privileged'],
  minPrivilege: 1,
  run: (session) => ask(session.device, 'showInterfacesText'),
};

export const SHOW_SLICE: readonly CommandSpec[] = Object.freeze([
  SHOW_VERSION, SHOW_RUNNING_CONFIG, SHOW_IP_ROUTE, SHOW_INTERFACES,
]);

export function pathTextOf(spec: CommandSpec): string {
  return spec.path.filter((step): step is string => typeof step === 'string').join(' ');
}

export const SHOW_SLICE_PATHS: readonly string[] =
  Object.freeze(SHOW_SLICE.map(pathTextOf));

import { TUNNEL_PATHS } from '../tunnel/tunnelFamily';

export const MIGRATION_LEDGER: readonly string[] = Object.freeze([...TUNNEL_PATHS]);

export const MIGRATION_BLOCKER = 'whole-family-at-once';
