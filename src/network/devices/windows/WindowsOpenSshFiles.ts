import { WINDOWS_OPENSSH_SSH_CONFIG } from '@/network/protocols/ssh/client/WindowsSshClientConfigFile';
import { WINDOWS_OPENSSH_SSHD_CONFIG } from '@/network/protocols/ssh/server/WindowsSshdConfigFile';
import { sshPathOfWindowsPath } from '@/network/protocols/ssh/localFs/WindowsSshLocalFs';
import type { WindowsFileSystem } from './WindowsFileSystem';

export const WINDOWS_OPENSSH_DIRECTORY = 'C:\\ProgramData\\ssh';

export function seedWindowsOpenSshFiles(fs: WindowsFileSystem): void {
  fs.mkdirp(WINDOWS_OPENSSH_DIRECTORY);
  const seed = (name: string, text: string): void => {
    const path = `${WINDOWS_OPENSSH_DIRECTORY}\\${name}`;
    if (!fs.exists(path)) fs.createFile(path, text);
  };
  seed('ssh_config', WINDOWS_OPENSSH_SSH_CONFIG);
  seed('sshd_config', WINDOWS_OPENSSH_SSHD_CONFIG);
}

const WINDOWS_PATH_VALUE = /^[A-Za-z]:|\\/;

export function posixClientFlags(flags: readonly string[]): string[] {
  const converted: string[] = [];
  for (let at = 0; at < flags.length; at += 1) {
    converted.push(flags[at]);
    if ((flags[at] === '-i' || flags[at] === '-F') && flags[at + 1] !== undefined) {
      at += 1;
      converted.push(WINDOWS_PATH_VALUE.test(flags[at]) ? sshPathOfWindowsPath(flags[at]) : flags[at]);
    }
  }
  return converted;
}
