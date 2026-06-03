/**
 * PsCommand — modular `ps` selection / format / sort engine.
 *
 * Real `ps` is two orthogonal concerns glued together: WHICH processes
 * to show (selection) and HOW to render them (format + sort). The old
 * implementation collapsed both into two hard-coded branches, so every
 * flag other than `aux`/`-ef`/`-e` silently fell back to "current shell
 * only". This module separates the concerns:
 *
 *   parsePsArgs()  →  PsQuery        (pure argument parser)
 *   selectProcesses()               (selection predicates)
 *   COLUMN_REGISTRY                 (Strategy: one renderer per field)
 *   FORMAT_PRESETS                  (default / -f / -l / aux column sets)
 *
 * Adding a new column or a new selector is a local, additive change —
 * no existing branch needs editing (Open/Closed).
 */

import type { LinuxProcessManager, ProcessInfo } from '../LinuxProcessManager';
import { formatClock, formatCpuTime, memPercent } from '../system/ProcFormat';

/** Context describing the calling interactive shell. */
export interface PsContext {
  pm: LinuxProcessManager;
  currentUser: string;
  currentUid: number;
  /** TTY of the current shell session, e.g. "pts/0". */
  tty: string;
  /** PID of the interactive `-bash`, so `ps -p $$` resolves. */
  shellPid?: number;
}

type FormatPreset = 'default' | 'full' | 'long' | 'aux';

interface PsQuery {
  /** Show every process (-e / -A / ax / aux). */
  all: boolean;
  pids?: number[];
  ppids?: number[];
  comms?: string[];
  users?: string[];
  format: FormatPreset;
  /** Explicit -o column spec; overrides the preset when present. */
  columns?: ColumnSpec[];
  sort?: SortKey[];
  noHeader: boolean;
  forest: boolean;
  runningOnly: boolean;
  /** Terminal output produced directly by the parser (errors/version). */
  terminal?: string;
}

interface ColumnSpec {
  key: string;
  /** Custom header from `-o name=HEADER`; '' means "suppress header". */
  header?: string;
}

interface SortKey {
  key: string;
  desc: boolean;
}

// ─── Column registry (Strategy per field) ─────────────────────────────

interface Column {
  header: string;
  align: 'l' | 'r';
  width: number;
  value(p: ProcessInfo): string;
  /** Numeric projection for --sort. */
  num?(p: ProcessInfo): number;
}

const fmtClock = formatClock;
const fmtCpu = formatCpuTime;
const memPct = memPercent;

const COLUMN_REGISTRY: Record<string, Column> = {
  pid: { header: 'PID', align: 'r', width: 5, value: p => String(p.pid), num: p => p.pid },
  ppid: { header: 'PPID', align: 'r', width: 5, value: p => String(p.ppid), num: p => p.ppid },
  pgid: { header: 'PGID', align: 'r', width: 5, value: p => String(p.pgid) },
  sid: { header: 'SID', align: 'r', width: 5, value: p => String(p.sid) },
  uid: { header: 'UID', align: 'r', width: 5, value: p => String(p.uid), num: p => p.uid },
  gid: { header: 'GID', align: 'r', width: 5, value: p => String(p.gid) },
  user: { header: 'USER', align: 'l', width: 8, value: p => p.user.length > 8 ? p.user.slice(0, 7) + '+' : p.user },
  fuid: { header: 'UID', align: 'l', width: 8, value: p => p.user.length > 8 ? p.user.slice(0, 7) + '+' : p.user },
  ruser: { header: 'RUSER', align: 'l', width: 8, value: p => p.user.length > 8 ? p.user.slice(0, 7) + '+' : p.user },
  comm: { header: 'COMMAND', align: 'l', width: 0, value: p => p.comm },
  ucmd: { header: 'CMD', align: 'l', width: 0, value: p => p.comm },
  cmd: { header: 'CMD', align: 'l', width: 0, value: p => p.command },
  args: { header: 'COMMAND', align: 'l', width: 0, value: p => p.command },
  pcpu: { header: '%CPU', align: 'r', width: 4, value: () => '0.0', num: () => 0 },
  pmem: { header: '%MEM', align: 'r', width: 4, value: p => memPct(p.rss), num: p => p.rss },
  vsz: { header: 'VSZ', align: 'r', width: 7, value: p => String(p.vsize), num: p => p.vsize },
  rss: { header: 'RSS', align: 'r', width: 6, value: p => String(p.rss), num: p => p.rss },
  tty: { header: 'TTY', align: 'l', width: 8, value: p => p.tty },
  stat: { header: 'STAT', align: 'l', width: 4, value: p => p.state, },
  s: { header: 'S', align: 'l', width: 1, value: p => p.state },
  stime: { header: 'STIME', align: 'l', width: 5, value: p => fmtClock(p.startTime) },
  start: { header: 'START', align: 'l', width: 8, value: p => fmtClock(p.startTime) },
  time: { header: 'TIME', align: 'r', width: 8, value: p => fmtCpu(p.cpuTime), num: p => p.cpuTime },
  ni: { header: 'NI', align: 'r', width: 3, value: p => String(p.nice), num: p => p.nice },
  nice: { header: 'NI', align: 'r', width: 3, value: p => String(p.nice), num: p => p.nice },
  pri: { header: 'PRI', align: 'r', width: 3, value: p => String(p.priority), num: p => p.priority },
  nlwp: { header: 'NLWP', align: 'r', width: 4, value: () => '1' },
  c: { header: 'C', align: 'r', width: 2, value: () => '0' },
  f: { header: 'F', align: 'r', width: 1, value: p => (p.uid === 0 ? '4' : '0') },
  wchan: { header: 'WCHAN', align: 'l', width: 6, value: () => '-' },
  sz: { header: 'SZ', align: 'r', width: 6, value: p => String(Math.floor(p.vsize / 4)) },
  addr: { header: 'ADDR', align: 'l', width: 8, value: () => '-' },
};

