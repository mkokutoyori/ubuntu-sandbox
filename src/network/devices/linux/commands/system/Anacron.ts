/**
 * `anacron(8)` — le planificateur des machines qui ne tournent pas en
 * permanence.
 *
 * Ce qu'il fait, et que cron ne sait pas faire : cron rate un rendez-vous
 * si la machine est éteinte à l'heure dite, et ne le rattrape jamais.
 * anacron ne raisonne pas en heures mais en **jours écoulés** : il retient
 * dans `/var/spool/anacron/<identifiant>` la date du dernier passage, et
 * au démarrage suivant il exécute tout ce dont la période est échue.
 *
 * Le format d'`/etc/anacrontab`, relevé sur le fichier d'usine d'Ubuntu :
 *
 *     période  délai  identifiant  commande
 *     1        5      cron.daily   run-parts --report /etc/cron.daily
 *     7        10     cron.weekly  run-parts --report /etc/cron.weekly
 *     @monthly 15     cron.monthly run-parts --report /etc/cron.monthly
 *
 * Le délai est en minutes, et sert à étaler les tâches au démarrage. Il
 * est lu et rendu, mais rien ici ne diffère l'exécution : le tour de la
 * machine est à la minute, un décalage de quelques minutes n'aurait
 * aucune conséquence observable. C'est une simplification, pas un oubli.
 *
 * Transcriptions relevées sur le vrai binaire (anacron 2.3) :
 *   - `Anacron 2.3 started on 2026-08-02`
 *   - `Will run job \`essai'`
 *   - `Jobs will be executed sequentially`
 *   - `Job \`essai' started`
 *   - `Job \`essai' terminated`
 *   - `Normal exit (1 job run)`
 *   - `anacron: Invalid syntax in <fichier> on line N - skipping this line`
 *
 * Une ligne fautive est **sautée**, pas fatale, et le code de sortie
 * reste 0 : mesuré, y compris avec `-T`.
 *
 * Une réserve d'honnêteté sur la dernière ligne : le vrai binaire écrit
 * `Job \`essai' terminated (mailing output)` quand la tâche a produit
 * quelque chose, puis poste cette sortie. Ici la tâche part par le même
 * chemin que les autres commandes et sa sortie n'est pas mise au
 * courrier ; la mention entre parenthèses serait donc une promesse non
 * tenue, et la ligne s'arrête à `terminated`.
 */

import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';

const ANACRON_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-f', dest: 'force', description: 'Force execution of all jobs, ignoring timestamps' },
  { flag: '-u', dest: 'updateOnly', description: 'Update timestamps without running anything' },
  { flag: '-n', dest: 'now', description: 'Run jobs now, ignoring the delay parameters' },
  { flag: '-d', dest: 'foreground', description: 'Stay in foreground and report to standard error' },
  { flag: '-T', dest: 'test', description: 'Test the anacrontab and exit' },
  { flag: '-s', dest: 'serialize', description: 'Serialize execution of jobs' },
  { flag: '-t', dest: 'tabfile', takesArg: true, argName: 'file', description: 'Use this anacrontab instead of /etc/anacrontab' },
  { flag: '-S', dest: 'spooldir', takesArg: true, argName: 'dir', description: 'Use this spool directory for timestamps' },
];

export interface AnacronEntry {
  /** Période en jours. `@monthly` vaut « une fois par mois calendaire ». */
  readonly periodDays: number | 'monthly';
  readonly delayMinutes: number;
  readonly jobId: string;
  readonly command: string;
}

export interface AnacronTab {
  readonly env: Record<string, string>;
  readonly entries: AnacronEntry[];
  /** Numéros de ligne fautifs — le vrai les saute en le disant. */
  readonly badLines: number[];
}

/** L'identifiant d'une tâche ne peut pas contenir de `/` : c'est un nom de fichier. */
const JOB_ID = /^[A-Za-z0-9_.-]+$/;

export function parseAnacrontab(content: string): AnacronTab {
  const env: Record<string, string> = {};
  const entries: AnacronEntry[] = [];
  const badLines: number[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const assign = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (assign) { env[assign[1]] = assign[2].trim(); continue; }

    const parts = line.split(/\s+/);
    if (parts.length < 4) { badLines.push(i + 1); continue; }

    const [periodRaw, delayRaw, jobId, ...rest] = parts;
    const periodDays = periodRaw === '@monthly' ? 'monthly' as const
      : periodRaw === '@daily' ? 1
      : periodRaw === '@weekly' ? 7
      : periodRaw === '@annually' || periodRaw === '@yearly' ? 365
      : Number(periodRaw);
    const delayMinutes = Number(delayRaw);

    if (periodDays !== 'monthly' && (!Number.isInteger(periodDays) || periodDays <= 0)) { badLines.push(i + 1); continue; }
    if (!Number.isInteger(delayMinutes) || delayMinutes < 0) { badLines.push(i + 1); continue; }
    if (!JOB_ID.test(jobId)) { badLines.push(i + 1); continue; }

    entries.push({ periodDays, delayMinutes, jobId, command: rest.join(' ') });
  }
  return { env, entries, badLines };
}

