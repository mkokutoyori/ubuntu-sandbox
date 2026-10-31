import { isPsInvocation, normalizePs } from './netCmdsNormalizePs';

export interface NormalizeSide {
  readonly pids: Readonly<Record<string, number | null>>;
  readonly baseline: string;
  readonly shellPid?: number;
  readonly visible?: readonly number[];
  readonly initPid?: number;
}

const NETLINK_ERROR = 'RTNETLINK answers: Invalid argument';
const HEADER = /^(Netid|State|Recv-Q)\s/;

interface Summary {
  readonly tcp: number;
  readonly closed: number;
}

function summaryOf(text: string): Summary | null {
  const tcp = /^TCP:\s+(\d+) \(estab \d+, closed (\d+),/m.exec(text);
  return tcp ? { tcp: Number(tcp[1]), closed: Number(tcp[2]) } : null;
}

function relativeSummary(text: string, baseline: string): string {
  const base = summaryOf(baseline);
  if (base === null) return text;
  return text
    .replace(/^Total: \d+/m, 'Total: #')
    .replace(/^TCP:(\s+)(\d+) \(estab (\d+), closed (\d+),/m, (_, gap: string, n: string, estab: string, closed: string) => `TCP:${gap}+${Number(n) - base.tcp} (estab ${estab}, closed +${Number(closed) - base.closed},`);
}

function pidNamesOf(side: NormalizeSide): ReadonlyMap<number, string> {
  const names = new Map<number, string>();
  for (const [name, pid] of Object.entries(side.pids)) if (pid !== null) names.set(pid, name);
  return names;
}

function recordsOf(lines: readonly string[]): string[] {
  const records: string[] = [];
  for (const line of lines) {
    if (/^\s/.test(line) && records.length > 0) records[records.length - 1] += `\n${line}`;
    else records.push(line);
  }
  return records;
}

export function looksLikeNetlinkRun(output: string): boolean {
  return output.includes(NETLINK_ERROR) || /^nl\s/m.test(output);
}

function blankInodeColumn(row: string, header: string): string {
  const column = Math.max(header.indexOf('Inode'), header.indexOf('I-Node'));
  if (column < 0 || row.length <= column) return row;
  const field = /^\d+\s*/.exec(row.slice(column));
  return field === null ? row : (row.slice(0, column) + '#' + row.slice(column + field[0].length)).replace(/\s+$/, '');
}

function normalizeNetstat(output: string, side: NormalizeSide): string {
  const names = pidNamesOf(side);
  const lines = output.split('\n').map((line) => line.replace(/\s+$/, '')
    .replace(/(\s)(\d+)\/([\w.-]+)$/, (whole, gap: string, pid: string, program: string) => (names.has(Number(pid)) ? `${gap}<${names.get(Number(pid))}>/${program}` : whole))
    .replace(/\((\d+\.\d+)\//g, '(#/'));
  const result: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].startsWith('Active ')) {
      result.push(lines[index++]);
      continue;
    }
    const title = lines[index++];
    result.push(title);
    const header = index < lines.length ? lines[index++] : '';
    const unix = title.startsWith('Active UNIX');
    result.push(unix ? header.replace(/\s+/g, ' ') : header);
    const rows: string[] = [];
    while (index < lines.length && !lines[index].startsWith('Active ')) {
      const raw = lines[index++];
      rows.push(unix
        ? blankInodeColumn(raw.replace(/(\s)(\d+)\/([\w.-]+)(?=\s|$)/, (whole, gap: string, pid: string, program: string) => (names.has(Number(pid)) ? `${gap}<${names.get(Number(pid))}>/${program}` : whole)), header).replace(/\s+/g, ' ').replace(/\s+$/, '')
        : blankInodeColumn(raw, header));
    }
    result.push(...rows.sort());
  }
  return result.join('\n').replace(/\n+$/, '');
}

const FUSER_ACCESS_ROW = /^(.*?)( *)(\d+)( [Ff.][r.][c.][e.][m.] .*)$/;
const FUSER_NAME_LINE = /^(\S+:)((?: +\d+[rcemF]*(?:\([^)]*\))?)+)$/;
const FUSER_TOKEN = /( +)(\d+)([rcemF]*)(\([^)]*\))?/g;

const FUSER_PID_WIDTH = 6;

