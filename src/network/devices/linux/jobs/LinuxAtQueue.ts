/**
 * LinuxAtQueue — le spool des tâches différées d'`at`, et les commandes
 * qui le lisent.
 *
 * `at` met une commande de côté pour plus tard ; `atd` est le démon qui
 * exécute celles dont l'heure est venue. Ce module modélise le spool
 * (`/var/spool/cron/atjobs`) : chaque tâche porte ce qu'une ligne d'`atq`
 * montre — identifiant, heure, lettre de file, propriétaire.
 *
 * Les tâches partent pour de bon : `dueJobs()` est ce que le tour d'une
 * minute de la machine interroge. Jusqu'ici le spool n'était qu'un
 * registre — une tâche `at` y entrait et n'en sortait jamais, ce qui
 * revenait à écrire un planificateur qui ne planifie rien.
 */

import { formatCtime } from '../time/ctime';

/** Une tâche en attente. */
export interface AtJob {
  readonly id: number;
  readonly runAt: Date;
  readonly command: string;
  readonly user: string;
  /** Lettre de file — `a` pour `at`, `b` pour `batch` (plus bas = plus prioritaire). */
  readonly queue: string;
}

export class LinuxAtQueue {
  private readonly jobs = new Map<number, AtJob>();
  private nextId = 1;

  /** Met une tâche au spool et rend la fiche qui lui a été attribuée. */
  enqueue(command: string, user: string, runAt: Date, queue = 'a'): AtJob {
    const job: AtJob = { id: this.nextId++, runAt, command, user, queue };
    this.jobs.set(job.id, job);
    return job;
  }

  /** Toutes les tâches en attente, dans l'ordre des heures. */
  list(): AtJob[] {
    return [...this.jobs.values()].sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
  }

  get(id: number): AtJob | undefined {
    return this.jobs.get(id);
  }

  /** Retire une tâche par identifiant. Vrai si elle existait. */
  remove(id: number): boolean {
    return this.jobs.delete(id);
  }

  /**
   * Les tâches dont l'heure est passée, retirées du spool au passage —
   * `at` est à usage unique, une tâche exécutée ne revient pas.
   */
  dueJobs(now: Date): AtJob[] {
    const due = this.list().filter((j) => j.runAt.getTime() <= now.getTime());
    for (const j of due) this.jobs.delete(j.id);
    return due;
  }
}

/**
 * Le diagnostic quand `atd` ne tourne pas. Relevé sur le vrai : le
 * chemin est `/run/atd.pid` sur un Ubuntu courant, et — c'est le point
 * qui comptait — **la tâche est tout de même mise au spool**. `at` ne
 * sait pas prévenir le démon, il le dit, et s'arrête là ; il ne refuse
 * pas. Le simulateur refusait, ce qui faisait disparaître la tâche.
 */
const ATD_DOWN = "Can't open /run/atd.pid to signal atd. No atd running?";

/** Ce que le vrai `at` imprime avant tout le reste. */
const AT_SHELL_WARNING = 'warning: commands will be executed using /bin/sh';

/**
 * Analyse une spécification d'heure d'`at`. Reconnaît `now`,
 * `now + N unité`, `HH:MM`, `midnight`, `noon` et `teatime` (16h, la
 * plaisanterie que le vrai `at` implémente réellement).
 *
 * Ce qu'il ne reconnaît pas n'est pas ramené silencieusement à
 * maintenant : le vrai répond `Garbled time` et ne met rien au spool.
 */
