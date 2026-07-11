import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { MachineApi, ProcessInfo } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

function normalizeImageName(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, '');
}

function parseFilter(raw: string): { field: string; op: string; value: string } | null {
  const clean = raw.replace(/^["']|["']$/g, '');
  const match = clean.match(/^(\w+)\s+(eq|ne|gt|lt|ge|le)\s+(.+)$/i);
  if (!match) return null;
  return { field: match[1].toLowerCase(), op: match[2].toLowerCase(), value: match[3].trim() };
}

function applyFilter(procs: ProcessInfo[], filter: { field: string; op: string; value: string }): ProcessInfo[] {
  return procs.filter((p) => {
    switch (filter.field) {
      case 'imagename': {
        const name = p.command.toLowerCase();
        const val = filter.value.toLowerCase();
        return filter.op === 'eq' ? name === val : name !== val;
      }
      case 'pid': {
        const val = parseInt(filter.value, 10);
        switch (filter.op) {
          case 'eq': return p.pid === val;
          case 'ne': return p.pid !== val;
          case 'gt': return p.pid > val;
          case 'lt': return p.pid < val;
          default: return true;
        }
      }
      case 'status': {
        const val = filter.value.toLowerCase();
        return filter.op === 'eq' ? (p.status ?? '').toLowerCase() === val : (p.status ?? '').toLowerCase() !== val;
      }
      case 'memusage': {
        const val = parseInt(filter.value, 10);
        const mem = p.memoryKib ?? 0;
        switch (filter.op) {
          case 'gt': return mem > val;
          case 'lt': return mem < val;
          case 'eq': return Math.floor(mem) === val;
          default: return true;
        }
      }
      default: return true;
    }
  });
}

async function killOne(machine: MachineApi, proc: ProcessInfo, isAdmin: boolean): Promise<string> {
  if (proc.systemOwned && !isAdmin) return 'ERROR: Access is denied.';
  if (proc.critical) return `ERROR: The process "${proc.command}" with PID ${proc.pid} is critical and cannot be terminated.`;
  await machine.proc.kill(proc.pid);
  return `SUCCESS: The process "${proc.command}" with PID ${proc.pid} has been terminated.`;
}

async function killWithTree(machine: MachineApi, proc: ProcessInfo, isAdmin: boolean, tree: boolean): Promise<string[]> {
  const results: string[] = [];
  if (tree) {
    const descendants = await (machine.proc.descendants?.(proc.pid) ?? Promise.resolve([]));
    for (const child of [...descendants].reverse()) {
      results.push(await killOne(machine, child, isAdmin));
    }
  }
  results.push(await killOne(machine, proc, isAdmin));
  return results;
}

export class TaskkillCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'taskkill',
    summary: 'Termine un ou plusieurs processus',
    usage: 'taskkill /pid <pid> | /im <nom> [/f] [/t]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options taskkill' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (args.length === 0) {
      await ctx.io.stdout.write('ERROR: Invalid syntax. A process name or PID must be specified.\n\nType "TASKKILL /?" for usage.\n');
      return 1;
    }

    let pid: number | null = null;
    let imageName = '';
    let force = false;
    let tree = false;
    const filters: Array<{ field: string; op: string; value: string }> = [];

    for (let i = 0; i < args.length; i++) {
      const flag = args[i].toLowerCase();
      if (flag === '/pid' && i + 1 < args.length) pid = parseInt(args[++i], 10);
      else if (flag === '/im' && i + 1 < args.length) imageName = args[++i];
      else if (flag === '/f') force = true;
      else if (flag === '/t') tree = true;
      else if (flag === '/fi' && i + 1 < args.length) { const f = parseFilter(args[++i]); if (f) filters.push(f); }
    }

    const isAdmin = ctx.session.user.isRoot();
    const processes = await ctx.machine.proc.list();

    if (filters.length > 0) {
      let matched = processes;
      for (const f of filters) matched = applyFilter(matched, f);
      if (matched.length === 0) {
        await ctx.io.stdout.write('INFO: No tasks running with the specified criteria.\n');
        return EXIT_OK;
      }
      const results: string[] = [];
      for (const proc of matched) results.push(...(await killWithTree(ctx.machine, proc, isAdmin, tree)));
      await ctx.io.stdout.write(results.join('\n') + '\n');
      return EXIT_OK;
    }

    if (pid !== null) {
      if (tree) {
        const target = processes.find((p) => p.pid === pid);
        const results = target ? await killWithTree(ctx.machine, target, isAdmin, true) : [];
        if (!target) {
          await ctx.io.stdout.write(`ERROR: The process "${pid}" not found.\n`);
          return 1;
        }
        await ctx.io.stdout.write(results.join('\n') + '\n');
        return EXIT_OK;
      }

      const proc = processes.find((p) => p.pid === pid);
      if (!proc) {
        await ctx.io.stdout.write(`ERROR: The process "${pid}" not found.\n`);
        return 1;
      }
      if (!force && !proc.windowTitle) {
        await ctx.io.stdout.write(`ERROR: The process with PID ${pid} could not be terminated.\nReason: This process can only be terminated forcefully (with /F option).\n`);
        return 1;
      }
      await ctx.io.stdout.write((await killOne(ctx.machine, proc, isAdmin)) + '\n');
      return EXIT_OK;
    }

    if (imageName) {
      const matches = processes.filter((p) => normalizeImageName(p.command) === normalizeImageName(imageName));
      if (matches.length === 0) {
        await ctx.io.stdout.write(`ERROR: The process "${imageName}" not found.\n`);
        return 1;
      }
      if (!force) {
        const noWindow = matches.filter((p) => !p.windowTitle);
        if (noWindow.length === matches.length) {
          await ctx.io.stdout.write(`ERROR: The process "${imageName}" with PID ${matches[0].pid} could not be terminated.\nReason: This process can only be terminated forcefully (with /F option).\n`);
          return 1;
        }
      }
      const results: string[] = [];
      for (const proc of matches) results.push(...(await killWithTree(ctx.machine, proc, isAdmin, tree)));
      await ctx.io.stdout.write(results.join('\n') + '\n');
      return EXIT_OK;
    }

    await ctx.io.stdout.write('ERROR: Invalid syntax. A process name or PID must be specified.\n\nType "TASKKILL /?" for usage.\n');
    return 1;
  }
}
