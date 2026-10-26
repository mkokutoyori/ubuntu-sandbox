export interface NormalizeSide {
  readonly pids: Readonly<Record<string, number | null>>;
  readonly baseline: string;
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

export function normalizeNetOutput(output: string, side: NormalizeSide, command = '', loose = false): string {
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
