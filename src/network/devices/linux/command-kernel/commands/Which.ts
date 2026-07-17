import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { KNOWN_LINUX_COMMANDS } from '@/network/devices/linux/LinuxCommandExecutor';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);
const KNOWN_SET = new Set(KNOWN_LINUX_COMMANDS);

/**
 * `which [-a] nom...` — résolution `$PATH` pure (équivalent
 * `CommandResolver.resolveAll(name, {forcePath:true})`, qui ignore alias/
 * fonction/builtin) via `machine.fs`/`session.env`, sans dépendre de
 * l'état interne du shell bash.
 */
export class WhichCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'which',
    summary: 'Localise l\'exécutable d\'une commande dans le PATH',
    usage: 'which [-a] nom...',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-a/--all, noms de commandes' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    let all = false;
    const names: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { names.push(...args.slice(i + 1)); break; }
      if (a === '-a' || a === '--all') { all = true; continue; }
      if (a === '--version') { await ctx.io.stdout.write('GNU which v2.21\n'); return EXIT_OK; }
      if (a.startsWith('-') && a.length > 1) { for (const f of a.slice(1)) if (f === 'a') all = true; continue; }
      names.push(a);
    }
    if (names.length === 0) return EXIT_OK;

    const pathDirs = (ctx.session.env.get('PATH') ?? '').split(':').filter(Boolean);
    const actor = toFileSystemActor(ctx.session.user);
    const out: string[] = [];
    let allFound = true;

    for (const name of names) {
      const files: string[] = [];
      if (name.includes('/')) {
        const abs = ctx.machine.fs.resolve(ctx.session.cwd, name);
        if (await ctx.machine.fs.exists(abs, actor)) {
          const st = await ctx.machine.fs.stat(abs, actor).catch(() => null);
          if (st && st.type !== 'directory') files.push(abs);
        }
      } else {
        for (const dir of pathDirs) {
          const p = `${dir}/${name}`;
          if (await ctx.machine.fs.exists(p, actor)) {
            const st = await ctx.machine.fs.stat(p, actor).catch(() => null);
            if (st && st.type !== 'directory') files.push(p);
          }
        }
        if (files.length === 0 && KNOWN_SET.has(name)) {
          files.push(`/usr/bin/${name}`);
        }
      }
      if (files.length === 0) { allFound = false; continue; }
      if (all) out.push(...files); else out.push(files[0]);
    }

    if (out.length > 0) await ctx.io.stdout.write(out.join('\n') + '\n');
    return allFound ? EXIT_OK : 1;
  }
}