/** L'horodatage tel qu'anacron l'écrit : `YYYYMMDD`, sans séparateur. */
export function anacronStamp(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function parseStamp(text: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(text.trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * L'échéance : la période est-elle écoulée depuis le dernier passage ?
 * Sans horodatage, la tâche est due — c'est ce qui la fait partir au
 * tout premier démarrage.
 */
export function jobIsDue(entry: AnacronEntry, last: Date | null, now: Date): boolean {
  if (last === null) return true;
  if (entry.periodDays === 'monthly') {
    return now.getFullYear() !== last.getFullYear() || now.getMonth() !== last.getMonth();
  }
  const jours = Math.floor((startOfDay(now).getTime() - startOfDay(last).getTime()) / 86_400_000);
  return jours >= entry.periodDays;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export const ANACRON_DEFAULT_TAB = '/etc/anacrontab';
export const ANACRON_DEFAULT_SPOOL = '/var/spool/anacron';

export const anacronCommand: LinuxCommand = {
  name: 'anacron',
  package: 'anacron',
  needsNetworkContext: true,
  usage: 'anacron [-fudnT] [-s] [-t anacrontab] [-S spooldir] [job] ...',
  options: ANACRON_OPTIONS,
  manSection: 8,
  help: 'Runs commands periodically, catching up on the periods the machine spent switched off.',
  runWithStatusSync: (ctx, args) => {
    const vfs = ctx.executor.vfs;
    const flag = (f: string): boolean => args.includes(f);
    const valeur = (f: string): string | null => {
      const i = args.indexOf(f);
      return i >= 0 && args[i + 1] ? args[i + 1] : null;
    };
    const tabPath = valeur('-t') ?? ANACRON_DEFAULT_TAB;
    const spoolDir = valeur('-S') ?? ANACRON_DEFAULT_SPOOL;
    const nommees = args.filter((a, i) =>
      !a.startsWith('-') && args[i - 1] !== '-t' && args[i - 1] !== '-S');

    const content = vfs.readFile(tabPath);
    if (content === null) {
      return { output: `anacron: Can't open ${tabPath}: No such file or directory`, exitCode: 1 };
    }

    const tab = parseAnacrontab(content);
    const out: string[] = [];
    for (const n of tab.badLines) {
      out.push(`anacron: Invalid syntax in ${tabPath} on line ${n} - skipping this line`);
    }
    // `-T` valide et s'arrête là. Le vrai sort en 0 même après avoir
    // signalé des lignes fautives : elles sont sautées, pas fatales.
    if (flag('-T')) return { output: out.join('\n'), exitCode: 0 };

    const now = ctx.executor.simulatedDate();
    const bavard = flag('-d');
    if (bavard) out.push(`Anacron 2.3 started on ${now.getFullYear()}-`
      + `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`);

    const retenues = tab.entries.filter((e) => nommees.length === 0 || nommees.includes(e.jobId));
    const stamp = anacronStamp(now);
    let lancees = 0;

    // `-u` réécrit les horodatages sans rien exécuter : la façon
    // documentée de dire « considère tout comme fait ».
    if (flag('-u')) {
      for (const e of retenues) ecrireStamp(ctx, spoolDir, e.jobId, stamp);
      return { output: out.join('\n'), exitCode: 0 };
    }

    const dues = retenues.filter((e) => flag('-f')
      || jobIsDue(e, parseStamp(vfs.readFile(`${spoolDir}/${e.jobId}`) ?? ''), now));

    if (bavard) {
      for (const e of dues) out.push(`Will run job \`${e.jobId}'`);
      if (dues.length > 0) out.push('Jobs will be executed sequentially');
    }

    for (const e of dues) {
      if (bavard) out.push(`Job \`${e.jobId}' started`);
      try { ctx.executor.execute(e.command); } catch { void 0; }
      ecrireStamp(ctx, spoolDir, e.jobId, stamp);
      lancees++;
      if (bavard) out.push(`Job \`${e.jobId}' terminated`);
    }

    if (bavard) {
      out.push(`Normal exit (${lancees} ${lancees === 1 ? 'job' : 'jobs'} run)`);
    }
    return { output: out.join('\n'), exitCode: 0 };
  },
  run: (ctx, args) => (anacronCommand.runWithStatusSync!(ctx, args)).output,
};

function ecrireStamp(
  ctx: Parameters<NonNullable<LinuxCommand['runWithStatusSync']>>[0],
  spoolDir: string, jobId: string, stamp: string,
): void {
  ctx.executor.vfs.mkdirp(spoolDir, 0o755, 0, 0);
  ctx.executor.vfs.writeFile(`${spoolDir}/${jobId}`, `${stamp}\n`, 0, 0, 0o077);
}
