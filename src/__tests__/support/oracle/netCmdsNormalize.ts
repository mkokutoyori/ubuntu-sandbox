export interface NormalizeSide {
  readonly pids: Readonly<Record<string, number | null>>;
  readonly baseline: string;
  readonly shellPid?: number;
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
    result.push(lines[index++]);
    const header = index < lines.length ? lines[index++] : '';
    result.push(header);
    const rows: string[] = [];
    while (index < lines.length && !lines[index].startsWith('Active ')) rows.push(blankInodeColumn(lines[index++], header));
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

export function normalizeNetOutput(output: string, side: NormalizeSide, command = '', loose = false): string {
  if (/^netstat\b/.test(command)) return normalizeNetstat(output, side);
  if (/\bfuser\b/.test(command)) return normalizeFuser(output, side, command);
  const names = pidNamesOf(side);
  let text = relativeSummary(output, side.baseline)
    .replace(/pid=(\d+)/g, (whole, pid: string) => (names.has(Number(pid)) ? `pid=<${names.get(Number(pid))}>` : whole))
    .replace(/ino:\d+ sk:[0-9a-f]+/g, 'ino:# sk:#')
    .replace(/timer:\(([a-z]+),[^)]*\)/g, 'timer:($1,#)')
    .replace(/cgroup:\S+/g, 'cgroup:#')
    .replace(/\btb(2626560|3939840)\b/g, 'tb<autotuned>')
    .replace(/\b(bbr|reno|cubic)\b/g, '<cc>');
  let lines = text.split('\n').map((line) => line.replace(/\s+$/, ''));
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
