/**
 * PriorityCommands — nice / renice / chrt / ionice / taskset.
 *
 * These implement the "set a knob with one command, read it back with
 * another" pattern on the live process table:
 *   renice 5 -p $$   →   ps -o pid,ni,comm -p $$   shows NI=5
 *   chrt -f 50 -p P  →   chrt -p P                 shows SCHED_FIFO
 *
 * `renice` flows through `LinuxProcessManager.renice`, so every
 * priority change also publishes `linux.process.priority-changed`
 * on the bus (reactive). chrt/ionice/taskset persist their knobs on
 * the process entity (schedPolicy / ioClass / cpuAffinity) so the
 * read-back command reflects the write.
 */

import type { ProcessCmdContext } from '../LinuxProcessCommands';

export interface CmdResult {
  output: string;
  exitCode: number;
}

const USAGE = (name: string, usage: string): CmdResult => ({
  output: `${name}: ${usage}`,
  exitCode: 1,
});

function resolvePids(tokens: string[]): number[] {
  return tokens
    .flatMap(t => t.split(','))
    .map(t => Number(t))
    .filter(n => Number.isInteger(n) && n > 0);
}

// ─── nice ──────────────────────────────────────────────────────────────

/** Le code de sortie que `nice` rend quand il n'a pas pu lancer la commande. */
const NICE_USAGE_EXIT = 125;

const NICE_TRY_HELP = "Try 'nice --help' for more information.";

/** L'ajustement par defaut de `nice`, quand aucun `-n` n'est donne. */
const NICE_DEFAULT_ADJUSTMENT = 10;

function clampNice(value: number): number {
  return Math.max(-20, Math.min(19, value));
}

/**
 * `nice` est un ENFANT du shell : il s'abaisse lui-meme puis execve()
 * la commande, et ce qu'il a abaisse meurt avec elle. L'implementation
 * appliquait l'abaissement a `currentPid ?? shellPid`, donc AU SHELL des
 * qu'aucun enfant n'etait en cours — une seule commande niceee degradait
 * definitivement la session.
 *
 * L'ajustement est RELATIF a la priorite heritee : `nice -n 3 nice -n 4
 * nice` rend 7 sur une vraie machine, ce que seul un vrai enfant
 * portant sa propre priorite peut reproduire.
 */
export function cmdNice(args: string[], ctx: ProcessCmdContext): CmdResult {
  const heritee = ctx.pm.get(ctx.currentPid ?? ctx.shellPid ?? 0)?.nice ?? 0;
  if (args.length === 0) {
    return { output: String(heritee), exitCode: 0 };
  }
  let i = 0;
  let adj = NICE_DEFAULT_ADJUSTMENT;
  let donne = false;
  if (args[0] === '-n' || args[0] === '--adjustment') {
    adj = Number(args[1]);
    i = 2;
    donne = true;
  } else if (/^-n\d/.test(args[0]) || /^--adjustment=/.test(args[0])) {
    adj = Number(args[0].replace(/^(-n|--adjustment=)/, ''));
    i = 1;
    donne = true;
  } else if (/^-\d+$/.test(args[0])) {
    adj = Number(args[0]);
    i = 1;
    donne = true;
  }
  if (Number.isNaN(adj)) {
    return {
      output: `nice: invalid adjustment '${args[1] ?? args[0]}'\n${NICE_TRY_HELP}`,
      exitCode: NICE_USAGE_EXIT,
    };
  }
  const cmd = args.slice(i);
  if (cmd.length === 0) {
    return donne
      ? {
        output: `nice: a command must be given with an adjustment\n${NICE_TRY_HELP}`,
        exitCode: NICE_USAGE_EXIT,
      }
      : { output: String(heritee), exitCode: 0 };
  }
  if (!ctx.runAsChild) return { output: '', exitCode: 0 };
  return ctx.runAsChild(clampNice(heritee + adj), cmd.join(' '));
}

