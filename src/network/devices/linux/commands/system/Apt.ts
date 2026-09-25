import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { findPackage, type PackageEntry } from '../../packages/PackageDatabase';
import { packageRecords, packageStateOf } from '../../packages/PackageState';
import { installPackage, removePackage, type PackageHost } from '../../packages/PackageInstaller';

const READING_LISTS = 'Reading package lists... Done';
const PREAMBLE = [READING_LISTS, 'Building dependency tree... Done', 'Reading state information... Done'];

interface AptResult { output: string; exitCode: number }

export function packageHostOf(ctx: LinuxCommandContext): PackageHost {
  const { vfs, serviceMgr, userMgr } = ctx.executor;
  return { vfs, serviceMgr, userMgr };
}

function summary(installed: number, removed: number): string {
  return `0 upgraded, ${installed} newly installed, ${removed} to remove and 0 not upgraded.`;
}

function debFileName(entry: PackageEntry): string {
  return `${entry.name}_${entry.version.replace(/:/g, '%3a')}_${entry.arch}.deb`;
}

function unknownPackages(names: readonly string[]): string[] {
  return names.filter((name) => !findPackage(name));
}

function install(host: PackageHost, names: readonly string[]): AptResult {
  const lines = [...PREAMBLE];
  const fresh: PackageEntry[] = [];
  for (const name of names) {
    const entry = findPackage(name)!;
    if (packageStateOf(host, name) === 'installed') {
      lines.push(`${name} is already the newest version (${entry.version}).`);
    } else if (!fresh.includes(entry)) {
      fresh.push(entry);
    }
  }
  if (fresh.length > 0) {
    lines.push('The following NEW packages will be installed:', `  ${fresh.map((e) => e.name).join(' ')}`);
  }
  lines.push(summary(fresh.length, 0));
  for (const entry of fresh) {
    lines.push(
      `Selecting previously unselected package ${entry.name}.`,
      `Preparing to unpack .../${debFileName(entry)} ...`,
      `Unpacking ${entry.name} (${entry.version}) ...`,
    );
  }
  for (const entry of fresh) {
    installPackage(host, entry);
    lines.push(`Setting up ${entry.name} (${entry.version}) ...`);
  }
  return { output: lines.join('\n'), exitCode: 0 };
}

function remove(host: PackageHost, names: readonly string[], purge: boolean): AptResult {
  const lines = [...PREAMBLE];
  const leaving: PackageEntry[] = [];
  for (const name of names) {
    const state = packageStateOf(host, name);
    const removable = state === 'installed' || (purge && state === 'config-files');
    if (!removable) lines.push(`Package '${name}' is not installed, so not removed`);
    else leaving.push(findPackage(name)!);
  }
  if (leaving.length > 0) {
    lines.push('The following packages will be REMOVED:',
      `  ${leaving.map((e) => (purge ? `${e.name}*` : e.name)).join(' ')}`);
  }
  lines.push(summary(0, leaving.length));
  for (const entry of leaving) {
    const wasInstalled = packageStateOf(host, entry.name) === 'installed';
    removePackage(host, entry, purge);
    if (wasInstalled) lines.push(`Removing ${entry.name} (${entry.version}) ...`);
    if (purge) lines.push(`Purging configuration files for ${entry.name} (${entry.version}) ...`);
  }
  return { output: lines.join('\n'), exitCode: 0 };
}

function runApt(ctx: LinuxCommandContext, args: string[], command: string): AptResult {
  const operands = args.filter((a) => !a.startsWith('-'));
  const sub = operands[0] ?? '';
  const names = operands.slice(1);
  const host = packageHostOf(ctx);

  if (sub === 'update') {
    return { output: `Hit:1 http://archive.ubuntu.com/ubuntu jammy InRelease\n${READING_LISTS}`, exitCode: 0 };
  }
  if (sub === 'upgrade') {
    return { output: [...PREAMBLE, 'Calculating upgrade... Done', summary(0, 0)].join('\n'), exitCode: 0 };
  }
  if (sub === 'list' && args.includes('--installed')) {
    const lines = packageRecords(host)
      .filter((record) => record.state === 'installed')
      .map(({ entry }) => `${entry.name}/jammy,now ${entry.version} ${entry.arch} [installed]`);
    return { output: ['Listing... Done', ...lines].join('\n'), exitCode: 0 };
  }
  if (sub === 'install' || sub === 'remove' || sub === 'purge') {
    if (names.length === 0) return { output: [...PREAMBLE, summary(0, 0)].join('\n'), exitCode: 0 };
    const unknown = unknownPackages(names);
    if (unknown.length > 0) {
      return {
        output: [...PREAMBLE, ...unknown.map((n) => `E: Unable to locate package ${n}`)].join('\n'),
        exitCode: 100,
      };
    }
    return sub === 'install' ? install(host, names) : remove(host, names, sub === 'purge');
  }
  return { output: `Usage: ${command} [update|install|upgrade|remove|purge|list]`, exitCode: 0 };
}

export const aptCommand: LinuxCommand = {
  name: 'apt',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'apt [options] {update|install|remove|purge|upgrade|list} [package ...]',
  help: 'Install, remove and list the packages of this machine.',
  run: (ctx, args) => runApt(ctx, args, 'apt').output,
  runWithStatusSync: (ctx, args) => runApt(ctx, args, 'apt'),
};

export const aptGetCommand: LinuxCommand = {
  name: 'apt-get',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'apt-get [options] {update|install|remove|purge|upgrade} [package ...]',
  help: 'Install, remove and list the packages of this machine.',
  run: (ctx, args) => runApt(ctx, args, 'apt-get').output,
  runWithStatusSync: (ctx, args) => runApt(ctx, args, 'apt-get'),
};