function normalizeFuser(output: string, side: NormalizeSide, command: string): string {
  const names = pidNamesOf(side);
  const filtering = /\bfuser\b[^;|&]*\s-[a-zA-Z]*[mc]/.test(command);
  const label = (pid: number): string => (names.get(pid) ?? (pid === side.shellPid ? 'shell' : '?'));
  const lines: string[] = [];
  for (const line of output.split('\n').map((text) => text.replace(/\s+$/, ''))) {
    const row = FUSER_ACCESS_ROW.exec(line);
    if (row !== null) {
      const name = label(Number(row[3]));
      if (name === '?' && filtering) continue;
      const cell = `<${name}>`.padStart(row[2].length + row[3].length);
      lines.push(name === 'shell' ? `${row[1].replace(/\broot\b|\buser\b/, '<user>')}${cell}${row[4].replace(/(\S+)$/, '<shell>')}` : `${row[1]}${cell}${row[4]}`);
      continue;
    }
    const named = FUSER_NAME_LINE.exec(line);
    if (named === null) {
      lines.push(line);
      continue;
    }
    let carried = 0;
    const tokens = named[2].replace(FUSER_TOKEN, (whole, spaces: string, digits: string, letters: string, user?: string) => {
      const extra = Math.max(0, spaces.length + digits.length - FUSER_PID_WIDTH);
      const name = label(Number(digits));
      if (name === '?' && filtering) {
        carried += extra;
        return '';
      }
      const cell = `<${name}>`.padStart(FUSER_PID_WIDTH + extra + carried);
      carried = 0;
      return `${cell}${letters}${name === 'shell' && user !== undefined ? '(<user>)' : user ?? ''}`;
    });
    lines.push(`${named[1]}${tokens}`);
  }
  return lines.join('\n').replace(/\n+$/, '');
}

const UNIX_SS_COMMAND = /^ss\b[^|;]*(\s-[a-zA-Z]*x|--unix|-f\s+unix|-A\s+\S*unix)/;
const SS_LEADING_COLUMNS = ['Netid', 'State', 'Recv-Q', 'Send-Q'];