/** Aliases → canonical column key. */
const COLUMN_ALIASES: Record<string, string> = {
  '%cpu': 'pcpu', cputime: 'time', '%mem': 'pmem', vsize: 'vsz', rsz: 'rss',
  command: 'args', ucomm: 'comm', tname: 'tty', tt: 'tty', state: 's',
  start_time: 'stime', lstart: 'start', priority: 'pri', euser: 'user',
  uname: 'user', thcount: 'nlwp', pgrp: 'pgid',
};

function resolveColumn(key: string): Column | null {
  const canon = COLUMN_ALIASES[key] ?? key;
  return COLUMN_REGISTRY[canon] ?? null;
}

const FORMAT_PRESETS: Record<FormatPreset, string[]> = {
  default: ['pid', 'tty', 'time', 'ucmd'],
  full: ['fuid', 'pid', 'ppid', 'c', 'stime', 'tty', 'time', 'cmd'],
  long: ['f', 's', 'uid', 'pid', 'ppid', 'c', 'pri', 'ni', 'addr', 'sz', 'wchan', 'tty', 'time', 'cmd'],
  aux: ['user', 'pid', 'pcpu', 'pmem', 'vsz', 'rss', 'tty', 'stat', 'start', 'time', 'args'],
};

// ─── Argument parsing ─────────────────────────────────────────────────

const KNOWN_LONG = new Set([
  'sort', 'pid', 'ppid', 'no-headers', 'no-heading', 'forest', 'version',
  'help', 'cols', 'columns', 'width', 'lines', 'rows',
]);

function parsePsArgs(args: string[]): PsQuery {
  const q: PsQuery = {
    all: false, format: 'default', noHeader: false, forest: false, runningOnly: false,
  };
  const explicitCols: ColumnSpec[] = [];

  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === '') continue;

    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      const name = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
      const inlineVal = eq >= 0 ? tok.slice(eq + 1) : undefined;
      if (!KNOWN_LONG.has(name)) {
        q.terminal = `ps: unrecognized option '--${name}'\nUsage:\n ps [options]\n`;
        return q;
      }
      switch (name) {
        case 'version': q.terminal = 'ps from procps-ng 3.3.17'; return q;
        case 'help': q.terminal = 'Usage:\n ps [options]\n'; return q;
        case 'no-headers': case 'no-heading': q.noHeader = true; break;
        case 'forest': q.forest = true; break;
        case 'sort': q.sort = parseSort(inlineVal ?? args[++i] ?? ''); break;
        case 'pid': pushNums(q, 'pids', inlineVal ?? args[++i] ?? ''); break;
        case 'ppid': pushNums(q, 'ppids', inlineVal ?? args[++i] ?? ''); break;
        default: break; // cols/width/lines: accept & ignore
      }
      continue;
    }

    if (tok.startsWith('-') && tok.length > 1) {
      const err = parseShortCluster(tok.slice(1), args, () => args[++i], q, explicitCols);
      if (err) { q.terminal = err; return q; }
      continue;
    }

    // Bare word: BSD-style cluster, a pid list, or a comm.
    if (/^\d[\d,\s]*$/.test(tok)) { pushNums(q, 'pids', tok); continue; }
    const err = parseBsdCluster(tok, q);
    if (err) { q.terminal = err; return q; }
  }

  if (explicitCols.length > 0) q.columns = explicitCols;
  return q;
}

