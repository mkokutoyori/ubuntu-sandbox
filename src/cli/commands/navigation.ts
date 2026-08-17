import type { CommandSpec } from '../CommandTable';

const CONFIG_MODES: readonly string[] = Object.freeze([
  'config', 'config-if', 'config-subif', 'config-line', 'config-view',
  'config-dhcp', 'config-router', 'config-router-af', 'config-vrf',
  'config-vlan', 'config-track', 'config-ipsla',
]);

export const EXIT: CommandSpec = {
  id: 'exit',
  path: ['exit'],
  description: 'Exit from the current mode',
  modes: ['user', 'privileged', ...CONFIG_MODES],
  minPrivilege: 1,
  run: (session) => { session.exitOneLevel(); return ''; },
};

export const END: CommandSpec = {
  id: 'end',
  path: ['end'],
  description: 'Exit from configuration mode',
  modes: CONFIG_MODES,
  minPrivilege: 1,
  run: (session) => { session.endToExec(); return ''; },
};

export const NAVIGATION_COMMANDS: readonly CommandSpec[] = Object.freeze([EXIT, END]);
