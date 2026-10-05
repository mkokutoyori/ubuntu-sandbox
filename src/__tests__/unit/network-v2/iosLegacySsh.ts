import type { SshAlgorithmPreferences } from '@/network/protocols/ssh/transport/SshTransport';
import { resolveAlgorithmDirectives } from '@/network/protocols/ssh/transport/SshAlgorithms';
import type { Equipment } from '@/network/equipment/Equipment';
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