// ─── renice ────────────────────────────────────────────────────────────

export function cmdRenice(args: string[], ctx: ProcessCmdContext): CmdResult {
  if (args.length === 0) {
    return USAGE('renice', "usage: renice [-n] priority [-p|--pid] pid...");
  }
  let idx = 0;
  if (args[0] === '-n' || args[0] === '--priority') idx = 1;
  const prioTok = args[idx];
  const prio = Number(prioTok);
  if (prioTok === undefined || Number.isNaN(prio)) {
    return { output: `renice: invalid priority '${prioTok ?? ''}'`, exitCode: 1 };
  }
  idx++;

  const rest = args.slice(idx);
  let mode: 'pid' | 'user' = 'pid';
  const targets: string[] = [];
  for (const tok of rest) {
    if (tok === '-p' || tok === '--pid') { mode = 'pid'; continue; }
    if (tok === '-u' || tok === '--user') { mode = 'user'; continue; }
    if (tok === '-g' || tok === '--pgrp') { mode = 'pid'; continue; }
    targets.push(tok);
  }
  if (targets.length === 0) {
    return USAGE('renice', "usage: renice [-n] priority [-p|--pid] pid...");
  }

  // POSIX: only root (uid=0) may set a negative nice value, OR re-prioritise
  // a process owned by another user. Non-root callers raising the priority
  // (decreasing nice) is also rejected (EPERM).
  const callerIsRoot = ctx.currentUid === 0;
  if (!callerIsRoot && prio < 0) {
    return {
      output: `renice: failed to set priority: Permission denied`,
      exitCode: 1,
    };
  }

  const lines: string[] = [];
  let exitCode = 0;
  if (mode === 'user') {
    for (const user of targets) {
      if (!callerIsRoot && user !== ctx.currentUser) {
        lines.push(`renice: failed to set priority for user ${user}: Permission denied`);
        exitCode = 1;
        continue;
      }
      const procs = ctx.pm.list({ user });
      for (const p of procs) {
        const old = p.nice;
        ctx.pm.renice(p.pid, prio);
        lines.push(`${p.pid} (process ID) old priority ${old}, new priority ${prio}`);
      }
    }
  } else {
    for (const pid of resolvePids(targets)) {
      const p = ctx.pm.get(pid);
      if (!p) {
        lines.push(`renice: failed to set priority for ${pid} (process ID): No such process`);
        exitCode = 1;
        continue;
      }
      if (!callerIsRoot && p.user !== ctx.currentUser) {
        lines.push(`renice: failed to set priority for ${pid} (process ID): Permission denied`);
        exitCode = 1;
        continue;
      }
      const old = p.nice;
      ctx.pm.renice(pid, prio);
      lines.push(`${pid} (process ID) old priority ${old}, new priority ${prio}`);
    }
  }
  return { output: lines.join('\n'), exitCode };
}

// ─── chrt ──────────────────────────────────────────────────────────────

const SCHED_POLICIES: Record<string, string> = {
  '-f': 'SCHED_FIFO', '--fifo': 'SCHED_FIFO',
  '-r': 'SCHED_RR', '--rr': 'SCHED_RR',
  '-o': 'SCHED_OTHER', '--other': 'SCHED_OTHER',
  '-b': 'SCHED_BATCH', '--batch': 'SCHED_BATCH',
  '-i': 'SCHED_IDLE', '--idle': 'SCHED_IDLE',
};