function parseShortCluster(
  body: string,
  args: string[],
  next: () => string | undefined,
  q: PsQuery,
  cols: ColumnSpec[],
): string | null {
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    const rest = body.slice(j + 1);
    const takeVal = (): string => (rest ? ((j = body.length), rest) : (next() ?? ''));
    switch (c) {
      case 'e': case 'A': q.all = true; break;
      case 'a': case 'x': q.all = true; break;
      case 'f': q.format = q.format === 'long' ? 'long' : 'full'; break;
      case 'l': q.format = 'long'; break;
      case 'j': case 'y': case 'c': case 'S': case 'n': case 'w': case 'M': break;
      case 'H': q.forest = true; break;
      case 'L': case 'T': break; // thread views: list once
      case 'r': q.runningOnly = true; break;
      case 'h': q.noHeader = true; break;
      case 'o': addColumns(cols, takeVal()); q.columns = cols; break;
      case 'p': pushNums(q, 'pids', takeVal()); break;
      case 'C': (q.comms ??= []).push(...splitList(takeVal())); break;
      case 'u': case 'U': (q.users ??= []).push(...splitList(takeVal())); break;
      case 'G': case 'g': takeVal(); break; // group select: accepted, not modelled
      case 't': takeVal(); break; // tty select: accepted, not modelled
      default:
        return `ps: invalid option -- '${c}'\nUsage:\n ps [options]\n`;
    }
  }
  return null;
}

function parseBsdCluster(tok: string, q: PsQuery): string | null {
  if (tok === 'aux' || tok === 'axu' || tok === 'auxww' || tok === 'aux ww') {
    q.all = true; q.format = 'aux'; return null;
  }
  for (const c of tok) {
    switch (c) {
      case 'a': case 'x': q.all = true; break;
      case 'u': q.all = true; q.format = 'aux'; break;
      case 'e': break; // BSD 'e' = show environment; ignored
      case 'f': q.forest = true; break;
      case 'l': q.format = 'long'; break;
      case 'j': case 'y': case 'c': case 'S': case 'n': case 'w': case 'm':
      case 'H': case 'T': case 'L': case 'r': case 'h': break;
      default:
        return `ps: error: improper list\nUsage:\n ps [options]\n`;
    }
  }
  if (tok.includes('f') || tok.includes('H')) q.forest = true;
  if (tok.includes('l')) q.format = 'long';
  if (tok.includes('r')) q.runningOnly = true;
  if (tok.includes('h')) q.noHeader = true;
  return null;
}

function splitList(v: string): string[] {
  return v.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}
function pushNums(q: PsQuery, field: 'pids' | 'ppids', v: string): void {
  const nums = splitList(v).map(Number).filter(n => Number.isFinite(n));
  (q[field] ??= []).push(...nums);
}
function addColumns(cols: ColumnSpec[], spec: string): void {
  for (const part of spec.split(',').map(s => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq >= 0) cols.push({ key: part.slice(0, eq).toLowerCase(), header: part.slice(eq + 1) });
    else cols.push({ key: part.toLowerCase() });
  }
}
function parseSort(spec: string): SortKey[] {
  return spec.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const desc = s.startsWith('-');
    return { key: s.replace(/^[+-]/, ''), desc };
  });
}

// ─── Selection ────────────────────────────────────────────────────────

function commMatches(p: ProcessInfo, name: string): boolean {
  return p.comm === name || p.comm.replace(/^-/, '') === name;
}

/** Build a transient `ps` entry mirroring what real Linux shows when ps
 *  enumerates itself: max(pids)+1, ppid = shell, comm 'ps', state 'R',
 *  tty inherited from the shell. The simulator's process manager is
 *  not mutated. */
function transientPsProcess(ctx: PsContext): ProcessInfo {
  const peers = ctx.pm.list();
  const maxPid = peers.reduce((m, p) => Math.max(m, p.pid), 1);
  const now = new Date();
  return {
    pid: maxPid + 1,
    ppid: ctx.shellPid ?? 1,
    pgid: ctx.shellPid ?? 1,
    sid: ctx.shellPid ?? 1,
    uid: ctx.currentUid,
    gid: ctx.currentUid,
    user: ctx.currentUser,
    command: 'ps',
    comm: 'ps',
    args: ['ps'],
    state: 'R',
    startTime: now,
    cpuTime: 0,
    vsize: 12 * 1024,
    rss: 3 * 1024,
    tty: ctx.tty,
    nice: 0,
    priority: 20,
    cwd: '/',
    exe: '/usr/bin/ps',
  };
}

