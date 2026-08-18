import type { CommandSpec } from '../../CommandTable';
import { TUNNEL_PATHS } from '../tunnel/tunnelFamily';
import { CLEAR_CRYPTO_PATHS } from '../clear/clearCrypto';
import { SHOW_CRYPTO_FAMILY } from './showCrypto';

export interface ShowConfigHost {
  versionText(): string;
  runningConfigText(): string;
  runningConfigAllText(): string;
  runningConfigInterfaceText(argument: string): string;
  startupConfigText(): string;
}

const EXEC = Object.freeze(['user', 'privileged']);

export function showConfigViewSpecs(host: () => ShowConfigHost): CommandSpec[] {
  return [
    {
      id: 'show-version',
      path: ['show', 'version'],
      description: 'System hardware and software status',
      modes: EXEC,
      minPrivilege: 1,
      run: () => host().versionText(),
    },
    {
      id: 'show-running-config',
      path: ['show', 'running-config'],
      description: 'Current operating configuration',
      modes: EXEC,
      minPrivilege: 15,
      run: () => host().runningConfigText(),
    },
    {
      id: 'show-running-config-all',
      path: ['show', 'running-config', 'all'],
      description: 'Configuration with all defaults shown',
      modes: EXEC,
      minPrivilege: 15,
      run: () => host().runningConfigAllText(),
    },
    {
      id: 'show-running-config-interface',
      path: ['show', 'running-config', 'interface',
        { name: 'interface', type: 'REST' as const, description: 'Interface name' }],
      description: 'Configuration of one interface',
      modes: EXEC,
      minPrivilege: 15,
      run: (_session, args) => host().runningConfigInterfaceText(String(args.interface ?? '')),
    },
    {
      id: 'show-startup-config',
      path: ['show', 'startup-config'],
      description: 'Contents of startup configuration',
      modes: EXEC,
      minPrivilege: 15,
      run: () => host().startupConfigText(),
    },
    {
      id: 'show-configuration',
      path: ['show', 'configuration'],
      description: 'Contents of startup configuration',
      modes: EXEC,
      minPrivilege: 15,
      run: () => host().startupConfigText(),
    },
  ];
}

export function pathTextOf(spec: CommandSpec): string {
  return spec.path.filter((step): step is string => typeof step === 'string').join(' ');
}

export const SHOW_SLICE_PATHS: readonly string[] = Object.freeze([
  'show version',
  'show running-config',
  'show running-config all',
  'show running-config interface',
  'show startup-config',
  'show configuration',
]);

export const MIGRATION_LEDGER: readonly string[] = Object.freeze([
  ...TUNNEL_PATHS,
  ...CLEAR_CRYPTO_PATHS,
  ...SHOW_CRYPTO_FAMILY.map(pathTextOf),
  ...SHOW_SLICE_PATHS,
]);
