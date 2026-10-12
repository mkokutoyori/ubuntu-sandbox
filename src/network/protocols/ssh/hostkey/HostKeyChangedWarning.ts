import { SshFingerprint } from '../SshFingerprint';
import { SshKnownHostEntry, SshKnownHostsFile, type SshHostKeyType } from '../SshKnownHostsFile';
import { appendKnownHostsLine, knownHostsLineOf, withoutHost } from './KnownHostsText';
import { sshKeyTypeLabel } from '@/network/devices/linux/network/SshKeygenMaterial';

export interface HostKeyChange {
  readonly host: string;
  readonly keyTypeLabel: string;
  readonly fingerprint: string;
  readonly knownHostsPath: string;
  readonly line: number;
}

export function hostKeyChangedWarning(change: HostKeyChange): string {
  const { host, keyTypeLabel, fingerprint, knownHostsPath, line } = change;
  return [
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
    'Someone could be eavesdropping on you right now (man-in-the-middle attack)!',
    'It is also possible that a host key has just been changed.',
    `The fingerprint for the ${keyTypeLabel} key sent by the remote host is`,
    `${fingerprint}.`,
    'Please contact your system administrator.',
    `Add correct host key in ${knownHostsPath} to get rid of this message.`,
    `Offending ${keyTypeLabel} key in ${knownHostsPath}:${line}`,
    '  remove with:',
    `  ssh-keygen -f "${knownHostsPath}" -R "${host}"`,
    `Host key for ${host} has changed and you have requested strict checking.`,
  ].join('\n');
}

export interface KnownHostsVfs {
  readFile(path: string): string | null;
  writeFile(path: string, content: string, uid: number, gid: number, umask: number): void;
  mkdirp?(path: string, mode: number, uid: number, gid: number): void;
  resolveInode?(path: string): unknown;
}

export interface HostKeyRecord {
  readonly vfs: KnownHostsVfs;
  readonly knownHostsPath: string;
  readonly host: string;
  readonly keyType: SshHostKeyType | string;
  readonly publicKey: string;
  readonly uid: number;
  readonly gid: number;
  readonly replaceChanged: boolean;
}

export type HostKeyComparison =
  | { readonly changed: false }
  | { readonly changed: true; readonly warning: string };

export function compareAndRecordHostKey(record: HostKeyRecord): HostKeyComparison {
  const { vfs, knownHostsPath, host, keyType, publicKey } = record;
  const content = vfs.readFile(knownHostsPath) ?? '';
  const file = SshKnownHostsFile.parse(content);
  const changed = file.hostKeyChanged(host, keyType, publicKey);
  if (changed && !record.replaceChanged) {
    return {
      changed: true,
      warning: hostKeyChangedWarning({
        host,
        keyTypeLabel: sshKeyTypeLabel(keyType),
        fingerprint: SshFingerprint.fromPublicKey(`${keyType} ${publicKey}`).toString(),
        knownHostsPath,
        line: knownHostsLineOf(content, host),
      }),
    };
  }
  if (changed || !file.find(host, keyType)) {
    const kept = changed ? withoutHost(content, host) : content;
    const entry = new SshKnownHostEntry({ hostnames: [host], keyType, publicKey });
    const updated = appendKnownHostsLine(kept, entry.serialize());
    const sshDir = knownHostsPath.replace(/\/[^/]+$/, '');
    if (vfs.mkdirp && vfs.resolveInode && !vfs.resolveInode(sshDir)) {
      vfs.mkdirp(sshDir, 0o700, record.uid, record.gid);
    }
    vfs.writeFile(knownHostsPath, updated, record.uid, record.gid, 0o022);
  }
  return { changed: false };
}
