import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const VALID_PERMS = ['F', 'M', 'RX', 'R', 'W', 'D', 'N'];

function expandPermToken(token: string): string[] {
  switch (token) {
    case 'F': return ['FullControl'];
    case 'M': return ['Modify', 'Read', 'Write', 'Execute', 'Delete'];
    case 'RX': return ['ReadAndExecute', 'Read', 'Execute'];
    case 'R': return ['Read'];
    case 'W': return ['Write'];
    case 'D': return ['Delete'];
    case 'N': return ['None'];
    default: return [token];
  }
}

function permissionsToToken(perms: readonly string[]): string {
  if (perms.includes('FullControl')) return 'F';
  if (perms.includes('Modify')) return 'M';
  if (perms.includes('ReadAndExecute')) return 'RX';
  if (perms.includes('Read') && perms.includes('Write')) return 'RW';
  if (perms.includes('Read')) return 'R';
  if (perms.includes('Write')) return 'W';
  if (perms.includes('Delete')) return 'D';
  return perms.join(',');
}

export class IcaclsCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'icacls',
    summary: "Affiche ou modifie les listes de contrôle d'accès NTFS",
    usage: 'icacls <chemin> [/grant user:(perm)] [/deny user:(perm)] [/remove user]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'chemin et options' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    const fs = ctx.machine.fs;
    if (!fs.getAcl || !fs.grantAcl || !fs.removeAcl) {
      await ctx.io.stdout.write('ICACLS: not supported on this device\n');
      return 1;
    }
    if (args.length === 0) {
      await ctx.io.stdout.write('ERROR: No file name specified.\nUsage: ICACLS name [/grant[:r] user:perm] [/deny user:perm]\n              [/remove user] [/T] [/C] [/L] [/Q]\n');
      return 1;
    }

    const path = args[0];
    const actor = toFileSystemActor(ctx.session.user);
    const abs = ctx.machine.fs.resolve(ctx.session.cwd, path);
    if (!(await ctx.machine.fs.exists(abs, actor))) {
      await ctx.io.stdout.write(`${path}: The system cannot find the file specified.\n`);
      return 1;
    }

    let i = 1;
    while (i < args.length) {
      const flag = args[i].toLowerCase();

      if (flag === '/grant' || flag === '/grant:r') {
        if (!ctx.session.user.isRoot()) { await ctx.io.stdout.write(`${path}: Access is denied.\n`); return 1; }
        if (i + 1 >= args.length) { await ctx.io.stdout.write('ERROR: Invalid parameter.\n'); return 1; }
        const spec = args[++i];
        const match = spec.match(/^([^:]+):\(([^)]+)\)$/);
        if (!match) { await ctx.io.stdout.write('ERROR: Invalid parameter format. Expected user:(permission)\n'); return 1; }
        const permToken = match[2].toUpperCase();
        if (!VALID_PERMS.includes(permToken)) { await ctx.io.stdout.write(`ERROR: Invalid permission token '${permToken}'.\n`); return 1; }
        await fs.grantAcl(abs, { principal: match[1], type: 'allow', permissions: expandPermToken(permToken) }, actor);
        i++;
        continue;
      }

      if (flag === '/deny') {
        if (!ctx.session.user.isRoot()) { await ctx.io.stdout.write(`${path}: Access is denied.\n`); return 1; }
        if (i + 1 >= args.length) { await ctx.io.stdout.write('ERROR: Invalid parameter.\n'); return 1; }
        const spec = args[++i];
        const match = spec.match(/^([^:]+):\(([^)]+)\)$/);
        if (!match) { await ctx.io.stdout.write('ERROR: Invalid parameter format. Expected user:(permission)\n'); return 1; }
        const permToken = match[2].toUpperCase();
        if (!VALID_PERMS.includes(permToken)) { await ctx.io.stdout.write(`ERROR: Invalid permission token '${permToken}'.\n`); return 1; }
        await fs.grantAcl(abs, { principal: match[1], type: 'deny', permissions: expandPermToken(permToken) }, actor);
        i++;
        continue;
      }

      if (flag === '/remove') {
        if (!ctx.session.user.isRoot()) { await ctx.io.stdout.write(`${path}: Access is denied.\n`); return 1; }
        if (i + 1 >= args.length) { await ctx.io.stdout.write('ERROR: Invalid parameter.\n'); return 1; }
        await fs.removeAcl(abs, args[++i], actor);
        i++;
        continue;
      }

      if (flag === '/t' || flag === '/c' || flag === '/l' || flag === '/q') { i++; continue; }
      i++;
    }

    if (args.length === 1) {
      const acl = await fs.getAcl(abs, actor);
      const lines: string[] = [path];
      if (acl.length === 0) {
        lines.push('    BUILTIN\\Administrators:(F)');
        lines.push('    BUILTIN\\Users:(RX)');
        lines.push('    NT AUTHORITY\\SYSTEM:(F)');
      } else {
        for (const ace of acl) {
          const token = permissionsToToken(ace.permissions);
          const denyStr = ace.type === 'deny' ? '(DENY)' : '';
          lines.push(`    ${ace.principal}:${denyStr}(${token})`);
        }
      }
      lines.push('');
      lines.push('Successfully processed 1 files; Failed processing 0 files');
      await ctx.io.stdout.write(lines.join('\n') + '\n');
      return EXIT_OK;
    }

    await ctx.io.stdout.write('Successfully processed 1 files; Failed processing 0 files\n');
    return EXIT_OK;
  }
}