export function cmdChrt(args: string[], ctx: ProcessCmdContext): CmdResult {
  if (args.includes('-m') || args.includes('--max')) {
    return {
      output: [
        'SCHED_OTHER min/max priority\t: 0/0',
        'SCHED_FIFO min/max priority\t: 1/99',
        'SCHED_RR min/max priority\t: 1/99',
        'SCHED_BATCH min/max priority\t: 0/0',
        'SCHED_IDLE min/max priority\t: 0/0',
      ].join('\n'),
      exitCode: 0,
    };
  }
  const pIdx = args.findIndex(a => a === '-p' || a === '--pid');
  if (pIdx < 0) return USAGE('chrt', 'usage: chrt [options] [-p [priority] pid]');
  const pid = Number(args[pIdx + 1] ?? args[pIdx + 2]);
  const p = ctx.pm.get(pid);
  if (!p) {
    return { output: `chrt: failed to get pid ${args[pIdx + 1]}'s policy: No such process`, exitCode: 1 };
  }

  const policyFlag = args.find(a => a in SCHED_POLICIES);
  if (policyFlag) {
    p.schedPolicy = SCHED_POLICIES[policyFlag];
    const rt = args.find(a => /^\d+$/.test(a));
    p.rtPriority = rt ? Number(rt) : 0;
    return { output: '', exitCode: 0 };
  }
  return {
    output: [
      `pid ${pid}'s current scheduling policy: ${p.schedPolicy ?? 'SCHED_OTHER'}`,
      `pid ${pid}'s current scheduling priority: ${p.rtPriority ?? 0}`,
    ].join('\n'),
    exitCode: 0,
  };
}

// ─── ionice ────────────────────────────────────────────────────────────

const IO_CLASSES = ['none', 'realtime', 'best-effort', 'idle'];

export function cmdIonice(args: string[], ctx: ProcessCmdContext): CmdResult {
  const pIdx = args.findIndex(a => a === '-p');
  const cIdx = args.findIndex(a => a === '-c');
  const nIdx = args.findIndex(a => a === '-n');

  if (cIdx >= 0) {
    const c = Number(args[cIdx + 1]);
    if (!Number.isInteger(c) || c < 0 || c > 3) {
      return { output: `ionice: invalid class: ${args[cIdx + 1]}`, exitCode: 1 };
    }
    if (pIdx >= 0) {
      const pid = Number(args[pIdx + 1]);
      const p = ctx.pm.get(pid);
      if (!p) return { output: `ionice: ioprio_set failed: No such process`, exitCode: 1 };
      p.ioClass = IO_CLASSES[c];
      p.ioClassData = nIdx >= 0 ? Number(args[nIdx + 1]) : 4;
    }
    return { output: '', exitCode: 0 };
  }

  if (pIdx >= 0) {
    const pid = Number(args[pIdx + 1]);
    const p = ctx.pm.get(pid);
    if (!p) return { output: `ionice: ioprio_get failed: No such process`, exitCode: 1 };
    const cls = p.ioClass ?? 'best-effort';
    return {
      output: cls === 'none' || cls === 'idle' ? cls : `${cls}: prio ${p.ioClassData ?? 4}`,
      exitCode: 0,
    };
  }
  return { output: 'best-effort: prio 4', exitCode: 0 };
}

// ─── taskset ───────────────────────────────────────────────────────────

export function cmdTaskset(args: string[], ctx: ProcessCmdContext): CmdResult {
  const list = args.some(a => a.includes('c'));
  const pIdx = args.findIndex(a => /^-p|c?p$|^-pc$/.test(a) || a === '-p' || a === '-pc' || a === '-cp');
  if (pIdx < 0) return USAGE('taskset', 'usage: taskset [options] -p [mask] pid');
  const pid = Number(args[pIdx + 1]);
  const p = ctx.pm.get(pid);
  if (!p) {
    return { output: `taskset: failed to get pid ${args[pIdx + 1]}'s affinity: No such process`, exitCode: 1 };
  }
  const cpus = p.cpuAffinity ?? [0, 1, 2, 3];
  if (list || args[pIdx].includes('c')) {
    return { output: `pid ${pid}'s current affinity list: ${cpus[0]}-${cpus[cpus.length - 1]}`, exitCode: 0 };
  }
  const mask = cpus.reduce((m, c) => m | (1 << c), 0).toString(16);
  return { output: `pid ${pid}'s current affinity mask: ${mask}`, exitCode: 0 };
}
