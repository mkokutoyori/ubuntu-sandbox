import { CommandContext, CommandDescriptor, ExitCode, EXIT_OK } from '@/command-kernel/command/types';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { PrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { AuthorizationResult, PrivilegeLevel, User } from '@/command-kernel/session/types';
import { PosixUseraddSpec } from '@/command-kernel/machine/types';

/** Refus au format util-linux exact (`useradd: Permission denied`). */
class RootWithVendorDenialPolicy implements PrivilegePolicy {
  readonly minLevel = PrivilegeLevel.ROOT;

  authorize(user: User): AuthorizationResult {
    if (user.isRoot()) return { granted: true };
    return { granted: false, reason: 'root requis', denialMessage: 'useradd: Permission denied' };
  }
}

interface ParsedUseradd {
  username: string;
  spec: PosixUseraddSpec;
  createHome: boolean;
  noCreateHome: boolean;
}

const VALUE_OPTIONS = new Set([
  '-u', '--uid', '-g', '--gid', '-G', '--groups', '-d', '--home-dir', '--home',
  '-b', '--base-dir', '-s', '--shell', '-c', '--comment', '-p', '--password',
  '-e', '--expiredate', '-f', '--inactive', '-k', '--skel',
]);

function parseExpireDays(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return Math.floor(ms / 86_400_000);
}

export class UseraddCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'useradd',
    summary: 'Create a new user or update default new user information.',
    usage: 'useradd [options] LOGIN',
    args: [{ name: 'argv', type: 'string', required: false, variadic: true, description: 'options et login (grammaire util-linux, analysée par la commande)' }],
    options: [],
    privileges: new RootWithVendorDenialPolicy(),
    category: 'iam',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const parsed = this.parse([...ctx.rawArgv]);
    if (!parsed.username) {
      await ctx.io.stdout.write('useradd: missing username\n');
      return 1;
    }

    const users = ctx.machine.users;
    if (!users.posixUseradd) {
      await ctx.io.stdout.write('useradd: cannot lock /etc/passwd; try again later.\n');
      return 1;
    }
    const out = users.posixUseradd(parsed.username, parsed.spec);
    if (out) {
      await ctx.io.stdout.write(`${out}\n`);
      return 1;
    }
    if (parsed.createHome && !parsed.noCreateHome) {
      users.createHomeSkeleton?.(parsed.username);
    }
    return EXIT_OK;
  }

  private parse(args: string[]): ParsedUseradd {
    let username = '';
    let uid: number | undefined;
    let primaryGroup: string | undefined;
    let supplementaryGroups: string[] = [];
    let home: string | undefined;
    let shell: string | undefined;
    let comment: string | undefined;
    let passwordHash: string | undefined;
    let expireDate: string | undefined;
    let inactiveDays: number | undefined;
    let createHome = false;
    let noCreateHome = false;
    let system = false;
    let nonUnique = false;
    let noUserGroup = false;

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-m' || a === '--create-home') { createHome = true; continue; }
      if (a === '-M' || a === '--no-create-home') { noCreateHome = true; continue; }
      if (a === '-r' || a === '--system') { system = true; continue; }
      if (a === '-o' || a === '--non-unique') { nonUnique = true; continue; }
      if (a === '-N' || a === '--no-user-group') { noUserGroup = true; continue; }
      if (a === '-U' || a === '--user-group') { continue; }
      if (VALUE_OPTIONS.has(a)) {
        const value = args[++i];
        if (value === undefined) continue;
        switch (a) {
          case '-u': case '--uid': { const v = parseInt(value, 10); if (!Number.isNaN(v)) uid = v; break; }
          case '-g': case '--gid': primaryGroup = value; break;
          case '-G': case '--groups': supplementaryGroups = value.split(',').map((g) => g.trim()).filter(Boolean); break;
          case '-d': case '--home-dir': case '--home': home = value; break;
          case '-b': case '--base-dir': break;
          case '-s': case '--shell': shell = value; break;
          case '-c': case '--comment': comment = value; break;
          case '-p': case '--password': passwordHash = value; break;
          case '-e': case '--expiredate': expireDate = value; break;
          case '-f': case '--inactive': { const v = parseInt(value, 10); if (!Number.isNaN(v)) inactiveDays = v; break; }
          case '-k': case '--skel': break;
        }
        continue;
      }
      if (a.startsWith('-')) continue;
      username = a;
    }

    return {
      username,
      createHome,
      noCreateHome,
      spec: {
        createHome,
        noCreateHome,
        shell,
        supplementaryGroups,
        home,
        primaryGroup,
        comment,
        uid,
        nonUnique,
        system,
        noUserGroup,
        passwordHash,
        expireDays: parseExpireDays(expireDate),
        inactiveDays,
      },
    };
  }
}
