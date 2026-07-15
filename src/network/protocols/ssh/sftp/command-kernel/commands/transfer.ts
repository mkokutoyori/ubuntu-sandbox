import { CommandContext, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { expandTilde } from '../../../SshPureUtils';

import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandDescriptor } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

function splitFlags(argv: readonly string[]): { flags: Set<string>; positional: string[] } {
  const flags = new Set<string>();
  const positional: string[] = [];
  for (const token of argv) {
    if (token === '--') continue;
    if (token.startsWith('--') && token.length > 2) flags.add(token.slice(2));
    else if (token.startsWith('-') && token.length > 1) for (const ch of token.slice(1)) flags.add(ch);
    else positional.push(token);
  }
  return { flags, positional };
}

function expandRemote(ctx: CommandContext, path: string): string {
  return expandTilde(path, ctx.machine.sftp!.remoteHome());
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

abstract class SftpTransferBase extends BaseCommand {
  protected makeDescriptor(name: string, summary: string, usage: string): CommandDescriptor {
    return {
      name,
      summary,
      usage,
      args: [{ name: 'argv', type: 'string', required: false, variadic: true, description: 'arguments (grammaire sftp, analysée par la commande)' }],
      options: [],
      privileges: ANY,
      category: 'sftp',
      lenientOptions: true,
    };
  }

  protected out(ctx: CommandContext, text: string): Promise<void> {
    return ctx.io.stdout.write(`${text}\n`);
  }
}

export class SftpGetCommand extends SftpTransferBase {
  readonly descriptor = this.makeDescriptor('get', 'Download file', 'get [-afpR] remote [local]');
  async execute(ctx: CommandContext): Promise<ExitCode> {
    const { positional } = splitFlags(ctx.rawArgv);
    const [remote, local] = positional;
    if (!remote) { await this.out(ctx, 'usage: get remote [local]'); return EXIT_OK; }
    await this.out(ctx, ctx.machine.sftp!.download(remote, local));
    return EXIT_OK;
  }
}

export class SftpPutCommand extends SftpTransferBase {
  readonly descriptor = this.makeDescriptor('put', 'Upload file', 'put [-afpR] local [remote]');
  async execute(ctx: CommandContext): Promise<ExitCode> {
    const { positional } = splitFlags(ctx.rawArgv);
    const [local, remote] = positional;
    if (!local) { await this.out(ctx, 'usage: put local [remote]'); return EXIT_OK; }
    await this.out(ctx, ctx.machine.sftp!.upload(local, remote));
    return EXIT_OK;
  }
}

export class SftpMkdirCommand extends SftpTransferBase {
  readonly descriptor = this.makeDescriptor('mkdir', 'Create remote directory', 'mkdir path');
  async execute(ctx: CommandContext): Promise<ExitCode> {
    const { positional } = splitFlags(ctx.rawArgv);
    if (!positional[0]) { await this.out(ctx, 'usage: mkdir path'); return EXIT_OK; }
    const result = ctx.machine.sftp!.mkdir(expandRemote(ctx, positional[0]));
    if (!result.ok) { await this.out(ctx, `Couldn't create directory: ${result.error || 'Failure'}`); return 1; }
    await this.out(ctx, '');
    return EXIT_OK;
  }
}

export class SftpRmCommand extends SftpTransferBase {
  readonly descriptor = this.makeDescriptor('rm', 'Delete remote file', 'rm path');
  async execute(ctx: CommandContext): Promise<ExitCode> {
    const { positional } = splitFlags(ctx.rawArgv);
    const path = positional[0];
    if (!path) { await this.out(ctx, 'usage: rm path'); return EXIT_OK; }
    const result = ctx.machine.sftp!.rm(expandRemote(ctx, path));
    if (!result.ok) { await this.out(ctx, `Couldn't remove file: remove "${path}": ${result.error || 'Failure'}`); return 1; }
    await this.out(ctx, '');
    return EXIT_OK;
  }
}

export class SftpRmdirCommand extends SftpTransferBase {
  readonly descriptor = this.makeDescriptor('rmdir', 'Remove remote directory', 'rmdir path');
  async execute(ctx: CommandContext): Promise<ExitCode> {
    const { positional } = splitFlags(ctx.rawArgv);
    const path = positional[0];
    if (!path) { await this.out(ctx, 'usage: rmdir path'); return EXIT_OK; }
    const result = ctx.machine.sftp!.rmdir(expandRemote(ctx, path));
    if (!result.ok) { await this.out(ctx, `Couldn't remove directory: rmdir "${path}": ${result.error || 'Failure'}`); return 1; }
    await this.out(ctx, '');
    return EXIT_OK;
  }
}

export class SftpRenameCommand extends SftpTransferBase {
  readonly descriptor = this.makeDescriptor('rename', 'Rename remote file', 'rename oldpath newpath');
  async execute(ctx: CommandContext): Promise<ExitCode> {
    const { positional } = splitFlags(ctx.rawArgv);
    const [oldPath, newPath] = positional;
    if (!oldPath || !newPath) { await this.out(ctx, 'usage: rename oldpath newpath'); return EXIT_OK; }
    const result = ctx.machine.sftp!.rename(expandRemote(ctx, oldPath), expandRemote(ctx, newPath));
    if (!result.ok) { await this.out(ctx, `Couldn't rename file: rename ${oldPath} ${newPath}: ${result.error || 'Failure'}`); return 1; }
    await this.out(ctx, '');
    return EXIT_OK;
  }
}

export class SftpChmodCommand extends SftpTransferBase {
  readonly descriptor = this.makeDescriptor('chmod', 'Change permissions of file', 'chmod mode path');
  async execute(ctx: CommandContext): Promise<ExitCode> {
    const { positional } = splitFlags(ctx.rawArgv);
    const [modeOctal, path] = positional;
    if (!modeOctal || !path) { await this.out(ctx, 'usage: chmod mode path'); return EXIT_OK; }
    const mode = Number.parseInt(modeOctal, 8);
    if (Number.isNaN(mode)) { await this.out(ctx, `chmod: invalid mode '${modeOctal}'`); return 1; }
    const remote = expandRemote(ctx, path);
    const result = ctx.machine.sftp!.chmod(remote, mode);
    if (!result.ok) { await this.out(ctx, `Couldn't setstat on "${remote}": ${result.error || 'Failure'}`); return 1; }
    await this.out(ctx, `Changing mode on ${remote}`);
    return EXIT_OK;
  }
}

export class SftpChownCommand extends SftpTransferBase {
  readonly descriptor = this.makeDescriptor('chown', 'Change owner of file', 'chown uid path');
  async execute(ctx: CommandContext): Promise<ExitCode> {
    const { positional } = splitFlags(ctx.rawArgv);
    const [uid, path] = positional;
    if (!uid || !path) { await this.out(ctx, 'usage: chown uid path'); return EXIT_OK; }
    const numericUid = Number.parseInt(uid, 10);
    if (Number.isNaN(numericUid)) { await this.out(ctx, `chown: invalid uid '${uid}'`); return 1; }
    const remote = expandRemote(ctx, path);
    const result = ctx.machine.sftp!.chown(remote, numericUid, numericUid);
    if (!result.ok) { await this.out(ctx, `Couldn't setstat on "${remote}": ${result.error || 'Failure'}`); return 1; }
    await this.out(ctx, `Changing owner on ${remote}`);
    return EXIT_OK;
  }
}

export class SftpStatCommand extends SftpTransferBase {
  readonly descriptor = this.makeDescriptor('stat', 'Display file attributes', 'stat path');
  async execute(ctx: CommandContext): Promise<ExitCode> {
    const { positional } = splitFlags(ctx.rawArgv);
    if (!positional[0]) { await this.out(ctx, 'usage: stat path'); return EXIT_OK; }
    const remote = expandRemote(ctx, positional[0]);
    const result = ctx.machine.sftp!.stat(remote);
    if (!result.ok) { await this.out(ctx, `${remote}: ${result.error || 'No such file or directory'}`); return 1; }
    const a = result.value!;
    const mtime = new Date(a.mtime).toUTCString();
    await this.out(ctx, [
      `  File: ${remote}`,
      `  Size: ${a.size}`,
      `  Mode: 0${(a.mode & 0o7777).toString(8).padStart(4, '0')}   UID: ${a.uid}   GID: ${a.gid}`,
      `  Access: ${mtime}`,
      `  Modify: ${mtime}`,
    ].join('\n'));
    return EXIT_OK;
  }
}

export class SftpDfCommand extends SftpTransferBase {
  readonly descriptor = this.makeDescriptor('df', 'Display statistics for current dir or filesystem', 'df [-h] [path]');
  async execute(ctx: CommandContext): Promise<ExitCode> {
    const { flags, positional } = splitFlags(ctx.rawArgv);
    const remote = positional[0] ? expandRemote(ctx, positional[0]) : ctx.machine.sftp!.remoteCwd();
    const result = ctx.machine.sftp!.df(remote);
    if (!result.ok) { await this.out(ctx, `df: ${result.error || 'Failure'}`); return 1; }
    const a = result.value!;
    const fmt = flags.has('h') ? humanBytes : (n: number) => String(Math.round(n / 1024));
    const pct = Math.round((a.usedBytes / a.totalBytes) * 100);
    await this.out(ctx, [
      `        Size         Used        Avail       (root)    %Capacity`,
      `${fmt(a.totalBytes).padStart(12, ' ')} ${fmt(a.usedBytes).padStart(12, ' ')} ${fmt(a.availableBytes).padStart(12, ' ')} ${fmt(a.availableBytes).padStart(12, ' ')} ${(pct + '%').padStart(12, ' ')}`,
    ].join('\n'));
    return EXIT_OK;
  }
}

export class SftpLmkdirCommand extends SftpTransferBase {
  readonly descriptor = this.makeDescriptor('lmkdir', 'Create local directory', 'lmkdir path');
  async execute(ctx: CommandContext): Promise<ExitCode> {
    const { positional } = splitFlags(ctx.rawArgv);
    if (!positional[0]) { await this.out(ctx, 'usage: lmkdir path'); return EXIT_OK; }
    const abs = ctx.machine.fs.resolve(ctx.session.cwd, positional[0]);
    try {
      await ctx.machine.fs.mkdir(abs, toFileSystemActor(ctx.session.user));
    } catch {
      await this.out(ctx, `Couldn't create local directory: ${abs}: File exists or parent missing`);
      return 1;
    }
    await this.out(ctx, '');
    return EXIT_OK;
  }
}
