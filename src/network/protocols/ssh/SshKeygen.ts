/**
 * ssh-keygen — generate an OpenSSH-style key pair on the local VFS.
 *
 * Pure data transformation kept separate from the terminal wiring so the
 * command can be tested in isolation. Default flags mirror OpenSSH 9.x.
 *
 * Reference: BRD-SSH-SFTP.md SSH-03 (R1..R4, R10).
 */

import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { SshKeyPair } from './SshKeyPair';

export interface SshKeygenOptions {
  readonly type: 'ed25519' | 'rsa';
  readonly comment: string;
  readonly file: string;
  readonly passphrase: string;
  readonly overwrite: boolean;
}

export interface SshKeygenResult {
  readonly publicKeyPath: string;
  readonly privateKeyPath: string;
  readonly fingerprint: string;
  readonly output: readonly string[];
}

const DEFAULT_OPTIONS = (homeDir: string): SshKeygenOptions =>
  Object.freeze({
    type: 'ed25519',
    comment: '',
    file: `${homeDir}/.ssh/id_ed25519`,
    passphrase: '',
    overwrite: false,
  });

/**
 * Parse the `ssh-keygen` CLI args. Recognised flags:
 *   -t <type>  -C <comment>  -f <file>  -N <passphrase>  -y (no-op here)
 */
export function parseSshKeygenArgs(
  args: readonly string[],
  homeDir: string,
): SshKeygenOptions {
  const opts: { -readonly [K in keyof SshKeygenOptions]: SshKeygenOptions[K] } = {
    ...DEFAULT_OPTIONS(homeDir),
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '-t':
        opts.type = (args[++i] === 'rsa' ? 'rsa' : 'ed25519');
        if (opts.type === 'rsa' && opts.file.endsWith('id_ed25519')) {
          opts.file = `${homeDir}/.ssh/id_rsa`;
        }
        break;
      case '-C':
        opts.comment = args[++i] ?? '';
        break;
      case '-f':
        opts.file = args[++i] ?? opts.file;
        break;
      case '-N':
        opts.passphrase = args[++i] ?? '';
        break;
    }
  }
  return Object.freeze(opts);
}

/**
 * Generate the key pair, write public + private files to the VFS,
 * and return the human-readable output OpenSSH would print.
 */
export function generateAndWriteKeyPair(
  vfs: VirtualFileSystem,
  uid: number,
  gid: number,
  options: SshKeygenOptions,
): SshKeygenResult | { error: string } {
  if (vfs.exists(options.file) && !options.overwrite) {
    return { error: `${options.file} already exists.` };
  }

  // Make sure ~/.ssh exists with mode 700.
  const sshDir = options.file.replace(/\/[^/]+$/, '');
  if (!vfs.exists(sshDir)) {
    vfs.mkdirp(sshDir, 0o700, uid, gid);
  }

  const algorithm = options.type === 'ed25519' ? 'ssh-ed25519' : 'ssh-rsa';
  const pair = SshKeyPair.generate(algorithm, options.comment || 'sandbox');

  const publicKeyPath = `${options.file}.pub`;
  const publicKeyLine = `${algorithm} ${pair.publicKeyContent}${options.comment ? ' ' + options.comment : ''}\n`;
  vfs.writeFile(publicKeyPath, publicKeyLine, uid, gid, 0o022);
  vfs.chmod(publicKeyPath, 0o644);

  const privateKeyBlob =
    `-----BEGIN OPENSSH PRIVATE KEY-----\n${pair.publicKeyContent}\n-----END OPENSSH PRIVATE KEY-----\n`;
  vfs.writeFile(options.file, privateKeyBlob, uid, gid, 0o022);
  vfs.chmod(options.file, 0o600);

  const fingerprint = pair.fingerprint.toString();
  const output = [
    `Generating public/private ${options.type} key pair.`,
    `Your identification has been saved in ${options.file}`,
    `Your public key has been saved in ${publicKeyPath}`,
    `The key fingerprint is:`,
    `${fingerprint} ${options.comment || 'sandbox'}`,
    `The key's randomart image is:`,
    `+--[${algorithm.toUpperCase().replace('SSH-', '')} 256]--+`,
    `|        .o+o.    |`,
    `|       ..=+o     |`,
    `+----[SHA256]-----+`,
  ];

  return {
    publicKeyPath,
    privateKeyPath: options.file,
    fingerprint,
    output,
  };
}