function maskKernelIdentity(text: string): string {
  return text
    .replace(/^\/tmp\/[^\s:]+\.sh: line \d+: /gm, '<shell>: ')
    .replace(/^-?(?:bash|sh): (?:line \d+: )?/gm, '<shell>: ')
    .replace(/socket:\[\d+\]/g, 'socket:[#]')
    .replace(/^l[r-][w-]x------ (\S+ \S+) 0 -> (\/dev\/null|\/dev\/pts\/\d+)$/gm, 'l??x------ $1 0 -> <stdin>')
    .replace(/\/tmp\/nc-[A-Za-z0-9]{6}\//g, '/tmp/nc-XXXXXX/')
    .replace(/(sockets: used \d+\nTCP: inuse \d+ orphan \d+ tw \d+ )alloc \d+/, '$1alloc #')
    .replace(/ino:\d+ dev:0\/\d+/g, 'ino:# dev:0/#');
}

function relabelSsUnixRows(lines: readonly string[], unixCommand: boolean): string[] {
  const headerLine = lines.length > 0 && /^(Netid|State|Recv-Q)\s/.test(lines[0]) ? lines[0] : null;
  const body = headerLine === null ? lines : lines.slice(1);
  const headerColumns = headerLine === null ? [] : headerLine.split(/\s+/);
  const lead = headerLine === null ? SS_LEADING_COLUMNS.length : SS_LEADING_COLUMNS.filter((name) => headerColumns.includes(name)).length;
  const hasNetid = headerColumns.includes('Netid') || headerLine === null;
  const tokensOf = body.filter((line) => line.trim() !== '').map((line) => line.trim().split(/\s+/));
  const isUnix = (tokens: readonly string[]): boolean => (hasNetid ? /^u_(str|dgr|seq)$/.test(tokens[0]) : unixCommand);
  const rows = tokensOf.filter(isUnix);
  const others = tokensOf.filter((tokens) => !isUnix(tokens)).map((tokens) => tokens.join(' '));
  const maskedOf = (tokens: readonly string[]): string => tokens.map((token, index) => (index === lead + 1 || index === lead + 3 ? '#' : token)).join(' ');
  const ordered = [...rows].sort((a, b) => (maskedOf(a) < maskedOf(b) ? -1 : maskedOf(a) > maskedOf(b) ? 1 : 0));
  const labels = new Map<string, string>();
  const labelOf = (inode: string): string => {
    if (inode === '0') return '0';
    let label = labels.get(inode);
    if (label === undefined) {
      label = `i${labels.size + 1}`;
      labels.set(inode, label);
    }
    return label;
  };
  for (const tokens of ordered) {
    if (tokens.length > lead + 3) {
      labelOf(tokens[lead + 1]);
      labelOf(tokens[lead + 3]);
    }
  }
  const rendered = ordered.map((tokens) => {
    const out = [...tokens];
    if (out.length > lead + 3) {
      out[lead + 1] = labelOf(tokens[lead + 1]);
      out[lead + 3] = labelOf(tokens[lead + 3]);
    }
    let afterPeers = false;
    return out.map((token, index) => {
      if (index <= lead + 3) return token;
      if (token === 'peers:') afterPeers = true;
      else if (afterPeers && /^\d+$/.test(token)) return labels.get(token) ?? '#';
      return token;
    }).join(' ');
  });
  return [...(headerLine === null ? [] : [headerColumns.join(' ')]), ...[...rendered, ...others].sort()];
}

function normalizeProcNetUnix(lines: readonly string[]): string[] {
  const header = lines.filter((line) => /^Num\s+RefCount/.test(line)).map((line) => line.trim().split(/\s+/).join(' '));
  const rows = lines.filter((line) => /^[0-9a-f]{16}:/.test(line)).map((line) => {
    const tokens = line.trim().split(/\s+/);
    tokens[0] = '#:';
    tokens[6] = '#';
    return tokens.join(' ');
  }).sort();
  const others = lines.filter((line) => !/^Num\s+RefCount/.test(line) && !/^[0-9a-f]{16}:/.test(line) && line !== '');
  return [...header, ...rows, ...others];
}

export function normalizeNetOutput(output: string, side: NormalizeSide, typedCommand = '', loose = false): string {
  const command = typedCommand.replace(/^sudo\s+(-u\s+\S+\s+)?/, '');
  const plain = maskKernelIdentity(output);
  if (isPsInvocation(command)) return normalizePs(plain, side, pidNamesOf(side), command);
  if (/^netstat\b/.test(command)) return normalizeNetstat(plain, side);
  if (/\bfuser\b/.test(command)) return normalizeFuser(plain, side, command);
  if (/\/proc\/net\/unix/.test(command) && !/\bgrep -c\b/.test(command)) {
    return normalizeProcNetUnix(plain.split('\n').map((line) => line.replace(/\s+$/, ''))).join('\n').replace(/\n+$/, '');
  }
  const names = pidNamesOf(side);
  let text = relativeSummary(plain, side.baseline)
    .replace(/pid=(\d+)/g, (whole, pid: string) => (names.has(Number(pid)) ? `pid=<${names.get(Number(pid))}>` : whole))
    .replace(/tid=(\d+)/g, (whole, pid: string) => (names.has(Number(pid)) ? `tid=<${names.get(Number(pid))}>` : whole))
    .replace(/ino:\d+ sk:[0-9a-f]+/g, 'ino:# sk:#')
    .replace(/timer:\(([a-z]+),[^)]*\)/g, 'timer:($1,#)')
    .replace(/cgroup:\S+/g, 'cgroup:#')
    .replace(/\btb(2626560|3939840)\b/g, 'tb<autotuned>')
    .replace(/\b(bbr|reno|cubic)\b/g, '<cc>');
  let lines = text.split('\n').map((line) => line.replace(/\s+$/, ''));
  const unixCommand = UNIX_SS_COMMAND.test(command);
  if (unixCommand || lines.some((line) => /^u_(str|dgr|seq)\s/.test(line.trim()))) {
    return relabelSsUnixRows(lines.filter((line) => line !== NETLINK_ERROR && !/^nl\s/.test(line)), unixCommand).join('\n').replace(/\n+$/, '');
  }
  if (loose) lines = lines.filter((line) => line !== NETLINK_ERROR && !/^nl\s/.test(line));
  if (loose || text.includes('cgroup:#')) lines = lines.map((line) => line.replace(/\s+/g, ' '));
  const header = lines.length > 0 && HEADER.test(lines[0]) ? [lines[0]] : [];
  const tabular = header.length > 0 || /\s-[a-zA-Z0-9]*H/.test(command);
  if (!tabular) return lines.join('\n').replace(/\n+$/, '');
  const rest = recordsOf(lines.slice(header.length));
  const body = rest.filter((record) => record !== '');
  const trailing = rest.length - body.length;
  text = [...header, ...body.sort(), ...Array<string>(trailing).fill('')].join('\n');
  return text.replace(/\n+$/, '');
}
