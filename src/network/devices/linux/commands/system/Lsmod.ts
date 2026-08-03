/**
 * `lsmod` et `modinfo` — les modules chargés dans le noyau.
 *
 * Les deux lisent la même `KernelModuleTable`, elle-même dérivée du
 * matériel de la machine (voir son en-tête) : c'est ce qui fait que le
 * pilote listé par `lsmod` est bien celui que `lspci -k` nomme, et non
 * deux textes indépendants qui finiraient par se contredire.
 *
 * `lsmod` n'est qu'une mise en forme de `/proc/modules` ; le fichier est
 * donc la source et la commande le lecteur, dans cet ordre, pour que
 * `cat /proc/modules` et `lsmod` ne puissent pas diverger.
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

/** Format de kmod, relevé sur l'en-tête réel : `%-19s %8lu  %d`. */
function renderLsmod(lines: string[]): string {
  const out = ['Module                  Size  Used by'];
  for (const raw of lines) {
    const [name, size, count, usedBy] = raw.split(' ');
    const used = usedBy && usedBy !== '-,' ? ` ${usedBy.replace(/,$/, '')}` : '';
    out.push(`${name.padEnd(19)} ${size.padStart(8)}  ${count}${used}`);
  }
  return out.join('\n');
}

export const lsmodCommand: LinuxCommand = {
  name: 'lsmod',
  needsNetworkContext: true,
  usage: 'lsmod',
  manSection: 8,
  binaryPath: '/usr/sbin/lsmod',
  help: 'Show the status of modules in the Linux kernel.',
  run(ctx: LinuxCommandContext): string {
    const proc = ctx.executor.vfs.readFile('/proc/modules') ?? '';
    return renderLsmod(proc.split('\n').filter((l) => l.trim() !== ''));
  },
};

export const modinfoCommand: LinuxCommand = {
  name: 'modinfo',
  needsNetworkContext: true,
  usage: 'modinfo [-F field] modulename ...',
  manSection: 8,
  binaryPath: '/usr/sbin/modinfo',
  help: 'Show information about a Linux kernel module.',
  options: [
    { flag: '-F', aliases: ['--field'], dest: 'field', takesArg: true, argName: 'field', description: 'Print only provided FIELD' },
    { flag: '-n', aliases: ['--filename'], dest: 'filename', description: 'Print only the module filename' },
  ],
  runWithStatusSync(ctx: LinuxCommandContext, args: string[]) {
    let field: string | undefined;
    const names: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-F' || a === '--field') { field = args[++i]; continue; }
      if (a === '-n' || a === '--filename') { field = 'filename'; continue; }
      if (a.startsWith('-')) continue;
      names.push(a);
    }
    if (names.length === 0) {
      return { output: 'modinfo: ERROR: missing module or filename.', exitCode: 1 };
    }

    const table = ctx.executor.kernelModules;
    const out: string[] = [];
    let failed = false;
    for (const name of names) {
      const m = table.get(name);
      if (!m) {
        out.push(`modinfo: ERROR: Module ${name} not found.`);
        failed = true;
        continue;
      }
      const fields: Array<[string, string]> = [
        ['filename', table.filenameOf(m)],
        ['description', m.description],
        ['license', m.license],
      ];
      if (m.author) fields.push(['author', m.author]);
      fields.push(['depends', m.depends.join(',')]);
      fields.push(['name', m.name]);
      fields.push(['vermagic', `${ctx.executor.identity.kernel.release} SMP mod_unload modversions`]);
      for (const p of m.parms ?? []) fields.push(['parm', p]);

      if (field) {
        for (const [k, v] of fields) if (k === field) out.push(v);
        continue;
      }
      for (const [k, v] of fields) out.push(`${(k + ':').padEnd(16)}${v}`);
    }
    return { output: out.join('\n'), exitCode: failed ? 1 : 0 };
  },
  run(ctx: LinuxCommandContext, args: string[]): string {
    return this.runWithStatusSync!(ctx, args).output;
  },
  complete(ctx: LinuxCommandContext): string[] {
    return ctx.executor.kernelModules.list().map((m) => m.name);
  },
};
