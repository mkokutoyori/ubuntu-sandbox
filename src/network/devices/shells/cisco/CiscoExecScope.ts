import type { CommandTrie } from '../CommandTrie';

export type ExecScope = 'user' | 'privileged';

export const PRIVILEGED_ONLY_SHOW_CHILDREN: ReadonlySet<string> = new Set([
  'running-config', 'startup-config', 'tech-support', 'archive',
  'debugging', 'debug',
  'logging', 'snmp', 'parser', 'ssh', 'platform', 'diag', 'license',
]);

export const PRIVILEGED_ONLY_PATHS: readonly string[] = [];

export const PRIVILEGED_EXEC_ONLY: ReadonlySet<string> = new Set([
  'show logging',
  'show logging last',
  'show logging count',
  'show logging history',
  'show logging persistent',
  'clear logging persistent',
  'show snmp',
  'show snmp community',
  'show snmp host',
  'show snmp group',
  'show snmp user',
  'show snmp view',
  'show snmp engineID',
  'show parser view',
  'show platform',
  'show diag',
  'show license',
  'show license feature',
  'show license udi',
  'clear ntp statistics',
]);

export interface ScopedTrie {
  register(path: string, description: string, action: Parameters<CommandTrie['register']>[2]): void;
  registerGreedy(
    path: string,
    description: string,
    action: Parameters<CommandTrie['registerGreedy']>[2],
    keywords?: Parameters<CommandTrie['registerGreedy']>[3],
  ): void;
  describeNode(path: string, description: string): void;
}

export function scopedTrie(target: CommandTrie, scope: ExecScope): ScopedTrie {
  const hidden = (path: string): boolean =>
    scope === 'user' && PRIVILEGED_EXEC_ONLY.has(path);
  return {
    register(path, description, action) {
      if (hidden(path)) return;
      target.register(path, description, action);
    },
    registerGreedy(path, description, action, keywords) {
      if (hidden(path)) return;
      target.registerGreedy(path, description, action, keywords);
    },
    describeNode(path, description) {
      if (hidden(path)) return;
      target.describeNode(path, description);
    },
  };
}
