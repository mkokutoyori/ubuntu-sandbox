import type { PamConversationFlow, PamHandle } from '../PamHandle';
import type { LinuxPamHost } from '../PamLinuxHost';
import type { PamModuleImplementation } from '../PamModule';
import { PamFlag, PamReturn } from '../PamReturnCode';

const DEFAULT_MOTD = '/etc/motd:/run/motd:/usr/lib/motd';
const DEFAULT_MOTD_DIRECTORY = '/etc/motd.d:/run/motd.d:/usr/lib/motd.d';
const MAX_MOTD_SIZE = 0x10000;

function* displayFile(pamh: PamHandle<LinuxPamHost>, path: string): PamConversationFlow<boolean> {
  const stat = pamh.host.files.stat(path);
  if (stat === null || stat.directory) return false;
  const content = pamh.host.readFile(path);
  if (content === null) return false;
  if (content.length === 0 || content.length > MAX_MOTD_SIZE) return true;
  yield* pamh.notify('info', content.endsWith('\n') ? content.slice(0, -1) : content);
  return true;
}

function joinDirectory(directory: string, name: string): string {
  const hasSeparator = directory.endsWith('/') || name.startsWith('/');
  return `${directory}${hasSeparator ? '' : '/'}${name}`;
}

function* displayDirectories(
  pamh: PamHandle<LinuxPamHost>, directories: readonly string[], reportMissing: boolean,
): PamConversationFlow<void> {
  const names: string[] = [];
  for (const directory of directories) {
    const entries = pamh.host.files.listDirectory(directory);
    if (entries === null) {
      if (reportMissing && pamh.host.files.exists(directory)) pamh.syslog('err', `error scanning directory ${directory}: Not a directory`);
      else if (reportMissing) pamh.syslog('err', `error scanning directory ${directory}: No such file or directory`);
      continue;
    }
    for (const entry of entries) {
      const stat = pamh.host.files.stat(joinDirectory(directory, entry));
      if (stat !== null && stat.regular) names.push(entry);
    }
  }
  names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (let index = 0; index < names.length; index++) {
    if (index > 0 && names[index] === names[index - 1]) continue;
    for (const directory of directories) {
      if (yield* displayFile(pamh, joinDirectory(directory, names[index]))) break;
    }
  }
}

function* openSession(pamh: PamHandle<LinuxPamHost>, flags: number, args: readonly string[]): PamConversationFlow<number> {
  if ((flags & PamFlag.SILENT) !== 0) return PamReturn.IGNORE;
  let motdPath: string | null = null;
  let motdDirectory: string | null = null;
  let noUpdate = false;
  for (const argument of args) {
    if (argument.startsWith('motd=')) {
      const value = argument.slice(5);
      if (value !== '') motdPath = value;
      else { motdPath = null; pamh.syslog('err', 'motd= specification missing argument - ignored'); }
    } else if (argument.startsWith('motd_dir=')) {
      const value = argument.slice(9);
      if (value !== '') motdDirectory = value;
      else { motdDirectory = null; pamh.syslog('err', 'motd_dir= specification missing argument - ignored'); }
    } else if (argument === 'noupdate') {
      noUpdate = true;
    } else {
      pamh.syslog('err', `unknown option: ${argument}`);
    }
  }
  let reportMissing: boolean;
  if (motdPath === null && motdDirectory === null) {
    motdPath = DEFAULT_MOTD;
    motdDirectory = DEFAULT_MOTD_DIRECTORY;
    reportMissing = false;
  } else {
    reportMissing = true;
  }
  if (!noUpdate && reportMissing && motdPath !== null) {
    const refreshed = pamh.host.updateMotd?.() ?? null;
    if (refreshed !== null) pamh.host.files.writeFile(motdPath.split(':')[0], refreshed);
  }
  if (motdPath !== null) {
    for (const path of motdPath.split(':').filter((entry) => entry !== '')) {
      if (yield* displayFile(pamh, path)) break;
    }
  }
  if (motdDirectory !== null) {
    yield* displayDirectories(pamh, motdDirectory.split(':').filter((entry) => entry !== ''), reportMissing);
  }
  const code = pamh.putenv('MOTD_SHOWN=pam');
  return code === PamReturn.SUCCESS ? PamReturn.IGNORE : code;
}

export const pamMotdModule: PamModuleImplementation<LinuxPamHost> = {
  openSession,
  closeSession: () => PamReturn.IGNORE,
};