export function parseAtTime(spec: string, base: Date = new Date()): Date | null {
  const text = spec.trim().toLowerCase();
  if (text === '' || text === 'now') return new Date(base);

  const rel = text.match(/^now\s*\+\s*(\d+)\s*(minute|minutes|hour|hours|day|days|week|weeks)$/);
  if (rel) {
    const n = Number(rel[1]);
    const unitMs =
      rel[2].startsWith('minute') ? 60_000 :
      rel[2].startsWith('hour') ? 3_600_000 :
      rel[2].startsWith('week') ? 7 * 86_400_000 : 86_400_000;
    return new Date(base.getTime() + n * unitMs);
  }

  const nomme: Record<string, [number, number]> = {
    midnight: [0, 0], noon: [12, 0], teatime: [16, 0],
  };
  const named = nomme[text];
  if (named) return prochainePassage(base, named[0], named[1]);

  const hhmm = text.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmm) return prochainePassage(base, Number(hhmm[1]), Number(hhmm[2]));

  const ampm = text.match(/^(\d{1,2})\s*(am|pm)$/);
  if (ampm) {
    let h = Number(ampm[1]) % 12;
    if (ampm[2] === 'pm') h += 12;
    return prochainePassage(base, h, 0);
  }

  return null;
}

/** L'heure dite, aujourd'hui si elle est à venir, demain sinon. */
function prochainePassage(base: Date, heure: number, minute: number): Date {
  const d = new Date(base);
  d.setHours(heure, minute, 0, 0);
  if (d.getTime() <= base.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/** Une ligne d'`atq` : identifiant, heure `ctime`, file, propriétaire. */
function ligneAtq(j: AtJob): string {
  return `${j.id}\t${formatCtime(j.runAt)} ${j.queue} ${j.user}`;
}

export interface AtResult {
  readonly output: string;
  readonly exitCode: number;
}

/**
 * `at` — met au spool la commande lue sur l'entrée standard.
 * `at -l` est un alias d'`atq`, et `at -d` un alias d'`atrm` : le vrai
 * binaire est le même, seul le nom d'appel change.
 */
export function cmdAt(
  queue: LinuxAtQueue,
  args: string[],
  stdin: string,
  user: string,
  atdRunning: boolean,
  now: Date = new Date(),
  file: 'a' | 'b' = 'a',
): AtResult {
  if (args.includes('-l')) return cmdAtq(queue);
  if (args.includes('-d') || args.includes('-r')) {
    return cmdAtrm(queue, args.filter((a) => !a.startsWith('-')));
  }
  if (args.includes('-c')) {
    const id = Number(args[args.indexOf('-c') + 1]);
    const job = queue.get(id);
    if (!job) return { output: `Cannot find jobid ${id}`, exitCode: 1 };
    return { output: job.command, exitCode: 0 };
  }

  const command = stdin.trim();

  // `batch` ne prend pas d'heure : sa file part dès que la charge le
  // permet, ce qui ici veut dire au prochain tour.
  const timeSpec = file === 'b' ? 'now' : args.filter((a) => !a.startsWith('-')).join(' ');
  const runAt = parseAtTime(timeSpec, now);
  if (runAt === null) return { output: 'Garbled time', exitCode: 1 };

  if (!command) return { output: 'at: no command to schedule', exitCode: 1 };

  const job = queue.enqueue(command, user, runAt, file);
  const lines = [AT_SHELL_WARNING, `job ${job.id} at ${formatCtime(runAt)}`];
  if (!atdRunning) lines.push(ATD_DOWN);
  return { output: lines.join('\n'), exitCode: 0 };
}

/** `atq` — liste les tâches en attente. */
export function cmdAtq(queue: LinuxAtQueue): AtResult {
  return { output: queue.list().map(ligneAtq).join('\n'), exitCode: 0 };
}

/** `atrm` — retire une ou plusieurs tâches par identifiant. */
export function cmdAtrm(queue: LinuxAtQueue, args: string[]): AtResult {
  const errors: string[] = [];
  for (const arg of args) {
    const id = parseInt(arg, 10);
    if (Number.isNaN(id)) continue;
    if (!queue.remove(id)) errors.push(`Cannot find jobid ${id}`);
  }
  return { output: errors.join('\n'), exitCode: errors.length > 0 ? 1 : 0 };
}
