import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { ExitRequest } from '@/command-kernel/shell/exit';
import { expandTilde, formatLsLongEntry } from '../../../SshPureUtils';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);
const VARIADIC = [{ name: 'argv', type: 'string', required: false, variadic: true, description: 'arguments (grammaire sftp, analysée par la commande)' }] as const;

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

abstract class SftpBaseCommand extends BaseCommand {
  protected makeDescriptor(name: string, summary: string, usage: string, aliases?: readonly string[]): CommandDescriptor {
    return { name, aliases, summary, usage, args: [...VARIADIC], options: [], privileges: ANY, category: 'sftp', lenientOptions: true };
  }

  protected out(ctx: CommandContext, text: string): Promise<void> {
    return ctx.io.stdout.write(`${text}\n`);
  }
}

export class SftpPwdCommand extends SftpBaseCommand {
  readonly descriptor = this.makeDescriptor('pwd', "Display remote working directory", 'pwd');
  async execute(ctx: CommandContext): Promise<ExitCode> {
    await this.out(ctx, `Remote working directory: ${ctx.machine.sftp!.remoteCwd()}`);
    return EXIT_OK;
  }
}

export class SftpLpwdCommand extends SftpBaseCommand {
  readonly descriptor = this.makeDescriptor('lpwd', 'Print local working directory', 'lpwd');
  async execute(ctx: CommandContext): Promise<ExitCode> {
    await this.out(ctx, `Local working directory: ${ctx.session.cwd}`);
    return EXIT_OK;
  }
}

export class SftpCdCommand extends SftpBaseCommand {
  readonly descriptor = this.makeDescriptor('cd', "Change remote directory to 'path'", 'cd path');
  async execute(ctx: CommandContext): Promise<ExitCode> {
    const { positional } = splitFlags(ctx.rawArgv);
    const path = positional[0] ?? '';
    const result = ctx.machine.sftp!.cd(expandRemote(ctx, path || '~'));
    if (!result.ok) {
      const msg = result.error ?? '';
      if (/not a directory/i.test(msg)) { await this.out(ctx, `${path}: Not a directory`); return 1; }
      if (/permission denied/i.test(msg)) { await this.out(ctx, `Couldn't canonicalize: Permission denied`); return 1; }
      await this.out(ctx, `Couldn't canonicalize: No such file or directory`);
      return 1;
    }
    await this.out(ctx, '');
    return EXIT_OK;
  }
}

export class SftpLcdCommand extends SftpBaseCommand {
  readonly descriptor = this.makeDescriptor('lcd', "Change local directory to 'path'", 'lcd path');
  async execute(ctx: CommandContext): Promise<ExitCode> {
    const { positional } = splitFlags(ctx.rawArgv);
    const abs = ctx.machine.fs.resolve(ctx.session.cwd, positional[0] ?? '');
    const stat = await ctx.machine.fs.stat(abs, toFileSystemActor(ctx.session.user)).catch(() => null);
    if (!stat) { await this.out(ctx, 'Local directory not accessible: No such file or directory'); return 1; }
    if (stat.type !== 'directory') { await this.out(ctx, `${abs}: Not a directory`); return 1; }
    ctx.session.cwd = abs;
    await this.out(ctx, '');
    return EXIT_OK;
  }
}

export class SftpLsCommand extends SftpBaseCommand {
  readonly descriptor = this.makeDescriptor('ls', 'Display remote directory listing', 'ls [-1afhlnrSt] [path]');
  async execute(ctx: CommandContext): Promise<ExitCode> {
    const { flags, positional } = splitFlags(ctx.rawArgv);
    const requested = positional[0];
    const target = expandRemote(ctx, requested ?? '.');
    const result = ctx.machine.sftp!.ls(target);
    if (!result.ok) {
      await this.out(ctx, `ls: cannot access '${requested ?? ctx.machine.sftp!.remoteCwd()}': ${result.error || 'No such file or directory'}`);
      return 1;
    }
    const entries = result.value ?? [];
    const filtered = flags.has('a') ? entries : entries.filter((e) => !e.name.startsWith('.'));
    if (flags.has('l')) { await this.out(ctx, filtered.map(formatLsLongEntry).join('\n')); return EXIT_OK; }
    if (flags.has('1')) { await this.out(ctx, filtered.map((e) => e.name).join('\n')); return EXIT_OK; }
    await this.out(ctx, filtered.map((e) => e.name).join('  '));
    return EXIT_OK;
  }
}

export class SftpLlsCommand extends SftpBaseCommand {
  readonly descriptor = this.makeDescriptor('lls', 'Display local directory listing', 'lls [ls-options [path]]');
  async execute(ctx: CommandContext): Promise<ExitCode> {
    const { positional } = splitFlags(ctx.rawArgv);
    const path = positional[0] ? ctx.machine.fs.resolve(ctx.session.cwd, positional[0]) : ctx.session.cwd;
    const entries = await ctx.machine.fs.list(path, toFileSystemActor(ctx.session.user)).catch(() => null);
    if (!entries) { await this.out(ctx, `lls: cannot access '${path}': No such file or directory`); return 1; }
    await this.out(ctx, entries.map((e) => e.path.split('/').pop() ?? e.path).join('  '));
    return EXIT_OK;
  }
}

export class SftpVersionCommand extends SftpBaseCommand {
  readonly descriptor = this.makeDescriptor('version', 'Show SFTP version', 'version');
  async execute(ctx: CommandContext): Promise<ExitCode> {
    const result = ctx.machine.sftp!.version();
    await this.out(ctx, `SFTP protocol version ${result.ok ? result.value ?? 3 : 3}`);
    return EXIT_OK;
  }
}

export const SFTP_HELP_TEXT = `Available commands:
bye                                      Quit sftp
cd path                                  Change remote directory to 'path'
chmod mode path                          Change permissions of file
chown uid path                           Change owner of file
df [-h] [path]                           Display statistics for current dir or filesystem
exit                                     Quit sftp
get [-afpR] remote [local]               Download file
help                                     Display this help text
lcd path                                 Change local directory to 'path'
lls [ls-options [path]]                  Display local directory listing
lmkdir path                              Create local directory
lpwd                                     Print local working directory
ls [-1afhlnrSt] [path]                   Display remote directory listing
mkdir path                               Create remote directory
put [-afpR] local [remote]               Upload file
pwd                                      Display remote working directory
quit                                     Quit sftp
rename oldpath newpath                   Rename remote file
rm path                                  Delete remote file
rmdir path                               Remove remote directory
stat path                                Display file attributes
version                                  Show SFTP version`;

export class SftpHelpCommand extends SftpBaseCommand {
  readonly descriptor = this.makeDescriptor('help', 'Display this help text', 'help', ['?']);
  async execute(ctx: CommandContext): Promise<ExitCode> {
    await this.out(ctx, SFTP_HELP_TEXT);
    return EXIT_OK;
  }
}

export class SftpExitCommand extends SftpBaseCommand {
  readonly descriptor = this.makeDescriptor('exit', 'Quit sftp', 'exit', ['quit', 'bye']);
  async execute(): Promise<ExitCode> {
    throw new ExitRequest(0);
  }
}
