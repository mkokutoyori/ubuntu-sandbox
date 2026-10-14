import type { SshAlgorithmPreferences } from '@/network/protocols/ssh/transport/SshTransport';
import {
  IMPLEMENTED_CIPHERS, IMPLEMENTED_HOST_KEY_ALGORITHMS, IMPLEMENTED_KEX_METHODS, IMPLEMENTED_MACS,
  resolveAlgorithmDirectives,
} from '@/network/protocols/ssh/transport/SshAlgorithms';
import type { Equipment } from '@/network/equipment/Equipment';
import type { ISshLocalFs } from '@/network/protocols/ssh/ISshLocalFs';
import { knownHostsPathFor, sshLocalFsFor, sshLocalIdentityFor } from '@/network/protocols/ssh/localFs/sshLocalFsFor';

export const IOS_LEGACY_SSH_CLIENT_CONFIG = [
  'Host *',
  '  KexAlgorithms +diffie-hellman-group-exchange-sha1,diffie-hellman-group14-sha1,diffie-hellman-group1-sha1',
  '  HostKeyAlgorithms +ssh-rsa',
  '  Ciphers +aes128-cbc,aes192-cbc,aes256-cbc,3des-cbc',
  '',
].join('\n');

export const IOS_LEGACY_SSH_PREFERENCES: SshAlgorithmPreferences = resolveAlgorithmDirectives({
  kex: '+diffie-hellman-group-exchange-sha1,diffie-hellman-group14-sha1,diffie-hellman-group1-sha1',
  hostKey: '+ssh-rsa',
  ciphers: '+aes128-cbc,aes192-cbc,aes256-cbc,3des-cbc',
});

function currentUserOf(device: Equipment): string {
  const dev = device as unknown as {
    executor?: { userMgr?: { currentUser: string } };
    userMgr?: { currentUser: string };
  };
  return dev.executor?.userMgr?.currentUser ?? dev.userMgr?.currentUser ?? 'root';
}

export function allowLegacyIosSsh(device: Equipment, ...users: string[]): void {
  const fs = sshLocalFsFor(device);
  for (const user of users.length > 0 ? users : [...new Set([currentUserOf(device), 'root'])]) {
    const path = knownHostsPathFor(device, user).replace(/known_hosts$/, 'config');
    const { uid, gid } = sshLocalIdentityFor(device, user);
    fs.mkdirp?.(path.slice(0, path.lastIndexOf('/')), 0o700, uid, gid);
    fs.writeFile(path, IOS_LEGACY_SSH_CLIENT_CONFIG, uid, gid, 0o077);
  }
}

export const IOS_LEGACY_SSHD_DIRECTIVES = [
  'KexAlgorithms +diffie-hellman-group-exchange-sha1,diffie-hellman-group14-sha1,diffie-hellman-group1-sha1',
  'HostKeyAlgorithms +ssh-rsa',
  'Ciphers +aes128-cbc,aes192-cbc,aes256-cbc,3des-cbc',
  '',
].join('\n');

export function allowLegacyIosSshServer(device: Equipment): void {
  const dev = device as unknown as {
    executor?: { vfs?: ISshLocalFs };
    executeShellCommandSync?: (command: string) => string;
    getFileSystem?: () => {
      readFile(path: string): { ok: boolean; content?: string };
      createFile(path: string, content: string): unknown;
    };
  };
  const vfs = dev.executor?.vfs;
  if (vfs) {
    const path = '/etc/ssh/sshd_config';
    const current = vfs.readFile(path) ?? '';
    vfs.writeFile(path, IOS_LEGACY_SSHD_DIRECTIVES + current, 0, 0, 0o022);
    dev.executeShellCommandSync?.('systemctl reload ssh');
    return;
  }
  const wfs = dev.getFileSystem?.();
  if (!wfs) return;
  const path = 'C:\\ProgramData\\ssh\\sshd_config';
  const current = wfs.readFile(path);
  wfs.createFile(path, IOS_LEGACY_SSHD_DIRECTIVES + (current.ok ? current.content ?? '' : ''));
}

export async function allowLegacyIosSshServerOnVrp(device: Equipment): Promise<void> {
  const router = device as unknown as { executeCommand(command: string): Promise<string> };
  for (const command of [
    'system-view',
    'ssh server key-exchange dh_group_exchange_sha1 dh_group14_sha1 dh_group1_sha1',
    'ssh server publickey rsa',
    'ssh server cipher aes128_ctr aes192_ctr aes256_ctr aes128_cbc aes256_cbc 3des_cbc',
    'ssh server hmac sha1 sha1_96',
    'quit',
  ]) await router.executeCommand(command);
}

export function allowLegacyIosSshServerOnFortiOs(shell: { execute(line: string): unknown }): void {
  for (const line of [
    'config system global',
    `set ssh-kex-algo ${IMPLEMENTED_KEX_METHODS.join(' ')}`,
    `set ssh-hostkey-algo ${IMPLEMENTED_HOST_KEY_ALGORITHMS.join(' ')}`,
    `set ssh-enc-algo ${IMPLEMENTED_CIPHERS.join(' ')}`,
    `set ssh-mac-algo ${IMPLEMENTED_MACS.join(' ')}`,
    'end',
  ]) shell.execute(line);
}
