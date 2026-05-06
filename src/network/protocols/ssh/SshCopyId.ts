/**
 * ssh-copy-id — install a public key into the remote ~/.ssh/authorized_keys.
 *
 * Pure orchestration: the caller provides an authenticated `SshSession`
 * and the public key material to install. Uses an SFTP channel to append
 * the line to the remote file (read-modify-write).
 *
 * Reference: BRD-SSH-SFTP.md SSH-03-R5/R6/R7.
 */

import { isErr } from './Result';
import type { ISshSession } from './session/ISshSession';
import { parseAuthorizedKeysLine } from './SshPureUtils';

export interface SshCopyIdResult {
  readonly added: number;
  readonly output: readonly string[];
}

export async function sshCopyId(
  session: ISshSession,
  publicKeyLine: string,
  remoteHomeDir: string,
): Promise<SshCopyIdResult | { error: string }> {
  const targetPath = `${remoteHomeDir.replace(/\/$/, '')}/.ssh/authorized_keys`;
  const channelResult = session.openSftpChannel();
  if (isErr(channelResult)) return { error: 'failed to open SFTP channel' };
  const channel = channelResult.value;

  const parsed = parseAuthorizedKeysLine(publicKeyLine);
  if (!parsed) return { error: 'malformed public key line' };

  // Ensure ~/.ssh exists. mkdir failures (e.g. already exists) are ignored.
  channel.sendRequest({ op: 'mkdir', path: `${remoteHomeDir.replace(/\/$/, '')}/.ssh` });

  const existing = channel.sendRequest({ op: 'get', path: targetPath });
  let content = '';
  if (existing.ok && typeof existing.content === 'string') {
    content = existing.content;
    if (
      content
        .split('\n')
        .map(parseAuthorizedKeysLine)
        .some((k) => k && k.material === parsed.material)
    ) {
      channel.close();
      return {
        added: 0,
        output: [
          `/usr/bin/ssh-copy-id: WARNING: All keys were skipped because they already exist on the remote system.`,
        ],
      };
    }
  }
  const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  const next = content + sep + publicKeyLine.replace(/\n$/, '') + '\n';

  const put = channel.sendRequest({ op: 'put', path: targetPath, content: next });
  if (!put.ok) {
    channel.close();
    return { error: `unable to write ${targetPath}: ${put.error ?? 'failure'}` };
  }
  channel.sendRequest({ op: 'chmod', path: targetPath, mode: 0o600 });
  channel.close();

  return {
    added: 1,
    output: [
      `/usr/bin/ssh-copy-id: INFO: attempting to log in with the new key(s)`,
      `Number of key(s) added: 1`,
      ``,
      `Now try logging into the machine, with:   "ssh '<user>@<host>'"`,
    ],
  };
}
