import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { packageRecords, type DpkgState } from '../../packages/PackageState';
import { packageHostOf } from './Apt';

const LIST_HEADER = [
  'Desired=Unknown/Install/Remove/Purge/Hold',
  '| Status=Not/Inst/Conf-files/Unpacked/halF-conf/Half-inst/trig-aWait/Trig-pend',
  '||/ Name                Version          Architecture Description',
  '+++-===================-================-============-================================',
];

const LIST_FLAGS: Readonly<Record<DpkgState, string>> = { installed: 'ii', 'config-files': 'rc' };

function globMatches(pattern: string, name: string): boolean {
  const rx = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return rx.test(name);
}

function runDpkg(ctx: LinuxCommandContext, args: string[]): { output: string; exitCode: number } {
  if (args[0] !== '-l' && args[0] !== '--list') {
    return { output: 'dpkg: need an action option\nUse dpkg --help for help.', exitCode: 1 };
  }
  const patterns = args.slice(1).filter((a) => !a.startsWith('-'));
  const kept = packageRecords(packageHostOf(ctx))
    .filter(({ entry }) => patterns.length === 0 || patterns.some((p) => globMatches(p, entry.name)));
  if (patterns.length > 0 && kept.length === 0) {
    return { output: patterns.map((p) => `dpkg-query: no packages found matching ${p}`).join('\n'), exitCode: 1 };
  }
  const lines = kept.map(({ entry, state }) =>
    `${LIST_FLAGS[state]}  ${entry.name.padEnd(19)} ${entry.version.padEnd(16)} ${entry.arch.padEnd(12)} ${entry.summary}`);
  return { output: [...LIST_HEADER, ...lines].join('\n'), exitCode: 0 };
}

export const dpkgCommand: LinuxCommand = {
  name: 'dpkg',
  needsNetworkContext: true,
  manSection: 1,
  usage: 'dpkg -l [package-name-pattern ...]',
  help: 'List the packages of this machine.',
  run: (ctx, args) => runDpkg(ctx, args).output,
  runWithStatusSync: (ctx, args) => runDpkg(ctx, args),
};