function selectProcesses(q: PsQuery, ctx: PsContext): ProcessInfo[] {
  let list = [...ctx.pm.list(), transientPsProcess(ctx)];
  const hasSelector = q.pids || q.ppids || q.comms || q.users;

  if (q.pids) list = list.filter(p => q.pids!.includes(p.pid));
  if (q.ppids) list = list.filter(p => q.ppids!.includes(p.ppid));
  if (q.comms) list = list.filter(p => q.comms!.some(n => commMatches(p, n)));
  if (q.users) list = list.filter(p => q.users!.includes(p.user));

  if (!q.all && !hasSelector) {
    list = list.filter(
      p => p.user === ctx.currentUser && (p.tty === ctx.tty || p.tty === '?'),
    );
  }
  if (q.runningOnly) list = list.filter(p => p.state === 'R');
  return list;
}

function applySort(list: ProcessInfo[], sort: SortKey[]): ProcessInfo[] {
  return [...list].sort((a, b) => {
    for (const { key, desc } of sort) {
      const col = resolveColumn(key);
      const an = col?.num ? col.num(a) : 0;
      const bn = col?.num ? col.num(b) : 0;
      if (an !== bn) return desc ? bn - an : an - bn;
    }
    return a.pid - b.pid;
  });
}

// ─── Rendering ────────────────────────────────────────────────────────

function depthOf(p: ProcessInfo, byPid: Map<number, ProcessInfo>): number {
  let d = 0;
  let cur = p;
  while (cur.ppid && byPid.has(cur.ppid) && d < 64) {
    cur = byPid.get(cur.ppid)!;
    d++;
  }
  return d;
}

/** Re-order a flat process list into DFS tree-order so `ps -e f` renders
 *  the actual parent → children → next-sibling sequence. Falls back to
 *  PID order at each depth (matching real procps). Orphans (ppid not in
 *  list, e.g. ppid=0 or 1 when init isn't shown) are seeded as roots. */
function forestOrder(list: ProcessInfo[]): ProcessInfo[] {
  const byPid = new Map(list.map((p) => [p.pid, p]));
  const childrenOf = new Map<number, ProcessInfo[]>();
  const roots: ProcessInfo[] = [];
  for (const p of list) {
    if (p.ppid && byPid.has(p.ppid)) {
      const arr = childrenOf.get(p.ppid) ?? [];
      arr.push(p);
      childrenOf.set(p.ppid, arr);
    } else {
      roots.push(p);
    }
  }
  const ordered: ProcessInfo[] = [];
  const visit = (p: ProcessInfo): void => {
    ordered.push(p);
    const kids = (childrenOf.get(p.pid) ?? []).sort((a, b) => a.pid - b.pid);
    for (const k of kids) visit(k);
  };
  roots.sort((a, b) => a.pid - b.pid);
  for (const r of roots) visit(r);
  return ordered;
}

function renderTable(list: ProcessInfo[], q: PsQuery): string {
  const specs: ColumnSpec[] =
    q.columns ?? FORMAT_PRESETS[q.format].map(key => ({ key }));
  const columns = specs.map(s => {
    const col = resolveColumn(s.key);
    return { spec: s, col };
  });

  const suppressHeader =
    q.noHeader || (q.columns ? q.columns.every(s => s.header === '') : false);

  const byPid = new Map(list.map(p => [p.pid, p]));
  const lines: string[] = [];

  if (!suppressHeader) {
    const head = columns.map(({ spec, col }, idx) => {
      const text = spec.header ?? col?.header ?? spec.key.toUpperCase();
      return padCell(text, col, idx === columns.length - 1, 'l');
    }).join(' ');
    lines.push(head.replace(/\s+$/, ''));
  }

  for (const p of list) {
    const indent = q.forest ? '  '.repeat(depthOf(p, byPid)) : '';
    const cells = columns.map(({ col, spec }, idx) => {
      let v = col ? col.value(p) : '';
      if (q.forest && ['comm', 'ucmd', 'cmd', 'args'].includes(spec.key) && indent) {
        v = `${indent}\\_ ${v}`;
      }
      return padCell(v, col, idx === columns.length - 1, col?.align ?? 'l');
    });
    lines.push(cells.join(' ').replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

function padCell(text: string, col: { width: number } | null, last: boolean, align: 'l' | 'r'): string {
  if (last || !col || col.width === 0) return text;
  return align === 'r' ? text.padStart(col.width) : text.padEnd(col.width);
}

// ─── Public entry ─────────────────────────────────────────────────────

/** Run `ps` with full selection/format/sort semantics. */
export function runPs(args: string[], ctx: PsContext): string {
  const q = parsePsArgs(args);
  if (q.terminal !== undefined) return q.terminal;

  let list = selectProcesses(q, ctx);
  if (q.forest) {
    list = forestOrder(list);
  } else if (q.sort && q.sort.length > 0) {
    list = applySort(list, q.sort);
  } else {
    list = [...list].sort((a, b) => a.pid - b.pid);
  }

  return renderTable(list, q);
}
