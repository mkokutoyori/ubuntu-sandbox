import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

function fmtSchtasksDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export class SchtasksCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'schtasks',
    summary: 'Crée, supprime, interroge et exécute des tâches planifiées',
    usage: 'schtasks /query|/create|/delete|/run|/change|/end [options]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'sous-commande schtasks' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (!ctx.machine.scheduling) {
      await ctx.io.stdout.write('SCHTASKS: not supported on this device\n');
      return 1;
    }
    if (!ctx.machine.scheduling.isServiceRunning()) {
      await ctx.io.stdout.write('ERROR: The Task Scheduler service is not running.\n');
      return 1;
    }

    const action = args[0]?.toLowerCase();
    const flagIdx = (name: string) => args.findIndex((a) => a.toLowerCase() === name);
    const flagVal = (name: string) => { const i = flagIdx(name); return i >= 0 ? args[i + 1] : undefined; };
    const tn = flagVal('/tn');

    if (action === '/query') {
      const tasks = ctx.machine.scheduling.list(tn);
      const lines = [
        'Folder: \\',
        'TaskName                                 Next Run Time          Status',
        '======================================== ====================== ===============',
      ];
      for (const t of tasks) {
        const next = t.runAt ? fmtSchtasksDate(t.runAt) : 'N/A';
        lines.push(`${t.name.padEnd(40)} ${next.padEnd(22)} ${t.state}`);
      }
      await ctx.io.stdout.write(lines.join('\n') + '\n');
      return EXIT_OK;
    }

    if (action === '/create') {
      if (!tn) {
        await ctx.io.stdout.write('ERROR: The required parameter "/TN" is missing.\n');
        return 1;
      }
      const mo = Number(flagVal('/mo')) || 1;
      ctx.machine.scheduling.create(tn, {
        schedule: flagVal('/sc')?.toUpperCase(),
        startTime: flagVal('/st'),
        intervalCount: mo,
        command: flagVal('/tr'),
      });
      await ctx.io.stdout.write(`SUCCESS: The scheduled task "${tn}" has successfully been created.\n`);
      return EXIT_OK;
    }

    if (action === '/delete') {
      if (!tn) {
        await ctx.io.stdout.write('ERROR: The required parameter "/TN" is missing.\n');
        return 1;
      }
      const removed = ctx.machine.scheduling.delete(tn);
      if (removed) {
        await ctx.io.stdout.write(`SUCCESS: The scheduled task "${tn}" was successfully deleted.\n`);
        return EXIT_OK;
      }
      await ctx.io.stdout.write('ERROR: The system cannot find the file specified.\n');
      return 1;
    }

    if (action === '/run') {
      if (!tn) {
        await ctx.io.stdout.write('ERROR: The required parameter "/TN" is missing.\n');
        return 1;
      }
      const ran = ctx.machine.scheduling.run(tn);
      if (ran) {
        await ctx.io.stdout.write(`SUCCESS: Attempted to run the scheduled task "${tn}".\n`);
        return EXIT_OK;
      }
      await ctx.io.stdout.write('ERROR: The system cannot find the file specified.\n');
      return 1;
    }

    if (action === '/end' || action === '/change') {
      await ctx.io.stdout.write('SUCCESS: The scheduled task was created/modified successfully.\n');
      return EXIT_OK;
    }

    await ctx.io.stdout.write('SCHTASKS /parameter [arguments]\n\nDescription:\n    Enables an administrator to create, delete, query, change, run, and\n    end scheduled tasks on a local or remote computer.\n');
    return 1;
  }
}
