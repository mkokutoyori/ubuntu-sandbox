import type { SftpServerOptions } from '../sftp/server/SftpServerOptions';

export type SftpLaunch =
  | { readonly kind: 'subsystem'; readonly name: string }
  | { readonly kind: 'command'; readonly command: string };

export type SftpServicePlan =
  | { readonly kind: 'unavailable' }
  | {
    readonly kind: 'serve';
    readonly program: 'sftp-server' | 'internal-sftp';
    readonly options: SftpServerOptions;
    readonly diagnostics: readonly string[];
  }
  | { readonly kind: 'exits'; readonly stdout: string; readonly stderr: string; readonly exitCode: number }
  | { readonly kind: 'runs'; readonly run: () => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> };

export const isInternalSftp = (command: string): boolean =>
  command === 'internal-sftp' || command.startsWith('internal-sftp ');

export function sftpProgramOf(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  return first.slice(first.lastIndexOf('/') + 1).replace(/\.exe$/i, '');
}
